// A backup's manifest: what it holds, which images the site ran, and a
// checksum of every file, so that a restore can tell the backup is whole
// before it changes anything. Plan §2.5; the layout is docs/install.md
// ("Backing up and restoring a site").
import { join } from 'node:path';
import { z } from 'zod';
import { readIfExists } from '../fs.ts';

export const BACKUP_FORMAT = 'ghost-docker-backup';
export const BACKUP_VERSION = 1;
export const MANIFEST_FILE = 'manifest.json';
/** The content directory, as a gzipped tarball of its contents. */
export const CONTENT_ARCHIVE = 'content.tar.gz';
/** One dump per database: `database/<name>.sql`. */
export const DATABASE_DIR = 'database';
/** The site's own files, at their paths relative to the site. */
export const SITE_FILES_DIR = 'site';

/** A MySQL database name the manager writes into a file name and a shell argument. */
export const DATABASE_NAME = /^[A-Za-z0-9_]{1,64}$/;

/** A path inside the backup: relative, without `..`. */
const inside = z
    .string()
    .min(1)
    .refine(
        (path) => !path.startsWith('/') && !path.split('/').includes('..'),
        'is not a path inside the backup',
    );

const nullable = z.string().min(1).nullable();

export const backupManifestSchema = z.strictObject({
    format: z.literal(BACKUP_FORMAT),
    version: z.literal(BACKUP_VERSION),
    createdAt: z.iso.datetime(),
    /**
     * `quiesced`: the databases and the content were captured with nothing
     * writing to them, as one moment. `live`: each database is one snapshot,
     * captured at a different moment from the others and from the content.
     * Backups from before this was recorded were live.
     */
    consistency: z.enum(['quiesced', 'live']).default('live'),
    /** The manager that took it. */
    manager: z.strictObject({ version: nullable, commit: nullable, image: nullable }),
    site: z.strictObject({
        project: z.string().min(1),
        dir: z.string().startsWith('/'),
        url: z.string().min(1),
        mode: z.enum(['local', 'production']),
        source: z.enum(['image', 'checkout']),
        /** In a checkout, the commit the site ran; a restore needs the same one. */
        commit: nullable,
        profiles: z.array(z.string().min(1)),
    }),
    /** Each service the site ran, by the exact image Compose resolved for it. */
    images: z.record(z.string().min(1), z.string().min(1)),
    databases: z
        .array(
            z.strictObject({
                name: z.string().regex(DATABASE_NAME),
                file: inside,
                /** Rows in each table, as loaded back when the backup was checked. */
                tables: z.record(z.string().min(1), z.number().int().nonnegative()),
            }),
        )
        .min(1),
    content: z.strictObject({
        file: inside,
        entries: z.number().int().nonnegative(),
    }),
    /** SHA-256 of every file in the backup but this one, by path. */
    files: z.record(inside, z.string().regex(/^[0-9a-f]{64}$/)),
    /** What the site has that this backup does not, for a person to read. */
    notIncluded: z.array(z.string().min(1)),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;

export type ManifestRead =
    | { state: 'present'; manifest: BackupManifest }
    | { state: 'refused'; reason: string };

export function readBackupManifest(root: string): ManifestRead {
    const text = readIfExists(join(root, MANIFEST_FILE));
    if (text === undefined) {
        return {
            state: 'refused',
            reason: `${root} has no ${MANIFEST_FILE}, so it is not a backup made by ./ghost-docker backup`,
        };
    }
    let document: unknown;
    try {
        document = JSON.parse(text);
    } catch {
        return { state: 'refused', reason: `${MANIFEST_FILE} in ${root} is not valid JSON` };
    }
    const header = document as { format?: unknown; version?: unknown } | null;
    if (header?.format !== BACKUP_FORMAT) {
        return {
            state: 'refused',
            reason: `${root} is not a backup made by ./ghost-docker backup`,
        };
    }
    if (header.version !== BACKUP_VERSION) {
        return {
            state: 'refused',
            reason:
                `the backup is format version ${JSON.stringify(header.version)}; this manager reads version ${BACKUP_VERSION}` +
                (typeof header.version === 'number' && header.version > BACKUP_VERSION
                    ? '. It was made by a newer ghost-docker; restore it with that one.'
                    : ''),
        };
    }
    const parsed = backupManifestSchema.safeParse(document);
    if (!parsed.success) {
        const where = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
        return {
            state: 'refused',
            reason: `${MANIFEST_FILE} does not match its schema (${[...new Set(where)].join(', ')})`,
        };
    }
    return { state: 'present', manifest: parsed.data };
}
