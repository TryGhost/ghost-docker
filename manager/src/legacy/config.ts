// The released `main` layout's single `.env`, split into this layout's `.env`
// and `ghost.env` (docs/install.md#moving-from-the-released-main-layout).
//
// On `main`, `.env` was both Compose's interpolation source and the ghost
// service's env_file, so every key in it reached Ghost. Here operator settings
// stay in `.env`, which Ghost never sees, and Ghost's own configuration moves
// to `ghost.env`. Which is which is decided the way `config validate` decides
// it (config.ts): a key Compose interpolates, or an example documents, is an
// operator setting; anything else was there for Ghost.
import * as env from '../env.ts';
import { CliError } from '../errors.ts';
import { isContainerOwned } from '../import/config.ts';

/**
 * Keys `main` read that this layout replaces: URL and ADMIN_URL, and the
 * ActivityPub upstream now written into the Caddy route. Kept only when an
 * override of the operator's still interpolates them.
 */
export const SUPERSEDED = ['DOMAIN', 'ADMIN_DOMAIN', 'ACTIVITYPUB_TARGET'] as const;

/** The old `.env`, read as Compose read it. */
export interface LegacyEnv {
    readonly values: Readonly<Record<string, string>>;
    /** Every key, in the order of its first assignment. */
    readonly keys: readonly string[];
}

export function readLegacyEnv(text: string): LegacyEnv {
    const multiline = env.scan(text).filter((assignment) => assignment.quoting === 'multiline');
    if (multiline.length > 0) {
        throw new CliError(
            `.env has values spanning several lines (${multiline.map(({ key }) => key).join(', ')}), which this\n` +
                '  migration does not carry over. Put each on one line, then run it again. Nothing has been changed.',
        );
    }
    return { values: env.toRecord(text), keys: env.keys(text) };
}

export interface SplitInput {
    readonly legacy: LegacyEnv;
    /** Keys this migration writes itself, from what it has worked out. */
    readonly generated: ReadonlySet<string>;
    /** Is the key an operator setting, in the old layout or this one? */
    readonly isOperatorKey: (key: string) => boolean;
    /** Does this layout's compose.yml, with the operator's overrides, still interpolate it? */
    readonly isInterpolated: (key: string) => boolean;
    /** What this layout's ghost service sets itself, by key. */
    readonly container: ReadonlySet<string>;
    /**
     * What Ghost actually received for each key on `main`, as Compose resolved
     * it: env_file values are interpolated, so this, not the text, is the value.
     */
    readonly received: Readonly<Record<string, string>>;
}

export interface SplitEnv {
    /** Operator settings carried into `.env`, besides the generated ones. */
    readonly operator: [string, string][];
    /** Ghost configuration for `ghost.env`. */
    readonly ghost: [string, string][];
    /** Keys left out, with why. Names only: values may be credentials. */
    readonly dropped: { key: string; reason: string }[];
}

export function splitLegacyEnv({
    legacy,
    generated,
    isOperatorKey,
    isInterpolated,
    container,
    received,
}: SplitInput): SplitEnv {
    const operator: [string, string][] = [];
    const ghost: [string, string][] = [];
    const dropped: { key: string; reason: string }[] = [];
    for (const key of legacy.keys) {
        const value = legacy.values[key]!;
        if (generated.has(key)) {
            continue;
        }
        if ((SUPERSEDED as readonly string[]).includes(key) && !isInterpolated(key)) {
            dropped.push({ key, reason: 'replaced by URL, ADMIN_URL and the Caddy routes' });
        } else if (key.startsWith('COMPOSE_') || isOperatorKey(key)) {
            operator.push([key, value]);
        } else if (isContainerOwned(key, container)) {
            dropped.push({
                key,
                reason: 'set by the container, which took precedence on main too',
            });
        } else {
            ghost.push([key, received[key] ?? value]);
        }
    }
    return { operator, ghost, dropped };
}

/**
 * Operator settings whose value Compose would interpolate: a `$` that is not
 * doubled. What Compose made of it is not knowable from the text alone, so the
 * operator says what was meant, rather than this migration guessing.
 */
export function refuseInterpolated(text: string, operatorKeys: ReadonlySet<string>): void {
    const keys = env.lint(text).filter((key) => operatorKeys.has(key));
    if (keys.length > 0) {
        throw new CliError(
            `.env has values with an unescaped $ (${keys.join(', ')}), which Compose interpolates, so what\n` +
                '  they hold cannot be carried over exactly. Write each literal $ as $$, check the site still\n' +
                '  starts (docker compose up -d), then run this again. Nothing has been changed.',
        );
    }
}
