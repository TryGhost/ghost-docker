// The upgrade supervisor: the host command run on Ghost's behalf, with a file
// exchange in front of it (docs/upgrade-supervisor.md).
//
// One job at a time, run by the executor `update` uses. Requests that arrive
// meanwhile are claimed and refused, never queued. Every stage is recorded
// before its side effects begin; a job found unfinished on start is marked
// interrupted and never resumed, and the lock it held is left for the operator.
import { lstatSync, opendirSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from '../errors.ts';
import type { Io } from '../io.ts';
import { acquireLock, describeLock, readLock, type Lock } from '../lock.ts';
import type { Metadata } from '../meta.ts';
import { UPDATE_DIR } from '../site.ts';
import { diagnostic } from './diagnostics.ts';
import type { Discoverer, Policy } from './discovery.ts';
import { DISCOVERY_EVERY_MS } from './discovery.ts';
import {
    BOUNDS,
    DIAGNOSTICS_KEPT,
    ExchangeFileError,
    jobIdOf,
    JOB_FILE_NAME,
    parseExchangeFile,
    PRUNED_KEPT,
    readExchangeFile,
    REQUEST_MAX_AGE_MS,
    REQUEST_MAX_SKEW_MS,
    requestFileSchema,
    upgradeComponentSchema,
    upgradeVersionSchema,
    type FinalState,
    type SupervisorStatus,
    type UpgradeDiagnostic,
    type UpgradeRequest,
} from './protocol.ts';
import {
    ClaimedAlready,
    Exchange,
    HISTORY,
    isActive,
    Records,
    type Discovery,
    type JobRecord,
    type Stage,
} from './store.ts';

/** Requests read per scan of the exchange. */
export const SCAN_LIMIT = 32;
export const POLL_MS = 2_000;
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
    readonly exchange: Exchange;
    readonly records: Records;
    readonly execute: Executor;
    readonly discover: Discoverer;
    /** The site's metadata, read again each time: an update changes it. */
    readonly metadata: () => Metadata;
    /** SUPERVISOR_UPDATES, or null when `.env` sets something else. */
    readonly policy: () => Policy | null;
    readonly now?: () => Date;
}

const operationOf = (id: string, version: string) =>
    `supervisor job ${id}: update Ghost to ${version}`;

/** What a request says, or why it cannot be run. */
type Claim =
    | { readonly ok: true; readonly request: UpgradeRequest }
    | {
          readonly ok: false;
          readonly code: 'malformed' | 'request-expired';
          readonly message: string;
          readonly component: string;
          readonly toVersion: string;
      };

export class Supervisor {
    private readonly io: Io;
    private readonly dir: string;
    private readonly exchange: Exchange;
    private readonly records: Records;
    private readonly options: SupervisorOptions;
    private readonly now: () => Date;
    private discovery: Discovery | undefined;
    private discoveredAt = 0;
    private activeId: string | null = null;
    private lock: Lock | null = null;
    private running: Promise<void> | null = null;

    constructor(options: SupervisorOptions) {
        this.options = options;
        this.io = options.io;
        this.dir = options.dir;
        this.exchange = options.exchange;
        this.records = options.records;
        this.now = options.now ?? (() => new Date());
    }

    /** The job running now, for tests and shutdown. */
    get job(): Promise<void> | null {
        return this.running;
    }

    // --- Starting ------------------------------------------------------------------

    /** The interrupted-on-start rule, duplicates removed, then the first status. */
    async start(): Promise<void> {
        this.records.ensure();
        this.exchange.ensureJobs();
        for (const record of this.records.list().records.filter(isActive)) {
            this.interrupt(record);
        }
        this.discovery = this.records.discovery();
        // At once, from the last discovery: a check pulls images, which is slow.
        this.publish();
        await this.rediscover();
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
            '  ./ghost-docker check',
            ...(holding ? ['  rm .ghost-docker.lock'] : []),
            ...(started
                ? [
                      `  Ghost ${record.job.toVersion} may have started and migrated the database. Either find why it did not finish`,
                      '  (docker compose logs ghost), fix it, then docker compose up -d,',
                      ...(record.backup === null
                          ? []
                          : [
                                `  or put the site back as it was, discarding anything written since: ./ghost-docker restore --yes ${record.backup}`,
                            ]),
                  ]
                : record.stage === 'backing-up'
                  ? [
                        '  Nothing was changed yet, but Ghost may be stopped for the backup: docker compose up -d',
                    ]
                  : ['  Nothing was changed.']),
            ...(record.stage === null || record.stage === 'pulling'
                ? []
                : ['  Once ./ghost-docker check passes: rm -rf .ghost-docker-update']),
        ];
        const message =
            `The upgrade supervisor stopped while this job was ${reached}. It is never resumed.` +
            (record.backup === null
                ? ''
                : ` Before it began, the site was backed up to ${record.backup}.`) +
            (holding
                ? ' The site lock is still held, so nothing else runs until the operator has checked the site.'
                : '');
        this.finish(record, 'interrupted', [
            diagnostic('interrupted', 'error', message, steps.join('\n')),
        ]);
    }

    // --- Claiming -------------------------------------------------------------------

    /** One scan of the exchange: each request claimed, then refused or started. */
    async tick(): Promise<void> {
        for (const name of this.scan()) {
            const match = JOB_FILE_NAME.exec(name);
            if (!match) {
                this.removeStray(name);
                continue;
            }
            await this.claim(match[1]!, name);
        }
        if (
            this.activeId === null &&
            this.now().getTime() - this.discoveredAt >= DISCOVERY_EVERY_MS
        ) {
            await this.rediscover();
        }
    }

    /** Up to SCAN_LIMIT names in the requests directory, oldest first. */
    private scan(): string[] {
        const names: { name: string; mtimeMs: number }[] = [];
        let dir;
        try {
            dir = opendirSync(this.exchange.requests);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return [];
            }
            throw error;
        }
        try {
            for (
                let entry = dir.readSync();
                entry !== null && names.length < SCAN_LIMIT;
                entry = dir.readSync()
            ) {
                if (entry.name.startsWith('.tmp-') && !this.old(entry.name)) {
                    continue;
                }
                try {
                    names.push({
                        name: entry.name,
                        mtimeMs: lstatSync(join(this.exchange.requests, entry.name)).mtimeMs,
                    });
                } catch {
                    // Gone since it was listed.
                }
            }
        } finally {
            dir.closeSync();
        }
        return names.sort((a, b) => a.mtimeMs - b.mtimeMs).map((entry) => entry.name);
    }

    private old(name: string): boolean {
        try {
            return (
                this.now().getTime() - lstatSync(join(this.exchange.requests, name)).mtimeMs >
                REQUEST_MAX_AGE_MS
            );
        } catch {
            return false;
        }
    }

    /** A name that is no request, removed once it is old enough not to be one being written. */
    private removeStray(name: string): void {
        if (this.old(name)) {
            this.unlinkRequest(name);
        }
    }

    /** A request with more than one link: still being written, or not Ghost's doing. */
    private linked(name: string): boolean {
        try {
            return lstatSync(join(this.exchange.requests, name)).nlink !== 1;
        } catch {
            return false;
        }
    }

    private unlinkRequest(name: string): void {
        rmSync(join(this.exchange.requests, name), { force: true, recursive: false });
    }

    private read(id: string, name: string): Claim {
        const path = join(this.exchange.requests, name);
        let component = 'unknown';
        let toVersion = 'unknown';
        try {
            const read = readExchangeFile(path, BOUNDS.request);
            if (read === undefined) {
                throw new ExchangeFileError(`${name} disappeared before it was read`);
            }
            // What the refusal can name of a request that is otherwise malformed.
            try {
                const loose = JSON.parse(read.text)?.request;
                component = upgradeComponentSchema.safeParse(loose?.component).data ?? component;
                toVersion = upgradeVersionSchema.safeParse(loose?.toVersion).data ?? toVersion;
            } catch {
                // Not JSON: refused below.
            }
            const { request } = parseExchangeFile(requestFileSchema, read, name);
            if (jobIdOf(request.idempotencyKey) !== id) {
                throw new ExchangeFileError(`${name} is not named for its idempotency key`);
            }
            const age = this.now().getTime() - read.mtimeMs;
            if (age > REQUEST_MAX_AGE_MS || age < -REQUEST_MAX_SKEW_MS) {
                return {
                    ok: false,
                    code: 'request-expired',
                    message: `The request was made ${Math.round(age / 1000)} seconds ago, longer than the supervisor accepts. Make it again.`,
                    component,
                    toVersion,
                };
            }
            return { ok: true, request };
        } catch (error) {
            if (error instanceof ExchangeFileError) {
                return {
                    ok: false,
                    code: 'malformed',
                    message: `The request was refused: ${error.message}.`,
                    component,
                    toVersion,
                };
            }
            throw error;
        }
    }

    private async claim(id: string, name: string): Promise<void> {
        if (this.linked(name)) {
            // Mid-write: Ghost links the file into place, then unlinks its
            // temporary. Left for the next scan, never claimed and refused.
            this.removeStray(name);
            return;
        }
        if (this.records.has(id)) {
            // Claimed already: a duplicate the adapter's look-up raced.
            this.unlinkRequest(name);
            return;
        }
        const claim = this.read(id, name);
        const at = this.now().toISOString();
        const record: JobRecord = {
            job: {
                id,
                state: 'pending',
                component: claim.ok ? claim.request.component : claim.component,
                toVersion: claim.ok ? claim.request.toVersion : claim.toVersion,
                createdAt: at,
                updatedAt: at,
            },
            stage: null,
            backup: null,
            lock: false,
        };
        try {
            this.records.create(record);
        } catch (error) {
            if (error instanceof ClaimedAlready) {
                this.unlinkRequest(name);
                return;
            }
            throw error;
        }
        this.prune();

        if (!claim.ok) {
            this.refuse(record, name, claim.code, claim.message);
            return;
        }
        const refusal = this.refusal(claim.request);
        if (refusal !== null) {
            this.refuse(record, name, refusal.code, refusal.message);
            return;
        }
        try {
            this.lock = acquireLock(this.dir, operationOf(id, claim.request.toVersion), this.now());
        } catch (error) {
            if (error instanceof CliError) {
                this.refuse(
                    record,
                    name,
                    'busy',
                    `Another operation is changing this site. ${error.message}`,
                );
                return;
            }
            throw error;
        }
        record.lock = true;
        record.job.fromVersion = this.options.metadata().ghost.version;
        this.save(record);
        this.unlinkRequest(name);
        this.activeId = id;
        this.publish();
        this.running = this.run(record);
    }

    /** Why a well-formed request cannot run now, or null when it can. */
    private refusal(request: UpgradeRequest): { code: string; message: string } | null {
        const { availability, diagnostics } = this.condition();
        if (availability === 'busy') {
            return {
                code: 'busy',
                message: diagnostics[0]?.message ?? 'Another job is running on this site.',
            };
        }
        if (availability === 'unavailable') {
            return {
                code: 'unavailable',
                message: diagnostics[0]?.message ?? 'The supervisor cannot run updates now.',
            };
        }
        const offered = (this.discovery?.oneClick ?? []).some(
            (entry) =>
                entry.component === request.component && entry.toVersion === request.toVersion,
        );
        if (!offered) {
            return {
                code: 'target-unapproved',
                message: `${request.component} ${request.toVersion} is not an update this host offers from Admin.`,
            };
        }
        return null;
    }

    private refuse(record: JobRecord, name: string, code: string, message: string): void {
        this.finish(record, 'refused', [diagnostic(code, 'error', message)]);
        this.unlinkRequest(name);
        this.publish();
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
                    this.publish();
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
                        `The update failed unexpectedly at ${record.stage ?? 'its start'}. Check the site (./ghost-docker check) before anything else.`,
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
        this.exchange.publishJob(record.job);
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
        for (const record of dropped) {
            this.exchange.removeJob(record.job.id);
            this.records.remove(record.job.id);
        }
        this.records.writePruned(
            [...dropped.map((record) => record.job.id), ...this.records.pruned()].slice(
                0,
                PRUNED_KEPT,
            ),
        );
    }

    // --- Status ------------------------------------------------------------------------

    /** Whether a job could start now, and if not, why. */
    private condition(): {
        availability: SupervisorStatus['availability'];
        diagnostics: UpgradeDiagnostic[];
    } {
        if (this.options.policy() === null) {
            return {
                availability: 'unavailable',
                diagnostics: [
                    diagnostic(
                        'policy-invalid',
                        'error',
                        'SUPERVISOR_UPDATES in .env must be minor or patch, so the supervisor runs no updates.',
                    ),
                ],
            };
        }
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
                        `${UPDATE_DIR} is left from an update that did not finish. Once the site is as it should be (./ghost-docker check), the operator removes it.`,
                    ),
                ],
            };
        }
        return { availability: 'ready', diagnostics: [] };
    }

    private async rediscover(): Promise<void> {
        const policy = this.options.policy();
        if (policy !== null) {
            try {
                this.discovery = await this.options.discover({
                    io: this.io,
                    metadata: this.options.metadata(),
                    policy,
                    previous: this.discovery,
                    now: this.now(),
                });
                this.records.writeDiscovery(this.discovery);
            } catch (error) {
                this.io.stderr(`Checking for updates failed: ${(error as Error).message}\n`);
            }
        }
        this.discoveredAt = this.now().getTime();
        this.publish();
    }

    /** The status, with a fresh heartbeat. */
    publish(): void {
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
            diagnostics: [...diagnostics, ...(discovery?.diagnostics ?? [])].slice(
                0,
                DIAGNOSTICS_KEPT,
            ),
        };
        this.exchange.publishStatus(status, this.now().toISOString(), this.records.pruned());
    }
}
