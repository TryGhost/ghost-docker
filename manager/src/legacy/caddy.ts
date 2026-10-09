// The operator's own Caddyfile from the released `main` layout, carried into
// this layout's routes as it is (docs/install.md#moving-from-the-released-main-layout).
//
// On `main`, caddy/Caddyfile was copied from Caddyfile.example and edited by
// hand. It read DOMAIN, ADMIN_DOMAIN and ACTIVITYPUB_TARGET from Caddy's
// environment and imported main's snippets, which take no arguments, by
// relative path. Here Caddy has no environment and the snippets take
// arguments. Rather than rewrite the operator's routes into this layout's
// shape, the file is kept as written: the three variables are filled in, and
// its snippet imports point at main's snippets, kept beside it. Bare service
// upstreams (`ghost:2368`) still resolve on the site's own network. Caddy
// itself then decides whether the result loads, before anything is changed.
import { join } from 'node:path';

/** The original, kept beside the routes it became; .gitignore leaves it out. */
export const LEGACY_CADDYFILE = join('caddy', 'Caddyfile');
export const KEPT_CADDYFILE = join('caddy', 'Caddyfile.local');
/** main's snippets, which the carried routes import. Not `*.caddy`, so never loaded as sites. */
export const LEGACY_SNIPPETS = join('caddy', 'sites', 'legacy-snippets');
/** A global options block, which this layout's Caddyfile imports from caddy/global/. */
export const GLOBAL_FILE = join('caddy', 'global', 'legacy.caddy');

/** What the old Caddy container's environment held, as main's compose.yml set it. */
export interface LegacyCaddyValues {
    readonly domain: string;
    readonly adminDomain: string;
    readonly activitypub: string;
}

export interface CarriedCaddyfile {
    /** caddy/sites/site.caddy. */
    readonly site: string;
    /** A leading global options block's body, for GLOBAL_FILE; null when there was none. */
    readonly global: string | null;
}

/**
 * `{$NAME}` and `{$NAME:default}`, filled in when the file is loaded, and
 * `{env.NAME}`, when a request is served: both read Caddy's environment,
 * which no longer holds these three. Anything else is left as written.
 */
export function fillEnvironment(text: string, values: LegacyCaddyValues): string {
    const known: Record<string, string> = {
        DOMAIN: values.domain,
        ADMIN_DOMAIN: values.adminDomain,
        ACTIVITYPUB_TARGET: values.activitypub,
    };
    return text
        .replace(/\{\$([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g, (whole, name: string, fallback) =>
            name in known ? known[name] || (fallback ?? '') : whole,
        )
        .replace(/\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
            name in known ? known[name]! : whole,
        );
}

/**
 * The operator's Caddyfile as caddy/sites/site.caddy. A global options block
 * must come first in Caddy's whole configuration, which the stack's
 * Caddyfile opens with its own, so one written first, `{` and `}` alone on
 * their lines, moves to caddy/global/. Whatever else does not load, Caddy says.
 */
export function carryCaddyfile(text: string, values: LegacyCaddyValues): CarriedCaddyfile {
    let routes = fillEnvironment(text.replace(/\r\n/g, '\n'), values).replace(
        /^([ \t]*import[ \t]+)(?:\.\/)?snippets\//gm,
        `$1/etc/caddy/sites/legacy-snippets/`,
    );
    let global: string | null = null;
    const lines = routes.split('\n');
    const first = lines.findIndex((line) => line.trim() !== '' && !line.trim().startsWith('#'));
    if (first >= 0 && lines[first]!.trim() === '{') {
        const close = lines.findIndex((line, index) => index > first && line === '}');
        if (close > first) {
            global = `# Global options carried over from caddy/Caddyfile.\n${lines
                .slice(first + 1, close)
                .map((line) => line.replace(/^\t/, ''))
                .join('\n')
                .trim()}\n`;
            routes = [...lines.slice(0, first), ...lines.slice(close + 1)].join('\n');
        }
    }
    const header = [
        '# Routes carried over from caddy/Caddyfile, which is kept as caddy/Caddyfile.local.',
        '# They import the released main layout’s snippets, kept in legacy-snippets/ beside',
        '# this file. This file is yours: edit it, then reload Caddy:',
        '#',
        '#   docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile',
        '',
    ];
    return { site: `${[...header, routes.trim()].join('\n')}\n`, global };
}
