// The operator's own Caddyfile from the released `main` layout, carried into
// this layout's routes (docs/install.md#moving-from-the-released-main-layout).
//
// On `main`, caddy/Caddyfile was copied from Caddyfile.example and then edited
// by hand. It read DOMAIN, ADMIN_DOMAIN and ACTIVITYPUB_TARGET from Caddy's
// environment, imported snippets by relative path with no arguments, and
// proxied to bare service names. This layout gives Caddy no environment, its
// snippets take arguments, and upstreams are the site's unique aliases. The
// translation changes exactly those things and keeps everything else the
// operator wrote, so their routes keep working; Caddy itself then validates
// the result before anything live is changed.
import { join } from 'node:path';

/** The original, kept beside the routes it became; .gitignore leaves it out. */
export const LEGACY_CADDYFILE = join('caddy', 'Caddyfile');
export const KEPT_CADDYFILE = join('caddy', 'Caddyfile.local');
/** A global options block, which this layout's Caddyfile imports from caddy/global/. */
export const GLOBAL_FILE = join('caddy', 'global', 'legacy.caddy');

/** Services whose bare `name:port` is rewritten to the site's unique alias. */
const ALIASED = ['ghost', 'db', 'traffic-analytics', 'activitypub'] as const;

/** What the old Caddy container's environment held, as Compose set it on `main`. */
export interface LegacyCaddyValues {
    readonly project: string;
    readonly domain: string;
    readonly adminDomain: string;
    /** ACTIVITYPUB_TARGET, already pointing at the site's alias when it was `activitypub:8080`. */
    readonly activitypub: string;
}

export interface TranslatedCaddyfile {
    /** caddy/sites/site.caddy. */
    readonly site: string;
    /** The global options block's body, for GLOBAL_FILE; null when there was none. */
    readonly global: string | null;
    /** What was changed, for the operator. */
    readonly changes: readonly string[];
}

/** A Caddyfile this cannot carry over automatically; nothing has been changed. */
export class UntranslatableCaddyfile extends Error {}

/** Snippets the stack ships, and the arguments each now takes, in order. */
function snippetArguments(name: string, values: LegacyCaddyValues): string | null {
    switch (name) {
        case 'Logging':
            return '';
        case 'TrafficAnalytics':
            return ` traffic-analytics-${values.project}:3000`;
        case 'ActivityPub':
            return ` ${values.activitypub}`;
        case 'SecurityHeaders':
            return ` "${values.adminDomain}"`;
        default:
            return null;
    }
}

/** Splits a line into its code and its comment: `#` starts one only at a token's start. */
function splitComment(line: string): { code: string; comment: string } {
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        const char = line[i]!;
        if (char === '\\') {
            i += 1;
        } else if (char === '"') {
            quoted = !quoted;
        } else if (char === '#' && !quoted && (i === 0 || /\s/.test(line[i - 1]!))) {
            return { code: line.slice(0, i), comment: line.slice(i) };
        }
    }
    return { code: line, comment: '' };
}

/**
 * `{$NAME}` and `{$NAME:default}` are substituted when the file is loaded,
 * `{env.NAME}` when a request is served. Both read Caddy's environment, which
 * no longer holds these three.
 */
function substituteEnvironment(code: string, values: LegacyCaddyValues): string {
    const known: Record<string, string> = {
        DOMAIN: values.domain,
        ADMIN_DOMAIN: values.adminDomain,
        ACTIVITYPUB_TARGET: values.activitypub,
    };
    return code
        .replace(/\{\$([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g, (whole, name: string, fallback) =>
            name in known ? known[name] || (fallback ?? '') : whole,
        )
        .replace(/\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
            name in known ? known[name]! : whole,
        );
}

const ALIAS = new RegExp(
    `(^|[\\s/])(${ALIASED.map((name) => name.replace('-', '\\-')).join('|')}):(\\d+)(?=$|[\\s/])`,
    'g',
);

/**
 * An import of a shipped snippet gains its absolute path and arguments; any
 * other relative import is made absolute, since it now sits in caddy/sites/
 * rather than beside the Caddyfile it was relative to. Named snippets the
 * file defines are left alone.
 */
function rewriteImport(
    code: string,
    values: LegacyCaddyValues,
    named: ReadonlySet<string>,
    changes: Set<string>,
): string {
    const match = /^(\s*)import(\s+)(\S+)(.*)$/.exec(code);
    if (match === null) {
        return code;
    }
    const [, indent, space, path, rest] = match as unknown as [
        string,
        string,
        string,
        string,
        string,
    ];
    if (named.has(path)) {
        return code;
    }
    const snippet = /^(?:\.\/|\/etc\/caddy\/)?snippets\/([A-Za-z]+)$/.exec(path);
    if (snippet !== null) {
        const name = snippet[1]!;
        const args = snippetArguments(name, values);
        if (args !== null) {
            if (rest.trim() !== '') {
                throw new UntranslatableCaddyfile(
                    `caddy/Caddyfile imports snippets/${name} with arguments (${rest.trim()}); on main it took none,\n` +
                        '  so it cannot be told what they were meant to be.',
                );
            }
            changes.add('snippet imports given their absolute paths and arguments');
            return `${indent}import${space}/etc/caddy/snippets/${name}${args}`;
        }
    }
    if (path.startsWith('/')) {
        return code;
    }
    changes.add('relative imports made absolute');
    return `${indent}import${space}/etc/caddy/${path.replace(/^\.\//, '')}${rest}`;
}

/** Does this line's code open a block, close one, or neither? */
function braces(code: string): { opens: boolean; closes: boolean } {
    const tokens = code.trim().split(/\s+/);
    return {
        opens: tokens.at(-1) === '{',
        closes: tokens[0] === '}',
    };
}

/**
 * The operator's Caddyfile, as routes for this layout. Throws
 * UntranslatableCaddyfile for what it cannot carry over; Caddy validates the
 * rest before anything is written.
 */
export function translateCaddyfile(text: string, values: LegacyCaddyValues): TranslatedCaddyfile {
    if (/<<[A-Za-z]/.test(text)) {
        throw new UntranslatableCaddyfile(
            'caddy/Caddyfile uses a heredoc, which this migration does not translate',
        );
    }
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const named = new Set(
        lines
            .map((line) => /^\s*\(([^)\s]+)\)\s*\{\s*$/.exec(splitComment(line).code)?.[1])
            .filter((name): name is string => name !== undefined),
    );
    const changes = new Set<string>();

    const site: string[] = [];
    const global: string[] = [];
    let depth = 0;
    /** In the global options block, which is the first block and has no address. */
    let inGlobal = false;
    let seenBlock = false;
    for (const line of lines) {
        const { code: original, comment } = splitComment(line);
        let code = substituteEnvironment(original, values);
        if (code !== original) {
            changes.add(
                '{$DOMAIN}, {$ADMIN_DOMAIN} and {$ACTIVITYPUB_TARGET} replaced by their values',
            );
        }
        const aliased = code.replace(
            ALIAS,
            (_, before: string, service: string, port: string) =>
                `${before}${service}-${values.project}:${port}`,
        );
        if (aliased !== code) {
            changes.add('bare service upstreams pointed at the site’s unique aliases');
            code = aliased;
        }
        code = rewriteImport(code, values, named, changes);
        const { opens, closes } = braces(code);

        if (depth === 0 && opens) {
            // Only a block written with no address is global options: one
            // whose address is a variable that turned out empty is a mistake.
            if (original.trim() === '{' && !seenBlock) {
                inGlobal = true;
                seenBlock = true;
                depth += 1;
                changes.add(`the global options block moved to ${GLOBAL_FILE}`);
                continue;
            }
            const addresses = code
                .trim()
                .slice(0, -1)
                .trim()
                .split(/\s*,\s*|\s+/);
            if (addresses.some((address) => address === '')) {
                throw new UntranslatableCaddyfile(
                    `caddy/Caddyfile has a site block with an empty address once DOMAIN and ADMIN_DOMAIN are\n` +
                        `  filled in (${original.trim()}). Set ADMIN_DOMAIN in .env, or remove that block.`,
                );
            }
        }
        if (closes) {
            depth -= 1;
            if (depth < 0) {
                throw new UntranslatableCaddyfile(
                    'caddy/Caddyfile closes more blocks than it opens',
                );
            }
            if (depth === 0 && inGlobal) {
                inGlobal = false;
                continue;
            }
        }
        if (opens) {
            depth += 1;
            seenBlock = true;
        }
        if (inGlobal) {
            // One level shallower: the stack's Caddyfile supplies the braces.
            global.push(`${code}${comment}`.replace(/^\t/, ''));
        } else {
            site.push(`${code}${comment}`);
        }
    }
    if (depth !== 0) {
        throw new UntranslatableCaddyfile('caddy/Caddyfile opens more blocks than it closes');
    }

    const header = [
        `# Routes for ${values.project}, carried over from caddy/Caddyfile, which is kept as`,
        '# caddy/Caddyfile.local. This file is yours: edit it, then reload Caddy:',
        '#',
        '#   docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile',
        '#',
        '# docs/caddy.md lists the snippets and the arguments each one takes.',
        '',
    ];
    return {
        site: `${[...header, ...site].join('\n').trimEnd()}\n`,
        global:
            global.length === 0
                ? null
                : `# Global options carried over from caddy/Caddyfile.\n${global.join('\n').trimEnd()}\n`,
        changes: [...changes],
    };
}
