// The one executor of an update to a running site: self-update, `update` and
// the supervisor are each a plan for it. It returns what happened rather than
// printing it. Attempting service startup is the recovery boundary: before it
// a failure puts the files back and resumes the paused writers; after it the
// services are stopped and the data left as it is, never loaded over
// (docs/architecture.md#recovery).
import { relative } from 'node:path';
import { takeBackup } from './backup.ts';
import { upAndWait } from './compose.ts';
import { describeError } from './errors.ts';
import type { Io } from './io.ts';
import type { Metadata } from './meta.ts';
import { runningServices, Snapshot, stopServices } from './recovery.ts';
import { heading, ok } from './report.ts';
import { UPDATE_DIR, type SiteFacts } from './site.ts';
import { verifySite } from './verify.ts';
import { WriterPause } from './writers.ts';

export interface UpdatePlan {
    readonly io: Io;
    readonly site: SiteFacts;
    readonly metadata: Metadata;
    /** What is being updated to, as in "Stopping Ghost 6.68.0". */
    readonly to: string;
    /** Every path, relative to the site, the update may write or remove. */
    readonly paths: string[];
    /** What the snapshot holds, for the operator. */
    readonly kept: string;
    /** Said once the update has failed, before recovery starts. */
    readonly failing: string;
    /** Writes the update, once the site is backed up. Prints its own heading. */
    write(): Promise<void>;
    /** Pulls what startup needs; after this, startup is attempted. */
    pull(): Promise<void>;
    /** Records the update once the site has started and verified. */
    record?(): void;
    /**
     * The files once startup was attempted and failed. `restore`: put back,
     * because the update changed nothing the data depends on (the stack's
     * files). `keep`: left as the update wrote them, because the data may now
     * be the target's (Ghost's migrations), and switching back does not undo that.
     */
    readonly afterStartup: 'restore' | 'keep';
    /**
     * Services the update neither starts, stops nor recreates: the supervisor
     * running it. Empty for a host command.
     */
    readonly except?: readonly string[];
    /**
     * Told each stage before its side effects begin, and the backup once it
     * exists, so the supervisor can record where a job stopped
     * (docs/upgrade-supervisor.md#supervisor-running-a-job).
     */
    onStage?(stage: UpdateStage): void;
    onBackup?(path: string): void;
    /**
     * Whether to take a consistent backup first. Without one, nothing is
     * paused: the site keeps running until startup recreates it, and recovery
     * before startup still has the snapshot. Default: true.
     */
    readonly backup?: boolean;
}

/**
 * `configuring`: writing the new configuration, which may name the target
 * before anything has started it.
 */
export type UpdateStage = 'backing-up' | 'configuring' | 'restarting' | 'verifying' | 'restoring';

export type UpdateOutcome =
    /** `backup` is null when the update was asked to take none. */
    | { readonly state: 'done'; readonly backup: string | null }
    /** Failed before startup; the files are back and the paused writers running again. */
    | {
          readonly state: 'restored';
          readonly error: unknown;
          readonly backup: string | null;
          readonly resumed: readonly string[];
      }
    | {
          readonly state: 'needs-operator';
          readonly error: unknown;
          readonly backup: string | null;
          /** Startup was attempted: the data may have changed since the backup. */
          readonly servicesChanged: boolean;
          /** The files are as they were before the update. */
          readonly filesBack: boolean;
          /** What recovery itself could not do. */
          readonly problems: readonly string[];
          /** Observed after recovery; null when Compose could not say. */
          readonly running: string[] | null;
          /** Where the files as they were are kept. */
          readonly snapshot: string;
      };

/** The update, with the site lock held and nothing left from an earlier one in UPDATE_DIR. */
export async function runUpdate(plan: UpdatePlan): Promise<UpdateOutcome> {
    const { io, site } = plan;
    const dir = site.dir;

    heading(io, 'Keeping the current files');
    const snapshot = new Snapshot(dir, plan.paths);
    snapshot.take();
    ok(io, UPDATE_DIR, plan.kept);

    // Owned by the update, not the backup: the writers stay stopped from
    // before the backup until startup is attempted, or the site is put back.
    const pause = new WriterPause(io, dir, 'the update');
    let servicesChanged = false;
    let backup: string | null = null;
    const except = plan.except ?? [];
    try {
        if (plan.backup ?? true) {
            plan.onStage?.('backing-up');
            heading(io, 'Backing up the site');
            backup = await takeBackup({
                io,
                site,
                metadata: plan.metadata,
                consistent: true,
                pause,
            });
            plan.onBackup?.(backup);
            ok(io, 'backup', `${relative(dir, backup)}, checked`);
        }

        plan.onStage?.('configuring');
        await plan.write();

        heading(io, 'Starting the services');
        await plan.pull();

        plan.onStage?.('restarting');
        // Set before attempting up: even a failed start may migrate data or accept writes.
        servicesChanged = true;
        pause.end();
        await upAndWait(
            io,
            dir,
            'Starting the services and waiting for them to be healthy',
            '',
            except,
        );
        ok(io, 'services', 'healthy, by their own health checks');

        plan.onStage?.('verifying');
        await verifySite(io, dir);
        plan.record?.();
    } catch (error) {
        io.stderr(`\n${describeError(error)}\n`);
        io.stderr(`\n${plan.failing}\n`);
        plan.onStage?.('restoring');
        return recover({
            io,
            dir,
            snapshot,
            pause,
            backup,
            servicesChanged,
            error,
            stopping: `Stopping ${plan.to}`,
            afterStartup: plan.afterStartup,
            except,
        });
    }
    snapshot.remove();
    return { state: 'done', backup };
}

/** Where a failed change to a running site stands, for recover(). */
export interface Failure {
    readonly io: Io;
    readonly dir: string;
    readonly snapshot: Snapshot;
    readonly pause: WriterPause;
    readonly backup: string | null;
    /** Startup was attempted. */
    readonly servicesChanged: boolean;
    readonly error: unknown;
    /** The spinner's words for stopping the services, as in "Stopping Ghost 6.68.0". */
    readonly stopping: string;
    readonly afterStartup: UpdatePlan['afterStartup'];
    readonly except?: readonly string[];
}

/**
 * What is safe after a failure, for every change to a running site: updates
 * and the released-main migration alike. Prints nothing of its own beyond the
 * steps it takes; the caller says what the outcome means.
 */
export async function recover(
    failure: Failure,
): Promise<Exclude<UpdateOutcome, { state: 'done' }>> {
    const { io, dir, snapshot, pause, backup, servicesChanged, error } = failure;
    const problems: string[] = [];
    if (servicesChanged) {
        const stopped = await stopServices(io, dir, failure.stopping, failure.except);
        if (stopped.error !== null) {
            problems.push(`the services could not be stopped: ${stopped.error}`);
        }
    }
    const putBack = !servicesChanged || failure.afterStartup === 'restore';
    let filesBack = false;
    if (problems.length === 0 && putBack) {
        try {
            snapshot.restore();
            filesBack = true;
        } catch (restoreError) {
            problems.push(`the files could not be put back: ${(restoreError as Error).message}`);
        }
    }
    // Stopped for the update and never changed: started again as they were,
    // on the files as they were. Left stopped when those are not back.
    const resumed = [...pause.paused];
    if (problems.length === 0 && !servicesChanged) {
        try {
            await pause.resume();
        } catch (resumeError) {
            problems.push((resumeError as Error).message);
        }
    }

    if (servicesChanged || problems.length > 0) {
        return {
            state: 'needs-operator',
            error,
            backup,
            servicesChanged,
            filesBack,
            problems,
            running: await runningServices(io, dir),
            snapshot: snapshot.root,
        };
    }
    snapshot.remove();
    return { state: 'restored', error, backup, resumed };
}
