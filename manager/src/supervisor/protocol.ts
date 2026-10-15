// The upgrade supervisor's HTTP protocol, version 1: docs/upgrade-supervisor.md.
//
// The bodies are Ghost's own upgrade schemas (@tryghost/adapter-base-upgrade,
// packages/adapters/upgrade-base/src/schemas.ts in Ghost), copied field for
// field until that package is published and the manager can depend on it.
// Keep the copy exact: a field that differs here is a body Ghost's adapter
// refuses. The protocol adds only the transport: the socket, the paths and
// the status codes.
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const PROTOCOL = 1;

/** Where the supervisor listens, in the volume Ghost mounts read-only. */
export const SOCKET_DIR = '/run/ghost-upgrade';
export const SOCKET_PATH = `${SOCKET_DIR}/supervisor.sock`;

/** The largest request body either end sends or accepts. */
export const BODY_MAX = 4 * 1024;

/** How long Ghost, and the hand tooling, wait for an answer. */
export const CLIENT_TIMEOUT_MS = 5_000;

// --- Ghost's schemas, as they are --------------------------------------------

export const upgradeVersionSchema = z.string().min(1).max(128);
// An opaque token; this protocol uses the request's idempotency key.
export const upgradeJobIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
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

export const upgradeStatusSchema = z.discriminatedUnion('supported', [
    z.object({
        supported: z.literal(false),
        reason: z.enum(['not-configured', 'not-supported']),
    }),
    z
        .object({
            supported: z.literal(true),
            availability: z.enum(['ready', 'busy', 'unavailable', 'stale', 'incompatible']),
            backupRequired: z.boolean().optional(),
            currentVersion: upgradeVersionSchema.optional(),
            oneClick: z.array(oneClickUpdateSchema).max(50).default([]),
            manual: z.array(manualUpdateSchema).max(50).default([]),
            activeJobId: upgradeJobIdSchema.nullable().optional(),
            pollAfterMs: z.int().min(1000).max(60000).optional(),
            diagnostics: upgradeDiagnosticsSchema.optional(),
        })
        .refine(
            (status) => status.availability !== 'ready' || status.backupRequired !== undefined,
            {
                message: 'A ready host must report its backup policy.',
                path: ['backupRequired'],
            },
        ),
]);

export const upgradeJobResultSchema = z.union([
    upgradeJobSchema,
    z.object({ id: upgradeJobIdSchema, state: z.enum(['unknown', 'expired']) }),
]);

export const upgradeErrorCodeSchema = z.enum([
    'unsupported',
    'unavailable',
    'busy',
    'target-unapproved',
    'idempotency-conflict',
    'request-expired',
]);

export type UpgradeDiagnostic = z.infer<typeof upgradeDiagnosticSchema>;
export type OneClickUpdate = z.infer<typeof oneClickUpdateSchema>;
export type ManualUpdate = z.infer<typeof manualUpdateSchema>;
export type UpgradeRequest = z.infer<typeof createUpgradeRequestSchema>;
export type UpgradeJob = z.infer<typeof upgradeJobSchema>;
export type UpgradeState = UpgradeJob['state'];
export type FinalState = (typeof finalUpgradeStates)[number];
export type UpgradeJobResult = z.infer<typeof upgradeJobResultSchema>;

export const isFinal = (state: UpgradeState): state is FinalState =>
    (finalUpgradeStates as readonly string[]).includes(state);

// --- What the supervisor answers ------------------------------------------------

/** Ghost's status as the supervisor reports it: never `stale` or `incompatible`, which Ghost decides. */
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

export const handshakeSchema = z.object({ protocol: z.literal(PROTOCOL) });

/** The codes of error responses: Ghost's, and the transport's own. */
export const errorCodeSchema = z.union([
    upgradeErrorCodeSchema,
    z.enum(['malformed', 'not-found', 'method-not-allowed', 'too-large']),
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorBodySchema = z.object({
    error: z.object({ code: errorCodeSchema, diagnostics: upgradeDiagnosticsSchema.optional() }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** The status each error code answers with (docs/upgrade-supervisor.md#the-api). */
export const ERROR_STATUS: Record<ErrorCode, number> = {
    malformed: 400,
    'not-found': 404,
    'method-not-allowed': 405,
    busy: 409,
    'idempotency-conflict': 409,
    'request-expired': 410,
    'too-large': 413,
    'target-unapproved': 422,
    unavailable: 503,
    unsupported: 501,
};

/** IDs of pruned jobs kept, so a lookup or replay of one answers `expired`. */
export const PRUNED_KEPT = 50;

/** Diagnostics the supervisor writes per job or status, under Ghost's bound of 200. */
export const DIAGNOSTICS_KEPT = 10;

export const SOURCE = 'ghost-docker';

// --- Job IDs ------------------------------------------------------------------

/**
 * The job a request's idempotency key names: the key itself, so a replay
 * finds its job (docs/upgrade-supervisor.md#job-ids).
 */
export const jobIdOf = (idempotencyKey: string): string => idempotencyKey;

/** A key as Ghost makes one: a sha256 in lowercase hex. Used for requests made by hand. */
export const randomIdempotencyKey = (): string =>
    createHash('sha256').update(randomBytes(32)).digest('hex');
