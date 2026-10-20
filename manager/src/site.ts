// A site directory: its files, its mode, and the profiles that select it.
import { join } from 'node:path';
import * as env from './env.ts';
import { readIfExists } from './fs.ts';
import type { ResolvedGhost } from './ghost.ts';

export const ENV_FILE = '.env';
export const ENV_EXAMPLE_FILE = '.env.example';
export const GHOST_ENV_FILE = 'ghost.env';
export const META_FILE = '.ghost-docker.json';
export const COMPOSE_FILE = 'compose.yml';
/** The operator's own overrides; plain Compose merges it, so the manager does too. */
export const COMPOSE_OVERRIDE_FILE = 'compose.override.yml';
/** Held while an operation changes the site (lock.ts). */
export const LOCK_FILE = '.ghost-docker.lock';
/** What an update keeps to put back if it fails, removed when it succeeds. */
export const UPDATE_DIR = '.ghost-docker-update';
/** Where `backup` writes, one directory per backup; kept until the operator removes them. */
export const BACKUPS_DIR = 'backups';
/** The upgrade supervisor's own records, which Ghost never sees (docs/upgrade-supervisor.md). */
export const SUPERVISOR_DIR = '.ghost-docker-supervisor';
/** What a restore over a site keeps of it until the restore is verified. */
export const RESTORE_DIR = '.ghost-docker-restore';
/**
 * Files and directories that belong to the operator: an update keeps a copy
 * of them, and a checkout of another ref never touches them (docs/architecture.md#releases-and-compatibility).
 */
export const OPERATOR_FILES = [
    ENV_FILE,
    GHOST_ENV_FILE,
    META_FILE,
    COMPOSE_OVERRIDE_FILE,
    join('caddy', 'sites'),
    join('caddy', 'custom'),
    join('caddy', 'global'),
] as const;

/**
 * The bind-mounted data directories, at compose.yml's defaults
 * (UPLOAD_LOCATION, MYSQL_DATA_LOCATION), which install never changes.
 */
export const DATA_DIRS = [join('data', 'ghost'), join('data', 'mysql')] as const;

/** Mailpit's inbox, at compose.yml's default (MAILPIT_DATA_LOCATION); only a mailpit site has it. */
export const MAILPIT_DATA_DIR = join('data', 'mailpit');

/** The two files `config` reads and writes. Nothing else is an env file here. */
export const CONFIG_FILES = [ENV_FILE, GHOST_ENV_FILE] as const;
export type ConfigFile = (typeof CONFIG_FILES)[number];

export const SITE_MODES = ['local', 'production'] as const;
export type SiteMode = (typeof SITE_MODES)[number];

/** Additive, per-site. `supervisor` runs the upgrade supervisor (docs/upgrade-supervisor.md). */
export const OPTIONAL_PROFILES = ['analytics', 'activitypub', 'mailpit', 'supervisor'] as const;

/**
 * Optional profiles a production site must not select: Mailpit would catch
 * the site's real mail.
 */
export const LOCAL_ONLY_PROFILES = ['mailpit'] as const;

/**
 * Optional profiles a local site must not select: Ghost is published
 * directly, and only Caddy's routes reach their services.
 */
export const PRODUCTION_ONLY_PROFILES = ['analytics', 'activitypub'] as const;

/** Why a site of `mode` must not select `profile`, or null when it may. */
export function profileConflict(mode: SiteMode, profile: string): string | null {
    if (mode === 'production' && (LOCAL_ONLY_PROFILES as readonly string[]).includes(profile)) {
        return "is for local sites only: it would catch a production site's real mail";
    }
    if (mode === 'local' && (PRODUCTION_ONLY_PROFILES as readonly string[]).includes(profile)) {
        return 'is for production sites only: a local site has no Caddy to route to it';
    }
    return null;
}

/** `production, analytics` as a list: trimmed, empties dropped. */
export const splitProfiles = (profiles: string): string[] =>
    profiles
        .split(',')
        .map((profile) => profile.trim())
        .filter((profile) => profile !== '');

/**
 * The single site mode a COMPOSE_PROFILES value names, or null when it names
 * none or more than one. Optional profiles never select a mode.
 */
export function siteMode(profiles: string): SiteMode | null {
    const modes = splitProfiles(profiles).filter((profile): profile is SiteMode =>
        (SITE_MODES as readonly string[]).includes(profile),
    );
    return modes.length === 1 ? modes[0]! : null;
}

/** Profiles that are neither a site mode nor a known optional profile. */
export const unknownProfiles = (profiles: string): string[] =>
    splitProfiles(profiles).filter(
        (profile) =>
            !(SITE_MODES as readonly string[]).includes(profile) &&
            !(OPTIONAL_PROFILES as readonly string[]).includes(profile),
    );

export const hasProfile = (profiles: string, profile: string): boolean =>
    splitProfiles(profiles).includes(profile);

/** What `.env` says, decoded. Empty when there is no `.env`. */
export interface SiteSettings {
    readonly get: (key: string) => string | undefined;
}

export function readSettings(dir: string): SiteSettings | null {
    const text = readIfExists(join(dir, ENV_FILE));
    if (text === undefined) {
        return null;
    }
    const values = env.toRecord(text);
    return { get: (key) => values[key] };
}

/** What `.env` records for every site this layout writes, in the order it is written. */
export function generatedSettings(input: {
    readonly mode: SiteMode;
    readonly profiles: readonly string[];
    readonly project: string;
    readonly dir: string;
    readonly url: string;
    /** Empty for none. */
    readonly adminUrl: string;
    readonly ghost: Pick<
        ResolvedGhost,
        'image' | 'tag' | 'reference' | 'contentPath' | 'tinybirdPath'
    >;
    readonly port: number;
    readonly mailpitPort: number | null;
    /** Caddy's, written for a production site. */
    readonly ports: { readonly http: string; readonly https: string };
    readonly database: {
        readonly user: string;
        readonly password: string;
        readonly rootPassword: string;
    };
}): [string, string][] {
    const { ghost, database } = input;
    const production = input.mode === 'production';
    return Object.entries({
        COMPOSE_PROFILES: input.profiles.join(','),
        SITE_MODE: input.mode,
        COMPOSE_PROJECT_NAME: input.project,
        PROJECT_DIR: input.dir,
        NODE_ENV: production ? 'production' : 'development',
        URL: input.url,
        ...(input.adminUrl ? { ADMIN_URL: input.adminUrl } : {}),
        GHOST_IMAGE: ghost.image,
        GHOST_VERSION: ghost.tag,
        GHOST_IMAGE_REF: ghost.reference,
        GHOST_CONTENT_PATH: ghost.contentPath,
        GHOST_TINYBIRD_PATH: ghost.tinybirdPath,
        GHOST_PORT: String(input.port),
        ...(input.mailpitPort === null ? {} : { MAILPIT_PORT: String(input.mailpitPort) }),
        RESTART_POLICY: production ? 'unless-stopped' : 'no',
        ...(production ? { HTTP_PORT: input.ports.http, HTTPS_PORT: input.ports.https } : {}),
        DATABASE_HOST: 'db',
        DATABASE_PORT: '3306',
        DATABASE_NAME: 'ghost',
        DATABASE_USER: database.user,
        DATABASE_PASSWORD: database.password,
        DATABASE_ROOT_PASSWORD: database.rootPassword,
    });
}

/** The hostname a URL names, or '' when it is not a URL. */
export const hostOf = (url: string): string => {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
};

/** Everything a command needs to know about a site, from `.env`. */
export interface SiteFacts {
    readonly dir: string;
    readonly mode: SiteMode | null;
    /** The hosts of URL and ADMIN_URL: what Caddy should serve, in production. */
    readonly domain: string;
    readonly adminDomain: string;
    readonly settings: SiteSettings;
}

export function siteFacts(dir: string, settings: SiteSettings): SiteFacts {
    const value = (key: string, fallback = '') => settings.get(key) || fallback;
    return {
        dir,
        settings,
        mode: siteMode(value('COMPOSE_PROFILES')),
        domain: hostOf(value('URL')),
        adminDomain: hostOf(value('ADMIN_URL')),
    };
}
