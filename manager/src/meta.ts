// `.ghost-docker.json`: what an operation needs to know about a site that its
// configuration does not say. When it was installed, from which stack release
// and how, the exact Ghost image that was resolved, the files the manager
// wrote, and which migrations have completed.
//
// Machine generated, gitignored, private. The manager is its only reader and
// writer: it writes atomically, refuses a document without the right
// schemaVersion, and refuses to read one from a newer schema rather than
// misreading it. A site without the file is a supported state, "installed
// before metadata was recorded", not a broken site.
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWrite, PRIVATE, readIfExists } from './fs.ts';
import { META_FILE, OPERATOR_FILES, SITE_MODES } from './site.ts';
import { CliError } from './errors.ts';

export const SCHEMA_VERSION = 1;

/** A field nobody supplied is null, so "not known" and "empty" stay distinct. */
const nullable = z.string().min(1).nullable();

export const metadataSchema = z.strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    installedAt: z.iso.datetime(),
    /** When `update` last completed; null until it has. */
    updatedAt: z.iso.datetime().nullable().default(null),
    mode: z.enum(SITE_MODES),
    channel: z.enum(['stable', 'beta', 'edge']).nullable(),
    // `image`: the payload was written from the manager image. `checkout`: the
    // site is a clone of the repository and its files are used in place.
    source: z.enum(['image', 'checkout']),
    stack: z.strictObject({
        version: nullable,
        commit: nullable,
        ref: nullable,
        /** The manager image that installed the site, as the site's launcher runs it. */
        image: nullable,
        /**
         * What the site ran before its last update: the release, commit and
         * manager image an update recovers to. Null until the first update.
         */
        previous: z
            .strictObject({ version: nullable, commit: nullable, image: nullable })
            .nullable()
            .default(null),
    }),
    site: z.strictObject({
        project: z.string().min(1),
        dir: z.string().startsWith('/'),
        url: z.string().min(1),
        domain: nullable,
        adminDomain: nullable,
    }),
    ghost: z.strictObject({
        image: z.string().min(1),
        tag: z.string().min(1),
        version: z.string().min(1),
        digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    }),
    profiles: z.array(z.string().min(1)),
    /**
     * SHA-256 of every file the manager wrote from the image's payload, by
     * path relative to the site. An update replaces an untouched file and
     * never silently replaces an edited one (plan §2.7). Empty in clone mode.
     */
    payload: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
    migrations: z.array(z.string().min(1)),
});

export type Metadata = z.infer<typeof metadataSchema>;
/** A document to write: fields with defaults may be left out. */
export type MetadataInput = z.input<typeof metadataSchema>;

/** A moment as metadata, locks and backups record it: ISO 8601 to the second. */
export const isoSeconds = (date = new Date()): string =>
    date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The metadata of a site ./ghost-docker install made, or a CliError saying
 * why `command` needs it.
 */
export function requireMetadata(dir: string, why: string): Metadata {
    const read = readMetadata(dir);
    if (read.state === 'absent') {
        throw new CliError(
            `${dir} has no ${META_FILE}, so it was not installed by ./ghost-docker install, and ${why}.\n` +
                '  Nothing has been changed.',
        );
    }
    if (read.state === 'invalid') {
        throw new CliError(`${read.reason}. Nothing has been changed.`);
    }
    return read.metadata;
}

/**
 * The site's own files a backup keeps and a restore replaces: the
 * operator's, and in image mode the stack files and launcher it runs, so a
 * restore anywhere runs exactly the images this one did.
 */
export const siteFiles = (metadata: Metadata | null): string[] => [
    ...OPERATOR_FILES,
    ...(metadata?.source === 'image' ? Object.keys(metadata.payload) : []),
];

export type MetadataRead =
    | { state: 'absent' }
    | { state: 'present'; metadata: Metadata }
    | { state: 'invalid'; reason: string };

export const metaPath = (dir: string): string => join(dir, META_FILE);

export function readMetadata(dir: string): MetadataRead {
    const text = readIfExists(metaPath(dir));
    if (text === undefined) {
        return { state: 'absent' };
    }
    let document: unknown;
    try {
        document = JSON.parse(text);
    } catch {
        return { state: 'invalid', reason: `${META_FILE} is not valid JSON` };
    }
    const version = (document as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (version === undefined) {
        return { state: 'invalid', reason: `${META_FILE} has no schemaVersion` };
    }
    if (version !== SCHEMA_VERSION) {
        return {
            state: 'invalid',
            reason:
                `${META_FILE} uses schema version ${JSON.stringify(version)}; this manager understands version ${SCHEMA_VERSION}` +
                (typeof version === 'number' && version > SCHEMA_VERSION
                    ? '. It was written by a newer ghost-docker; use that one.'
                    : ''),
        };
    }
    const parsed = metadataSchema.safeParse(document);
    if (!parsed.success) {
        const where = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
        return {
            state: 'invalid',
            reason: `${META_FILE} does not match its schema (${[...new Set(where)].join(', ')})`,
        };
    }
    return { state: 'present', metadata: parsed.data };
}

/** Validated before it is written, so a bad document never replaces a good one. */
export function writeMetadata(dir: string, metadata: MetadataInput): void {
    const valid = metadataSchema.parse(metadata);
    atomicWrite(metaPath(dir), `${JSON.stringify(sortKeys(valid), null, 2)}\n`, PRIVATE);
}

/** Stable output, so two writes of the same document are the same bytes. */
function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
        );
    }
    return value;
}

/** For a person, including for a site with no metadata at all. */
export function describeMetadata(read: MetadataRead): string[] {
    if (read.state === 'absent') {
        return ['installation metadata: none (installed before metadata was recorded)'];
    }
    if (read.state === 'invalid') {
        return [`installation metadata: unreadable: ${read.reason}`];
    }
    const { metadata: m } = read;
    const unknown = (value: string | null) => value ?? 'unknown';
    return [
        `installed      ${m.installedAt}`,
        ...(m.updatedAt ? [`updated        ${m.updatedAt}`] : []),
        `mode           ${m.mode}`,
        `source         ${m.source === 'checkout' ? 'a checkout of the repository' : 'the manager image'}`,
        `channel        ${unknown(m.channel)}`,
        `stack          ${unknown(m.stack.version)}${m.stack.commit ? ` (${m.stack.commit.slice(0, 12)})` : ''}`,
        ...(m.stack.image ? [`manager image  ${m.stack.image}`] : []),
        ...(m.stack.previous
            ? [
                  `previous       ${unknown(m.stack.previous.version)}${m.stack.previous.commit ? ` (${m.stack.previous.commit.slice(0, 12)})` : ''}`,
              ]
            : []),
        `project        ${m.site.project}`,
        `directory      ${m.site.dir}`,
        `url            ${m.site.url}`,
        ...(m.site.adminDomain ? [`admin domain   ${m.site.adminDomain}`] : []),
        `ghost          ${m.ghost.version} (${m.ghost.image}:${m.ghost.tag})`,
        `ghost image    ${m.ghost.image}@${m.ghost.digest}`,
        `profiles       ${m.profiles.join(',')}`,
        `migrations     ${m.migrations.length > 0 ? m.migrations.join(',') : 'none'}`,
    ];
}
