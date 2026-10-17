// The upgrade supervisor: the host command run on Ghost's behalf, with a small
// HTTP API in front of it (docs/upgrade-supervisor.md). server.ts is the
// transport; this is what each request decides.
//
// One job at a time, run by the executor `update` uses. A request that arrives
// meanwhile is rejected as busy, never queued. Every stage is recorded before
// its side effects begin; a job found unfinished on start is marked
// interrupted and never resumed, and the lock it held is left for the operator.
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CliError } from '../errors.ts';
import type { Io } from '../io.ts';
import { acquireLock, describeLock, readLock, type Lock } from '../lock.ts';
import type { Metadata } from '../meta.ts';
import { UPDATE_DIR } from '../site.ts';
import { diagnostic } from './diagnostics.ts';
import type { Discoverer } from './discovery.ts';
import { DISCOVERY_EVERY_MS } from './discovery.ts';
import {
    createUpgradeRequestSchema,
    DIAGNOSTICS_KEPT,
    ERROR_STATUS,
    jobIdOf,
    upgradeJobIdSchema,
    type ErrorBody,
    type ErrorCode,
    type FinalState,
    type SupervisorStatus,
    type UpgradeDiagnostic,
    type UpgradeJob,
    type UpgradeJobResult,
} from './protocol.ts';
import {
    ClaimedAlready,
    HISTORY,
    isActive,
    Records,
    UnreadableState,
    type Discovery,
    type JobRecord,
    type Stage,
} from './store.ts';

export const POLL_ACTIVE_MS = 2_000;
export const POLL_IDLE_MS = 30_000;

export interface JobContext {
    readonly record: JobRecord;
    /** Records `stage` before its side effects begin. */
    stage(stage: Stage): void;
    /** Records the backup, as a path relative to the site. */
    backup(path: string): void;
}

export interface JobOutcome {
    readonly state: Exclude<FinalState, 'interrupted'>;
    readonly diagnostics: UpgradeDiagnostic[];
}

/** Runs a claimed Ghost update, with the site lock held. */
export type Executor = (context: JobContext) => Promise<JobOutcome>;

export interface SupervisorOptions {
    readonly io: Io;
    readonly dir: string;
    readonly records: Records;
    readonly execute: Executor;
    readonly discover: Discoverer;
    /** The site's metadata, read again each time: an update changes it. */
    readonly metadata: () => Metadata;
    readonly now?: () => Date;
}

const operationOf = (id: string, version: string) =>
    `supervisor job ${id}: update Ghost to ${version}`;

/** An answer of the API: its status code and JSON body. */
export interface Answer {
    readonly status: number;
    readonly body: UpgradeJob | UpgradeJobResult | SupervisorStatus | ErrorBody | object;
}

export const failure = (
    code: ErrorCode,
    message: string,
    diagnostics: UpgradeDiagnostic[] = [],
): Answer => ({
    status: ERROR_STATUS[code],
    body: {
        error: {
            code,
            diagnostics: [diagnostic(code, 'error', message), ...diagnostics].slice(
                0,
                DIAGNOSTICS_KEPT,
            ),
        },
    },
});

/** A copy, so an answer never changes as the job moves on. */
const snapshot = (job: UpgradeJob): UpgradeJob => structuredClone(job);

export class Supervisor {
    private readonly io: Io;
    private readonly dir: string;
    private readonly records: Records;
    private readonly options: SupervisorOptions;
    private readonly now: () => Date;
    private discovery: Discovery | undefined;
    private discoveredAt = 0;
    private activeId: string | null = null;
    private lock: Lock | null = null;
    private running: Promise<void> | null = null;
    /** What the status says once, from start, whatever else holds. */
    private readonly notices: UpgradeDiagnostic[] = [];

    constructor(options: SupervisorOptions) {
        this.options = options;
        this.io = options.io;
        this.dir = options.dir;
        this.records = options.records;
        this.now = options.now ?? (() => new Date());
    }

    /** The job running now, for tests and shutdown. */
    get job(): Promise<void> | null {
        return this.running;
    }

    // --- Starting ------------------------------------------------------------------

    /**
     * The interrupted-on-start rule, and the last discovery to answer with.
     * The caller listens next, then discovers: a check pulls images, which is slow.
     */
    start(): void {
        this.records.ensure();
        let records: JobRecord[] = [];
        try {
            records = this.records.list().records;
        } catch (error) {
            if (!(error instanceof UnreadableState)) {
                throw error;
            }
            this.io.stderr(`${error.message}\n`);
            this.notices.push(
                diagnostic(
                    'state-unreadable',
                    'warning',
                    `The supervisor's earlier records could not be read, so jobs before this start are not shown. They are kept at \`${relative(this.dir, error.kept)}\` for the operator.`,
                ),
            );
        }
        for (const record of records.filter(isActive)) {
            this.interrupt(record);
        }
        this.discovery = this.records.discovery();
    }

    private interrupt(record: JobRecord): void {
        const lock = readLock(this.dir);
        const holding =
            record.lock &&
            lock.state === 'held' &&
            lock.holder.operation === operationOf(record.job.id, record.job.toVersion);
        const reached = record.stage ?? 'starting';
        // Once startup may have been attempted, Ghost may have migrated the data.
        const started =
            record.stage === 'restarting' ||
            record.stage === 'verifying' ||
            record.stage === 'restoring';
        const steps = [
            'In the site directory:',
            '  `./ghost-docker check`',
            ...(holding ? ['  `rm .ghost-docker.lock`'] : []),
            ...(started
                ? [
                      `  Ghost ${record.job.toVersion} may have started and migrated the database. Either find why it did not finish`,
                      '  (`docker compose logs ghost`), fix it, then `docker compose up -d`,',
                      ...(record.backup === null
                          ? []
                          : [
                                `  or put the site back as it was, discarding anything written since: \`./ghost-docker restore --yes ${record.backup}\``,
                            ]),
                  ]
                : record.stage === 'backing-up'
                  ? [
                        '  Nothing was changed yet, but Ghost may be stopped for the backup: `docker compose up -d`',
                    ]
                  : ['  Nothing was changed.']),
            ...(record.stage === null || record.stage === 'pulling'
                ? []
                : ['  Once `./ghost-docker check` passes: `rm -rf .ghost-docker-update`']),
        ];
        const message =
            `The upgrade supervisor stopped while this job was ${reached}. It is never resumed.` +
            (record.backup === null
                ? ''
                : ` Before it began, the site was backed up to \`${record.backup}\`.`) +
            (holding
                ? ' The site lock is still held, so nothing else runs until the operator has checked the site.'
                : '');
        this.finish(record, 'interrupted', [
            diagnostic('interrupted', 'error', message, steps.join('\n')),
        ]);
    }

    // --- Requests -----------------------------------------------------------------------

    /**
     * POST /v1/requests, decided in the protocol's order: a replay first, then
     * availability, then the offer. It never yields, so two requests are never
     * both accepted (docs/upgrade-supervisor.md#supervisor-a-request).
     */
    request(body: unknown): Answer {
        const parsed = createUpgradeRequestSchema.safeParse(body);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            return failure(
                'malformed',
                `The request does not match protocol 1: ${issue?.path.join('.') || '(body)'} ${issue?.message ?? ''}`.trim(),
            );
        }
        const request = parsed.data;
        const id = jobIdOf(request.idempotencyKey);

        const earlier = this.read(id);
        if (earlier !== undefined) {
            return earlier.job.component === request.component &&
                earlier.job.toVersion === request.toVersion
                ? { status: 200, body: snapshot(earlier.job) }
                : failure(
                      'idempotency-conflict',
                      'This idempotency key was used for another update.',
                  );
        }
        if (this.records.pruned().includes(id)) {
            return failure('request-expired', 'The job of this idempotency key is no longer kept.');
        }

        const { availability, diagnostics } = this.condition();
        if (availability === 'unavailable') {
            return failure('unavailable', 'The supervisor cannot run updates now.', diagnostics);
        }
        if (availability === 'busy') {
            return failure(
                'busy',
                diagnostics[0]?.message ?? 'Another job is running on this site.',
            );
        }
        const offered = (this.discovery?.oneClick ?? []).some(
            (entry) =>
                entry.component === request.component && entry.toVersion === request.toVersion,
        );
        // The image discovery found for it: the job runs that, and nothing else.
        const pin = (this.discovery?.pins ?? []).find(
            (entry) =>
                entry.component === request.component && entry.toVersion === request.toVersion,
        );
        if (!offered || pin === undefined) {
            return failure(
                'target-unapproved',
                `${request.component} ${request.toVersion} is not an update this host offers from Admin.`,
            );
        }

        let lock: Lock;
        try {
            lock = acquireLock(this.dir, operationOf(id, request.toVersion), this.now());
        } catch (error) {
            if (error instanceof CliError) {
                return failure('busy', `Another operation is changing this site. ${error.message}`);
            }
            throw error;
        }
        const at = this.now().toISOString();
        const record: JobRecord = {
            job: {
                id,
                state: 'pending',
                component: request.component,
                fromVersion: this.options.metadata().ghost.version,
                toVersion: request.toVersion,
                createdAt: at,
                updatedAt: at,
            },
            stage: null,
            backup: null,
            lock: true,
            target: pin.target,
        };
        try {
            this.records.create(record);
        } catch (error) {
            lock.release();
            if (error instanceof ClaimedAlready) {
                return this.request(body);
            }
            throw error;
        }
        this.lock = lock;
        this.activeId = id;
        this.prune();
        const accepted = snapshot(record.job);
        this.running = this.run(record);
        return { status: 202, body: accepted };
    }

    /** GET /v1/jobs/<id>: the job, or whether it was ever known. */
    lookup(id: string): Answer {
        if (!upgradeJobIdSchema.safeParse(id).success) {
            return failure('malformed', 'That is not a job ID.');
        }
        const record = this.read(id);
        if (record !== undefined) {
            return { status: 200, body: snapshot(record.job) };
        }
        return {
            status: 200,
            body: { id, state: this.records.pruned().includes(id) ? 'expired' : 'unknown' },
        };
    }

    private read(id: string): JobRecord | undefined {
        try {
            return this.records.read(id);
        } catch (error) {
            this.io.stderr(
                `The record of job ${id} could not be read: ${(error as Error).message}\n`,
            );
            return undefined;
        }
    }

    // --- Running ----------------------------------------------------------------------

    private async run(record: JobRecord): Promise<void> {
        const context: JobContext = {
            record,
            stage: (stage) => {
                record.stage = stage;
                record.job.state = stage;
                try {
                    this.save(record);
                } catch (error) {
                    // Recovery is under way and must not stop for a record it could not write.
                    if (stage !== 'restoring') {
                        throw error;
                    }
                    this.io.stderr(
                        `The job's state could not be recorded: ${(error as Error).message}\n`,
                    );
                }
            },
            backup: (path) => {
                record.backup = path;
                this.save(record);
            },
        };
        let outcome: JobOutcome;
        try {
            outcome = await this.options.execute(context);
        } catch (error) {
            outcome = {
                state: 'needs-operator',
                diagnostics: [
                    diagnostic(
                        'failed',
                        'error',
                        `The update failed unexpectedly at ${record.stage ?? 'its start'}. Check the site (\`./ghost-docker check\`) before anything else.`,
                        (error as Error).stack ?? String(error),
                    ),
                ],
            };
        }
        // As the CLI's `update` does: the lock goes whatever the outcome, and
        // needs-operator says what the operator does next.
        this.lock?.release();
        this.lock = null;
        record.lock = false;
        this.finish(record, outcome.state, outcome.diagnostics);
        this.activeId = null;
        this.running = null;
        await this.rediscover();
    }

    private save(record: JobRecord): void {
        record.job.updatedAt = this.now().toISOString();
        this.records.write(record);
    }

    private finish(record: JobRecord, state: FinalState, diagnostics: UpgradeDiagnostic[]): void {
        record.job.state = state;
        record.job.diagnostics = diagnostics.slice(0, DIAGNOSTICS_KEPT);
        this.save(record);
    }

    // --- Retention --------------------------------------------------------------------

    /** The active job and the HISTORY newest finished ones kept; the rest pruned. */
    private prune(): void {
        const finished = this.records
            .list()
            .records.filter((record) => !isActive(record))
            .sort((a, b) => b.job.updatedAt.localeCompare(a.job.updatedAt));
        const dropped = finished.slice(HISTORY);
        if (dropped.length === 0) {
            return;
        }
        this.records.prune(dropped.map((record) => record.job.id));
    }

    // --- Status ------------------------------------------------------------------------

    /** Whether a job could start now, and if not, why. */
    private condition(): {
        availability: SupervisorStatus['availability'];
        diagnostics: UpgradeDiagnostic[];
    } {
        if (this.activeId !== null) {
            return {
                availability: 'busy',
                diagnostics: [
                    diagnostic('busy', 'info', `Job ${this.activeId} is running on this site.`),
                ],
            };
        }
        const lock = readLock(this.dir);
        if (lock.state === 'held') {
            const interrupted = this.records
                .list()
                .records.find(
                    (record) =>
                        record.job.state === 'interrupted' &&
                        lock.holder.operation === operationOf(record.job.id, record.job.toVersion),
                );
            if (interrupted !== undefined) {
                return {
                    availability: 'unavailable',
                    diagnostics: [
                        diagnostic(
                            'interrupted',
                            'error',
                            `Job ${interrupted.job.id} was interrupted and still holds the site lock. The operator must check the site and remove the lock.`,
                            interrupted.job.diagnostics?.[0]?.details,
                        ),
                    ],
                };
            }
            return {
                availability: 'busy',
                diagnostics: [
                    diagnostic('locked', 'info', describeLock(this.dir, lock).split('\n')[0]!),
                ],
            };
        }
        if (lock.state === 'unreadable') {
            return {
                availability: 'unavailable',
                diagnostics: [diagnostic('lock-unreadable', 'error', describeLock(this.dir, lock))],
            };
        }
        if (existsSync(join(this.dir, UPDATE_DIR))) {
            return {
                availability: 'unavailable',
                diagnostics: [
                    diagnostic(
                        'update-unfinished',
                        'error',
                        `\`${UPDATE_DIR}\` is left from an update that did not finish. Once the site is as it should be (\`./ghost-docker check\`), the operator removes it.`,
                    ),
                ],
            };
        }
        return { availability: 'ready', diagnostics: [] };
    }

    /** Discovery when it is due, and never while a job runs. */
    async discoverIfDue(): Promise<void> {
        if (
            this.activeId === null &&
            this.now().getTime() - this.discoveredAt >= DISCOVERY_EVERY_MS
        ) {
            await this.rediscover();
        }
    }

    async rediscover(): Promise<void> {
        try {
            this.discovery = await this.options.discover({
                io: this.io,
                metadata: this.options.metadata(),
                previous: this.discovery,
                now: this.now(),
            });
            this.records.writeDiscovery(this.discovery);
        } catch (error) {
            this.io.stderr(`Checking for updates failed: ${(error as Error).message}\n`);
        }
        this.discoveredAt = this.now().getTime();
    }

    /** GET /v1/status. */
    status(): SupervisorStatus {
        const { availability, diagnostics } = this.condition();
        const discovery = this.discovery;
        const status: SupervisorStatus = {
            supported: true,
            availability,
            backupRequired: true,
            currentVersion: this.options.metadata().ghost.version,
            oneClick: discovery?.oneClick ?? [],
            manual: discovery?.manual ?? [],
            activeJobId: this.activeId,
            pollAfterMs: this.activeId === null ? POLL_IDLE_MS : POLL_ACTIVE_MS,
            diagnostics: [...diagnostics, ...this.notices, ...(discovery?.diagnostics ?? [])].slice(
                0,
                DIAGNOSTICS_KEPT,
            ),
        };
        return status;
    }
}
