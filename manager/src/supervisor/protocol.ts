// The upgrade supervisor's HTTP protocol, version 1: docs/upgrade-supervisor.md.
//
// The bodies are Ghost's own upgrade schemas, from @tryghost/adapter-base-upgrade,
// the package Ghost's adapter is built on, so the two ends cannot describe a
// body differently. The protocol adds only the transport: the socket, the
// paths and the status codes.
import { createHash, randomBytes } from 'node:crypto';
import {
    finalUpgradeStates,
    manualUpdateSchema,
    oneClickUpdateSchema,
    upgradeDiagnosticsSchema,
    upgradeErrorCodeSchema,
    upgradeJobIdSchema,
    upgradeVersionSchema,
    type UpgradeState,
} from '@tryghost/adapter-base-upgrade';
import { z } from 'zod';

export const PROTOCOL = 1;

/** Where the supervisor listens, in the volume Ghost mounts read-only. */
export const SOCKET_DIR = '/run/ghost-upgrade';
export const SOCKET_PATH = `${SOCKET_DIR}/supervisor.sock`;

/** The largest request body either end sends or accepts. */
export const BODY_MAX = 4 * 1024;

/** How long Ghost, and the hand tooling, wait for an answer. */
export const CLIENT_TIMEOUT_MS = 5_000;

// --- Ghost's schemas ------------------------------------------------------------

// Pinned to an exact alpha: any alpha may change the contract.
export {
    activeUpgradeStates,
    createUpgradeRequestSchema,
    finalUpgradeStates,
    manualUpdateSchema,
    oneClickUpdateSchema,
    upgradeComponentSchema,
    upgradeDiagnosticSchema,
    upgradeDiagnosticsSchema,
    upgradeErrorCodeSchema,
    upgradeJobIdSchema,
    upgradeJobResultSchema,
    upgradeJobSchema,
    upgradeStatusSchema,
    upgradeVersionSchema,
} from '@tryghost/adapter-base-upgrade';
export type {
    ManualUpdate,
    OneClickUpdate,
    UpgradeDiagnostic,
    UpgradeJob,
    UpgradeJobResult,
    UpgradeState,
} from '@tryghost/adapter-base-upgrade';
export type { CreateUpgradeRequest as UpgradeRequest } from '@tryghost/adapter-base-upgrade';

export type FinalState = (typeof finalUpgradeStates)[number];

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
