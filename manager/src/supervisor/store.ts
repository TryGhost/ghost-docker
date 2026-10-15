// The supervisor's private records, in the site directory
// (docs/upgrade-supervisor.md#what-the-supervisor-keeps).
//
// A record is the job as the API answers it plus what only the host needs:
// the stage reached, the backup, whether it holds the lock. It is created
// exclusively when a request is accepted, and it is what the
// interrupted-on-start rule reads.
import {
    closeSync,
    constants,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    rmSync,
    writeSync,
} from 'node:fs';
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
    upgradeVersionSchema,
} from './protocol.ts';

/** The Compose service the supervisor runs as, which its jobs leave alone. */
export const SUPERVISOR_SERVICE = 'supervisor';

const JOBS = 'jobs';
/** `<key>.json`: a record's file name. */
const RECORD_NAME = /^([0-9a-f]{64})\.json$/;

/** Finished jobs kept, besides the active one. */
export const HISTORY = 20;

export const stageSchema = z.enum([
    'pulling',
    'backing-up',
    'restarting',
    'verifying',
    'restoring',
]);
export type Stage = z.infer<typeof stageSchema>;

const recordSchema = z
    .object({
        job: upgradeJobSchema,
        /** The last stage begun, or null before the job started. */
        stage: stageSchema.nullable(),
        /** The backup the job took, relative to the site. */
        backup: z.string().nullable(),
        /** Whether the job took the site lock. */
        lock: z.boolean(),
    })
    .strict();
export type JobRecord = z.infer<typeof recordSchema>;

const discoverySchema = z
    .object({
        checkedAt: z.iso.datetime(),
        currentVersion: upgradeVersionSchema.optional(),
        oneClick: z.array(oneClickUpdateSchema),
        manual: z.array(manualUpdateSchema),
        /** When each component last checked successfully. */
        succeededAt: z.record(z.string(), z.iso.datetime()),
        diagnostics: z.array(upgradeDiagnosticSchema),
    })
    .strict();
export type Discovery = z.infer<typeof discoverySchema>;

const prunedSchema = z.array(upgradeJobIdSchema).max(PRUNED_KEPT);

export class ClaimedAlready extends Error {}

/** The private records, in the site's SUPERVISOR_DIR. */
export class Records {
    readonly root: string;
    private readonly jobs: string;

    constructor(dir: string) {
        this.root = join(dir, SUPERVISOR_DIR);
        this.jobs = join(this.root, JOBS);
    }

    ensure(): void {
        mkdirSync(this.jobs, { recursive: true, mode: 0o700 });
    }

    private path(id: string): string {
        return join(this.jobs, `${upgradeJobIdSchema.parse(id)}.json`);
    }

    has(id: string): boolean {
        return existsSync(this.path(id));
    }

    /** The claim: the record created only if no record of `id` exists. */
    create(record: JobRecord): void {
        let fd: number;
        try {
            fd = openSync(
                this.path(record.job.id),
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
                PRIVATE,
            );
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                throw new ClaimedAlready(record.job.id);
            }
            throw error;
        }
        try {
            writeSync(fd, `${JSON.stringify(recordSchema.parse(record))}\n`);
        } finally {
            closeSync(fd);
        }
    }

    write(record: JobRecord): void {
        atomicWrite(
            this.path(record.job.id),
            `${JSON.stringify(recordSchema.parse(record))}\n`,
            PRIVATE,
        );
    }

    read(id: string): JobRecord | undefined {
        const text = readIfExists(this.path(id));
        return text === undefined ? undefined : recordSchema.parse(JSON.parse(text));
    }

    /** Every record, oldest first. A record that does not parse is skipped and named. */
    list(): { records: JobRecord[]; unreadable: string[] } {
        const records: JobRecord[] = [];
        const unreadable: string[] = [];
        let names: string[] = [];
        try {
            names = readdirSync(this.jobs);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
        for (const name of names) {
            const match = RECORD_NAME.exec(name);
            if (!match) {
                continue;
            }
            try {
                records.push(this.read(match[1]!)!);
            } catch {
                unreadable.push(name);
            }
        }
        records.sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt));
        return { records, unreadable };
    }

    remove(id: string): void {
        rmSync(this.path(id), { force: true });
    }

    pruned(): string[] {
        const text = readIfExists(join(this.root, 'pruned.json'));
        if (text === undefined) {
            return [];
        }
        try {
            return prunedSchema.parse(JSON.parse(text));
        } catch {
            return [];
        }
    }

    writePruned(ids: readonly string[]): void {
        atomicWrite(
            join(this.root, 'pruned.json'),
            `${JSON.stringify(ids.slice(0, PRUNED_KEPT))}\n`,
            PRIVATE,
        );
    }

    discovery(): Discovery | undefined {
        const text = readIfExists(join(this.root, 'discovery.json'));
        if (text === undefined) {
            return undefined;
        }
        try {
            return discoverySchema.parse(JSON.parse(text));
        } catch {
            return undefined;
        }
    }

    writeDiscovery(discovery: Discovery): void {
        atomicWrite(
            join(this.root, 'discovery.json'),
            `${JSON.stringify(discoverySchema.parse(discovery))}\n`,
            PRIVATE,
        );
    }
}

export const isActive = (record: JobRecord): boolean => !isFinal(record.job.state);
