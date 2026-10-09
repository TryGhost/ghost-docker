// The migration bundle v1 manifest, as a zod schema: docs/bundle-v1.md.
//
// This is the single definition of the manifest. It depends on nothing but
// zod, so that it can be published and used unchanged by the exporter
// (`ghost migrate-export` in Ghost-CLI) as well as by the importer here: the
// two sides then cannot disagree about what a bundle is. Keep it that way;
// importer policy (which kinds and sources this release imports) is not
// written here.
//
// The messages describe the field and are printed after its path, as
// `database.rows.posts: is not a row count`.
import { z } from 'zod';

export const BUNDLE_VERSION = 1;
export const BUNDLE_KINDS = ['mysql-dump', 'mysql-data', 'portable'] as const;
export const SOURCE_INSTALL_TYPES = ['local', 'production'] as const;
/** The database file of the two MySQL kinds, at the root of the bundle. */
export const DATABASE_FILE = 'database.sql';
/** The content root, also at the root. */
export const CONTENT_ROOT = 'content/';

const REEXPORT = 'export the site again with Ghost-CLI 1.33.3 or later';

/** A field from an unreleased draft of the format, which a v1 manifest never has. */
const draftField = (instead: string) =>
    z
        .never({ error: `is a draft field that bundle v1 does not have (${instead}); ${REEXPORT}` })
        .optional();

/** A relative path that stays inside the bundle. */
const bundlePath = z
    .string({ error: 'must be a path inside the bundle' })
    .refine(
        (path) =>
            path !== '' &&
            !path.startsWith('/') &&
            !path.includes('\\') &&
            !path.split('/').includes('..'),
        { error: 'must be a path inside the bundle' },
    );

const httpUrl = z
    .string({ error: 'must be an http(s) URL' })
    .regex(/^https?:\/\/[^/\s]+/, { error: 'must be an http(s) URL' });

/** MySQL identifiers as Ghost names its tables; never anything SQL could misread. */
export const TABLE_NAME = /^[A-Za-z0-9_]{1,64}$/;

const rowCount = z
    .number({ error: 'is not a row count' })
    .int({ error: 'is not a row count' })
    .nonnegative({ error: 'is not a row count' });

const mysqlDatabase = {
    path: z.literal(DATABASE_FILE, { error: `must be "${DATABASE_FILE}"` }),
    kind: draftField('the kind is the top-level kind'),
};

const common = {
    bundleVersion: z.literal(BUNDLE_VERSION, {
        error: (issue) =>
            `is ${JSON.stringify(issue.input)}, not ${BUNDLE_VERSION}: this is not a version ${BUNDLE_VERSION} bundle`,
    }),
    bundleCreatedAt: z.iso.datetime({ error: 'must be an RFC 3339 timestamp in UTC' }),
    sourceInstallType: z.enum(SOURCE_INSTALL_TYPES, {
        error: (issue) =>
            `must be ${SOURCE_INSTALL_TYPES.join(' or ')}, not ${JSON.stringify(issue.input)}`,
    }),
    ghost: z.object(
        {
            version: z
                .string({ error: 'must be the exact Ghost version, such as 6.61.0' })
                .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, {
                    error: 'must be the exact Ghost version, such as 6.61.0',
                    abort: true,
                })
                .refine((version) => version.startsWith('6.'), {
                    error: (issue) =>
                        `is ${String(issue.input)}; only Ghost 6.x sites are carried by bundle v1. Run \`ghost update\` in the source installation, then export it again`,
                }),
        },
        { error: 'must be an object holding the exact Ghost version' },
    ),
    url: httpUrl,
    adminUrl: httpUrl.nullish(),
    content: z.literal(CONTENT_ROOT, { error: `must be "${CONTENT_ROOT}"` }),
    config: z.record(
        z.string(),
        z.string({ error: 'is not a string; bundle v1 config values are raw strings' }),
        { error: 'must be an object of raw string values' },
    ),
    ghostVersion: draftField('ghost.version'),
    sourceEnvironment: draftField('sourceInstallType'),
    configValues: draftField('config'),
};

const databaseObject = 'must be an object naming the database file';

export const mysqlDumpManifest = z.looseObject({
    ...common,
    kind: z.literal('mysql-dump'),
    database: z.looseObject(mysqlDatabase, { error: databaseObject }),
});

export const mysqlDataManifest = z.looseObject({
    ...common,
    kind: z.literal('mysql-data'),
    database: z.looseObject(
        {
            ...mysqlDatabase,
            rows: z
                .record(z.string().regex(TABLE_NAME, { error: 'is not a table name' }), rowCount, {
                    error: 'is required for a mysql-data bundle: an object of table name to row count',
                })
                .refine((rows) => Object.keys(rows).length > 0, {
                    error: 'is required for a mysql-data bundle and names no table',
                }),
        },
        { error: databaseObject },
    ),
});

export const portableManifest = z.looseObject({
    ...common,
    kind: z.literal('portable'),
    database: z.looseObject(
        {
            path: bundlePath,
            members: bundlePath,
            kind: draftField('the kind is the top-level kind'),
        },
        { error: databaseObject },
    ),
});

export const manifestSchema = z.discriminatedUnion(
    'kind',
    [mysqlDumpManifest, mysqlDataManifest, portableManifest],
    {
        error: (issue) =>
            issue.code === 'invalid_union'
                ? `must be one of ${BUNDLE_KINDS.join(', ')}, not ${JSON.stringify((issue.input as { kind?: unknown } | undefined)?.kind)}`
                : 'manifest.json is not a JSON object',
    },
);

export type BundleManifest = z.infer<typeof manifestSchema>;
export type BundleKind = BundleManifest['kind'];

/** The files a manifest names, relative to the bundle root. */
export const namedFiles = (manifest: BundleManifest): string[] =>
    manifest.kind === 'portable'
        ? [manifest.database.path, manifest.database.members]
        : [manifest.database.path];

export type ManifestResult =
    | { ok: true; manifest: BundleManifest }
    | { ok: false; problems: string[] };

/** Every way a parsed manifest.json falls short of bundle v1, one sentence each. */
export function readManifest(value: unknown): ManifestResult {
    const parsed = manifestSchema.safeParse(value);
    if (parsed.success) {
        return { ok: true, manifest: parsed.data };
    }
    return { ok: false, problems: parsed.error.issues.map(describe) };
}

const describe = (issue: z.core.$ZodIssue): string => {
    const at = (path: readonly PropertyKey[]) => path.map(String).join('.');
    // A key that fails its own schema, such as a table name: the key is named
    // in the message, under the object that holds it.
    if (issue.code === 'invalid_key') {
        const key = JSON.stringify(String(issue.path.at(-1)));
        return `${at(issue.path.slice(0, -1))}: ${key} ${issue.issues[0]?.message ?? 'is not allowed'}`;
    }
    return issue.path.length === 0 ? issue.message : `${at(issue.path)}: ${issue.message}`;
};
