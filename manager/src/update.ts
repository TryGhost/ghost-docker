// The one executor of an update to a running site: self-update and `update`
// (Ghost) are each a plan for it, and the supervisor will be another caller.
// It returns what happened rather than printing it, so each caller says it in
// its own words and the supervisor can record it as a job's outcome.
//
// Attempting service startup is the recovery boundary
// (docs/architecture.md#recovery). Before it, a failure puts the files back
// and resumes the writers it paused. After it, the services are stopped and
// the data is left as it is: even a failed start may have migrated it or
// accepted writes, so the backup is never loaded over it.
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
}

export type UpdateOutcome =
    | { readonly state: 'done'; readonly backup: string }
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
    try {
        heading(io, 'Backing up the site');
        backup = await takeBackup({ io, site, metadata: plan.metadata, consistent: true, pause });
        ok(io, 'backup', `${relative(dir, backup)}, checked`);

        await plan.write();

        heading(io, 'Starting the services');
        await plan.pull();

        // Set before attempting up: even a failed start may migrate data or accept writes.
        servicesChanged = true;
        pause.end();
        await upAndWait(io, dir, 'Starting the services and waiting for them to be healthy');
        ok(io, 'services', 'healthy, by their own health checks');

        await verifySite(io, dir);
        plan.record?.();
    } catch (error) {
        return recover(plan, snapshot, pause, backup, servicesChanged, error);
    }
    snapshot.remove();
    return { state: 'done', backup };
}

async function recover(
    plan: UpdatePlan,
    snapshot: Snapshot,
    pause: WriterPause,
    backup: string | null,
    servicesChanged: boolean,
    error: unknown,
): Promise<UpdateOutcome> {
    const { io, site } = plan;
    const dir = site.dir;
    io.stderr(`\n${describeError(error)}\n`);
    io.stderr(`\n${plan.failing}\n`);
    const problems: string[] = [];
    if (servicesChanged) {
        const stopped = await stopServices(io, dir, `Stopping ${plan.to}`);
        if (stopped.error !== null) {
            problems.push(`the services could not be stopped: ${stopped.error}`);
        }
    }
    const putBack = !servicesChanged || plan.afterStartup === 'restore';
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
