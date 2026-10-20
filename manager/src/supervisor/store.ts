// The supervisor's private state, one file in the site directory, held in
// memory and written whole, atomically, after every change. The record of a
// job running when the supervisor stopped is what the interrupted-on-start
// rule reads (docs/upgrade-supervisor.md#what-the-supervisor-keeps).
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWrite, PRIVATE, readIfExists } from '../fs.ts';
import { SUPERVISOR_DIR } from '../site.ts';
import {
    isFinal,
    manualUpdateSchema,
    oneClickUpdateSchema,
    PRUNED_KEPT,
    upgradeDiagnosticSchema,
    upgradeJobIdSchema,
    upgradeJobSchema,
} from './protocol.ts';

/** The Compose service the supervisor runs as, which its jobs leave alone. */
export const SUPERVISOR_SERVICE = 'supervisor';

const STATE_FILE = 'state.json';

/** Finished jobs kept, besides the active one. */
export const HISTORY = 20;

export const stageSchema = z.enum([
    'pulling',
    'backing-up',
    // Private: the job reports it as `restarting`, the base schema's next state.
    'configuring',
    'restarting',
    'verifying',
    'restoring',
]);
export type Stage = z.infer<typeof stageSchema>;

/** The exact image an offered update runs: what discovery pulled, by digest. */
export const targetSchema = z
    .object({
        image: z.string().min(1),
        /** The tag it was found by, recorded as the site's GHOST_VERSION. */
        tag: z.string().min(1),
        digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    })
    .strict();
export type Target = z.infer<typeof targetSchema>;

/** A one-click entry and the image it runs: what a job may run, and nothing else. */
const offerSchema = oneClickUpdateSchema.extend({ target: targetSchema }).strict();
export type Offer = z.infer<typeof offerSchema>;

const recordSchema = z
    .object({
        job: upgradeJobSchema,
        /** The last stage begun, or null before the job started. */
        stage: stageSchema.nullable(),
        /** The backup the job took, relative to the site. */
        backup: z.string().nullable(),
        /** Whether the job took the site lock. */
        lock: z.boolean(),
        /** The image the job runs, pinned when it was accepted. */
        target: targetSchema.nullable(),
    })
    .strict();
export type JobRecord = z.infer<typeof recordSchema>;

const discoverySchema = z
    .object({
        /** Status lists them without their targets. */
        oneClick: z.array(offerSchema),
        manual: z.array(manualUpdateSchema),
        /** When each component last checked successfully. */
        succeededAt: z.record(z.string(), z.iso.datetime()),
        diagnostics: z.array(upgradeDiagnosticSchema),
    })
    .strict();
export type Discovery = z.infer<typeof discoverySchema>;

const stateSchema = z
    .object({
        /** Oldest first. */
        jobs: z.array(recordSchema),
        /** Newest first. */
        pruned: z.array(upgradeJobIdSchema).max(PRUNED_KEPT),
        discovery: discoverySchema.nullable(),
    })
    .strict();
type State = z.infer<typeof stateSchema>;

export class ClaimedAlready extends Error {}

/** The private state, in the site's SUPERVISOR_DIR. */
export class Records {
    readonly root: string;
    private readonly file: string;
    private state: State | null = null;

    constructor(dir: string) {
        this.root = join(dir, SUPERVISOR_DIR);
        this.file = join(this.root, STATE_FILE);
    }

    ensure(): void {
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
    }

    /**
     * The state, read once. A file that does not parse is set aside beside
     * itself, not overwritten: what it says about an unfinished job is for
     * the operator to read.
     */
    private load(): State {
        if (this.state !== null) {
            return this.state;
        }
        const text = readIfExists(this.file);
        this.state = { jobs: [], pruned: [], discovery: null };
        if (text !== undefined) {
            try {
                this.state = stateSchema.parse(JSON.parse(text));
            } catch (error) {
                const kept = `${this.file}.unreadable-${Date.now()}`;
                renameSync(this.file, kept);
                throw new UnreadableState(kept, error);
            }
        }
        return this.state;
    }

    private save(): void {
        this.ensure();
        atomicWrite(this.file, `${JSON.stringify(stateSchema.parse(this.load()))}\n`, PRIVATE);
    }

    has(id: string): boolean {
        return this.load().jobs.some((record) => record.job.id === id);
    }

    /** A new job: refused when one of `id` exists. */
    create(record: JobRecord): void {
        if (this.has(record.job.id)) {
            throw new ClaimedAlready(record.job.id);
        }
        this.load().jobs.push(structuredClone(recordSchema.parse(record)));
        this.save();
    }

    write(record: JobRecord): void {
        const jobs = this.load().jobs;
        const index = jobs.findIndex((each) => each.job.id === record.job.id);
        const copy = structuredClone(recordSchema.parse(record));
        if (index === -1) {
            jobs.push(copy);
        } else {
            jobs[index] = copy;
        }
        this.save();
    }

    read(id: string): JobRecord | undefined {
        const record = this.load().jobs.find((each) => each.job.id === id);
        return record === undefined ? undefined : structuredClone(record);
    }

    /** Every job, oldest first. */
    list(): { records: JobRecord[] } {
        return { records: this.load().jobs.map((record) => structuredClone(record)) };
    }

    /** Jobs removed, and their IDs kept, newest first, as pruned. */
    prune(ids: readonly string[]): void {
        if (ids.length === 0) {
            return;
        }
        const state = this.load();
        state.jobs = state.jobs.filter((record) => !ids.includes(record.job.id));
        state.pruned = [...ids, ...state.pruned].slice(0, PRUNED_KEPT);
        this.save();
    }

    pruned(): string[] {
        return [...this.load().pruned];
    }

    discovery(): Discovery | undefined {
        return this.load().discovery ?? undefined;
    }

    writeDiscovery(discovery: Discovery): void {
        this.load().discovery = discoverySchema.parse(discovery);
        this.save();
    }
}

/** state.json did not parse; it is kept at `kept`. */
export class UnreadableState extends Error {
    readonly kept: string;

    constructor(kept: string, cause: unknown) {
        super(`the supervisor's state did not parse, and is kept at ${kept}`, { cause });
        this.kept = kept;
    }
}

export const isActive = (record: JobRecord): boolean => !isFinal(record.job.state);
