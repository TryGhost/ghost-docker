// The services that write a site's data, and pausing them (plan §2.5).
//
// A consistent backup pauses them for its capture alone, and resumes them
// at once. An operation that may load that backup back over the site
// (self-update now; Ghost updates and the supervisor when they land) owns
// the pause instead, from before the checkpoint until the site it leaves
// running is verified, so nothing a writer accepts after the checkpoint can
// be lost by loading it:
//
//   - the writers are paused before the checkpoint is taken;
//   - a failure before any service changed puts the files back, then
//     resumes the writers as they were;
//   - once the operation starts the services, they are the new site's, and
//     the pause is over: a recovery stops everything, loads the checkpoint
//     and starts the site again.
//
// Writers that were not running are never started by resuming.
import { compose, composeError, READY_SECONDS } from './compose.ts';
import { CliError } from './errors.ts';
import type { Io } from './io.ts';
import { ok } from './report.ts';

/** The services that write the site's databases and content. */
export const WRITERS = ['ghost', 'activitypub'] as const;

/**
 * Writers stopped, then started again as they were: not recreated, and
 * their dependencies, which kept running, left alone.
 */
export class WriterPause {
    private stopped: string[] = [];
    private readonly io: Io;
    private readonly dir: string;
    /** What the pause is for, as in "stopped for the capture". */
    private readonly purpose: string;

    constructor(io: Io, dir: string, purpose = 'the capture') {
        this.io = io;
        this.dir = dir;
        this.purpose = purpose;
    }

    /** The writers this pause stopped and has not started again. */
    get paused(): readonly string[] {
        return this.stopped;
    }

    /** Each of WRITERS in `running` stopped. A no-op while paused. */
    async stop(running: readonly string[]): Promise<void> {
        if (this.stopped.length > 0) {
            return;
        }
        const writers = WRITERS.filter((service) => running.includes(service));
        if (writers.length === 0) {
            ok(this.io, 'writers', `none running, so nothing writes during ${this.purpose}`);
            return;
        }
        // Recorded first: a stop that fails part-way is started again too.
        this.stopped = writers;
        const stop = await this.io.busy(
            `Stopping ${writers.join(' and ')} for ${this.purpose}`,
            () =>
                compose(this.io, { dir: this.dir, timeout: 300_000 })`stop --timeout 20 ${writers}`,
        );
        if (stop.exitCode !== 0) {
            throw new CliError(
                `${writers.join(' and ')} could not be stopped for ${this.purpose}: ${composeError(stop)}`,
            );
        }
        ok(
            this.io,
            'writers',
            `${writers.join(' and ')} stopped, so nothing writes during ${this.purpose}`,
        );
    }

    /** The writers stopped, running again; a no-op once done. */
    async resume(): Promise<void> {
        const writers = this.stopped;
        if (writers.length === 0) {
            return;
        }
        this.stopped = [];
        const up = await this.io.busy(
            `Starting ${writers.join(' and ')} again`,
            () =>
                compose(this.io, {
                    dir: this.dir,
                    timeout: (READY_SECONDS + 60) * 1000,
                })`up --detach --wait --wait-timeout ${READY_SECONDS} --no-recreate --no-deps ${writers}`,
        );
        if (up.exitCode !== 0) {
            throw new CliError(
                `${writers.join(' and ')} did not start again after ${this.purpose}: ${composeError(up)}\n` +
                    '  Start them with: docker compose up -d',
            );
        }
        ok(this.io, 'writers', `${writers.join(' and ')} running again, and healthy`);
    }

    /**
     * The pause is over without resuming: the operation has started the
     * site's services itself, or stopped them all.
     */
    end(): void {
        this.stopped = [];
    }
}
