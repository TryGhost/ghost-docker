// A production site's Caddy routes, written once by `install` (docs/caddy.md).
//
//   caddy/Caddyfile        tracked, generic; imports the directories below
//   caddy/sites/site.caddy written by install, then the operator's to edit
//   caddy/custom/*.caddy   the operator's own sites
//   caddy/global/*.caddy   the operator's global options
//   caddy/snippets/*       imported by absolute path, with arguments
//
// After installation the manager never rewrites site.caddy, as Ghost-CLI
// never rewrote the nginx file it generated.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './fs.ts';

export const SITE_FILE = join('caddy', 'sites', 'site.caddy');
const HOSTED_ACTIVITYPUB = 'https://ap.ghost.org';

/** A hostname, as Caddy's site address and our own rules accept it. */
const HOSTNAME =
    /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
export const isHostname = (value: string): boolean => HOSTNAME.test(value);

/** Rendered into a Caddyfile, so it is held to what an address can contain. */
export const ACME_EMAIL = /^[^\s@{}"#;]+@[^\s@{}"#;]+\.[^\s@{}"#;]+$/;

export interface RouteOptions {
    readonly project: string;
    readonly domain: string;
    readonly adminDomain: string;
    /** The ACME account, rendered as `tls <email>`; empty for none. */
    readonly email: string;
    readonly activitypub: boolean;
}

/** The routes' template, with `{{name}}` placeholders. */
const TEMPLATE = new URL('../templates/site.caddy', import.meta.url);

/** Fill `{{name}}` placeholders; an unknown one is a bug, not an empty string. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
        const value = values[name];
        if (value === undefined) {
            throw new Error(`template placeholder {{${name}}} has no value`);
        }
        return value;
    });
}

/**
 * The routes for a production site, one block serving the site's domain and
 * its admin domain. Every snippet is imported with every argument it takes:
 * an omitted one only produces a Caddy warning, and ships a site that
 * misbehaves at runtime. Upstreams are the site's unique network aliases,
 * never bare service names. Without an email the `tls` line is left
 * commented out, as the place to add one.
 */
export function renderRoutes(site: RouteOptions): string {
    return fill(readFileSync(TEMPLATE, 'utf8'), {
        project: site.project,
        addresses: [site.domain, site.adminDomain].filter(Boolean).join(', '),
        tls: site.email ? `tls ${site.email}` : '# tls you@example.com',
        activitypub: site.activitypub ? `activitypub-${site.project}:8080` : HOSTED_ACTIVITYPUB,
        adminDomain: site.adminDomain,
    });
}

/** Write the routes into the site. Returns the path written. */
export function writeRoutes(dir: string, site: RouteOptions): string {
    const path = join(dir, SITE_FILE);
    atomicWrite(path, renderRoutes(site), 0o644);
    return path;
}
