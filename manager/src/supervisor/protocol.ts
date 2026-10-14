// The upgrade supervisor's file-drop protocol, version 1: docs/upgrade-supervisor.md.
//
// The bodies are Ghost's own upgrade schemas (@tryghost/adapter-base-upgrade,
// packages/adapters/upgrade-base/src/schemas.ts in Ghost), copied field for
// field until that package is published and the manager can depend on it.
// The protocol adds only the envelope around them. Keep the copy exact: a
// field that differs here is a file Ghost's adapter refuses.
import { createHash, randomBytes } from 'node:crypto';
import {
    closeSync,
    constants,
    fchmodSync,
    fstatSync,
    fsyncSync,
    linkSync,
    openSync,
    readSync,
    renameSync,
    rmSync,
    writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const PROTOCOL = 1;

// --- Ghost's schemas, as they are --------------------------------------------

export const upgradeVersionSchema = z.string().min(1).max(128);
export const upgradeJobIdSchema = z.uuid().lowercase();
export const upgradeComponentSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

const code = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/);
const text = z.string().min(1).max(2048);
const timestamp = z.iso.datetime();

export const upgradeDiagnosticSchema = z.object({
    source: code,
    code,
    severity: z.enum(['error', 'warning', 'info']),
    message: text,
    details: z.string().max(8192).optional(),
    help: z.url({ protocol: /^https$/ }).optional(),
});
export const upgradeDiagnosticsSchema = z.array(upgradeDiagnosticSchema).max(200);

export const oneClickUpdateSchema = z.object({
    component: upgradeComponentSchema,
    fromVersion: upgradeVersionSchema,
    toVersion: upgradeVersionSchema,
});

export const manualUpdateSchema = oneClickUpdateSchema.extend({
    reason: text,
    steps: z.array(text).max(20),
});

export const createUpgradeRequestSchema = z
    .object({
        component: upgradeComponentSchema,
        toVersion: upgradeVersionSchema,
        idempotencyKey: z.hash('sha256'),
    })
    .strict();

export const activeUpgradeStates = [
    'pending',
    'backing-up',
    'pulling',
    'restarting',
    'verifying',
    'restoring',
] as const;
export const finalUpgradeStates = [
    'done',
    'restored',
    'needs-operator',
    'refused',
    'interrupted',
] as const;

export const upgradeJobSchema = z.object({
    id: upgradeJobIdSchema,
    state: z.enum([...activeUpgradeStates, ...finalUpgradeStates]),
    component: upgradeComponentSchema,
    fromVersion: upgradeVersionSchema.optional(),
    toVersion: upgradeVersionSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
    diagnostics: upgradeDiagnosticsSchema.optional(),
});

export type UpgradeDiagnostic = z.infer<typeof upgradeDiagnosticSchema>;
export type OneClickUpdate = z.infer<typeof oneClickUpdateSchema>;
export type ManualUpdate = z.infer<typeof manualUpdateSchema>;
export type UpgradeRequest = z.infer<typeof createUpgradeRequestSchema>;
export type UpgradeJob = z.infer<typeof upgradeJobSchema>;
export type UpgradeState = UpgradeJob['state'];
export type FinalState = (typeof finalUpgradeStates)[number];

export const isFinal = (state: UpgradeState): state is FinalState =>
    (finalUpgradeStates as readonly string[]).includes(state);

// --- The envelope -------------------------------------------------------------

/** What the supervisor writes of Ghost's status: never `stale` or `incompatible`, which Ghost decides. */
export const supervisorStatusSchema = z.object({
    supported: z.literal(true),
    availability: z.enum(['ready', 'busy', 'unavailable']),
    backupRequired: z.literal(true),
    currentVersion: upgradeVersionSchema.optional(),
    oneClick: z.array(oneClickUpdateSchema).max(50),
    manual: z.array(manualUpdateSchema).max(50),
    activeJobId: upgradeJobIdSchema.nullable(),
    pollAfterMs: z.int().min(1000).max(60000),
    diagnostics: upgradeDiagnosticsSchema,
});
export type SupervisorStatus = z.infer<typeof supervisorStatusSchema>;

export const PRUNED_KEPT = 50;

export const requestFileSchema = z
    .object({ protocol: z.literal(PROTOCOL), request: createUpgradeRequestSchema })
    .strict();
export const jobFileSchema = z
    .object({ protocol: z.literal(PROTOCOL), job: upgradeJobSchema })
    .strict();
export const statusFileSchema = z
    .object({
        protocol: z.literal(PROTOCOL),
        heartbeatAt: timestamp,
        status: supervisorStatusSchema,
        prunedJobIds: z.array(upgradeJobIdSchema).max(PRUNED_KEPT),
    })
    .strict();

export type RequestFile = z.infer<typeof requestFileSchema>;
export type JobFile = z.infer<typeof jobFileSchema>;
export type StatusFile = z.infer<typeof statusFileSchema>;

/** The size each file may be; a reader refuses anything larger without reading it all. */
export const BOUNDS = {
    request: 4 * 1024,
    job: 64 * 1024,
    status: 256 * 1024,
} as const;

/** Diagnostics the supervisor writes per job or status, under Ghost's bound of 200. */
export const DIAGNOSTICS_KEPT = 10;

/** How old an unclaimed request may be, and how far in the future its time may be. */
export const REQUEST_MAX_AGE_MS = 10 * 60_000;
export const REQUEST_MAX_SKEW_MS = 60_000;

/** After this long without a heartbeat, Ghost reports the supervisor `stale`. */
export const STALE_AFTER_MS = 60_000;
export const HEARTBEAT_MS = 15_000;

export const SOURCE = 'ghost-docker';

// --- Job IDs ------------------------------------------------------------------

/** The UUIDv5 namespace of job IDs: uuidv5(URL, the protocol's #job-ids URL). */
export const JOB_ID_NAMESPACE = 'db929a3c-305a-5054-8c02-a790ee3e514a';

/** RFC 9562 UUIDv5 of `name` in `namespace`, lowercase. */
export function uuidv5(namespace: string, name: string): string {
    const hash = createHash('sha1')
        .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
        .update(Buffer.from(name, 'utf8'))
        .digest();
    const bytes = hash.subarray(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x50;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The job a request's idempotency key names, on both ends. */
export const jobIdOf = (idempotencyKey: string): string => uuidv5(JOB_ID_NAMESPACE, idempotencyKey);

/** A key as Ghost makes one: a sha256 in lowercase hex. Used for requests made by hand. */
export const randomIdempotencyKey = (): string =>
    createHash('sha256').update(randomBytes(32)).digest('hex');

/** `<uuid>.json`: the only names either end reads in the exchange. */
export const JOB_FILE_NAME =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

// --- Reading and writing the exchange -----------------------------------------

export class ExchangeFileError extends Error {}

export interface ExchangeRead {
    readonly text: string;
    readonly mtimeMs: number;
}

/**
 * A file of the exchange, refused unless it is a regular file with one link,
 * not a symlink, and within `bound` bytes. Read at most `bound + 1` bytes, so
 * an oversize file is never read whole. Undefined when it does not exist.
 */
export function readExchangeFile(path: string, bound: number): ExchangeRead | undefined {
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
        const errno = (error as NodeJS.ErrnoException).code;
        if (errno === 'ENOENT') {
            return undefined;
        }
        if (errno === 'ELOOP') {
            throw new ExchangeFileError(`${path} is a symbolic link`);
        }
        throw error;
    }
    try {
        const stats = fstatSync(fd);
        if (!stats.isFile()) {
            throw new ExchangeFileError(`${path} is not a regular file`);
        }
        if (stats.nlink !== 1) {
            throw new ExchangeFileError(`${path} has ${stats.nlink} links`);
        }
        if (stats.size > bound) {
            throw new ExchangeFileError(`${path} is larger than ${bound} bytes`);
        }
        const buffer = Buffer.alloc(bound + 1);
        let length = 0;
        for (;;) {
            const read = readSync(fd, buffer, length, buffer.length - length, null);
            if (read === 0) {
                break;
            }
            length += read;
            if (length > bound) {
                throw new ExchangeFileError(`${path} is larger than ${bound} bytes`);
            }
        }
        return { text: buffer.subarray(0, length).toString('utf8'), mtimeMs: stats.mtimeMs };
    } finally {
        closeSync(fd);
    }
}

/** `schema` parsed from a file's JSON, or an ExchangeFileError saying why not. */
export function parseExchangeFile<T>(schema: z.ZodType<T>, read: ExchangeRead, path: string): T {
    let value: unknown;
    try {
        value = JSON.parse(read.text);
    } catch {
        throw new ExchangeFileError(`${path} is not JSON`);
    }
    const result = schema.safeParse(value);
    if (!result.success) {
        const issue = result.error.issues[0];
        throw new ExchangeFileError(
            `${path} does not match protocol ${PROTOCOL}: ${issue?.path.join('.') || '(root)'} ${issue?.message ?? ''}`.trim(),
        );
    }
    return result.data;
}

function writeTemporary(dir: string, content: string, mode: number): string {
    const temporary = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try {
        // Whatever the umask: the other end reads it through these bits.
        fchmodSync(fd, mode);
        writeSync(fd, Buffer.from(content, 'utf8'));
        fsyncSync(fd);
    } catch (error) {
        closeSync(fd);
        rmSync(temporary, { force: true });
        throw error;
    }
    closeSync(fd);
    return temporary;
}

function syncDirectory(dir: string): void {
    const fd = openSync(dir, constants.O_RDONLY);
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

const serialize = (value: unknown, bound: number, name: string): string => {
    const content = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(content) > bound) {
        throw new ExchangeFileError(`${name} would be larger than its ${bound}-byte bound`);
    }
    return content;
};

/** The supervisor's write: replace `dir/name` atomically, readable by Ghost. */
export function publishExchangeFile(
    dir: string,
    name: string,
    value: unknown,
    bound: number,
): void {
    const temporary = writeTemporary(dir, serialize(value, bound, name), 0o644);
    try {
        renameSync(temporary, join(dir, name));
    } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    }
    syncDirectory(dir);
}

/**
 * Ghost's write, also used for requests made by hand: create `dir/name`
 * only if it does not exist. False when it does.
 */
export function createExchangeFile(
    dir: string,
    name: string,
    value: unknown,
    bound: number,
): boolean {
    const temporary = writeTemporary(dir, serialize(value, bound, name), 0o640);
    try {
        linkSync(temporary, join(dir, name));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            return false;
        }
        throw error;
    } finally {
        rmSync(temporary, { force: true });
    }
    syncDirectory(dir);
    return true;
}
