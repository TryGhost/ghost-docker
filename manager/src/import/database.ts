// The site's database, as an import, a backup or a restore loads and checks it.
//
// The database is always used as the site's own MySQL user, never as root,
// so whatever a dump contains can affect nothing but that site's databases.
// Dumps are loaded by the mysql client of the db container's own version;
// questions about the result are asked directly, over the site's network.
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import type { BundleManifest } from '../bundle/manifest.ts';
import { ServiceUnreachable, type SqlConnection } from '../clients.ts';
import { compose, composePs, type ComposeResult, type ServiceState } from '../compose.ts';
import { CliError } from '../errors.ts';
import type { Io } from '../io.ts';
import { NetworkUnavailable } from '../network.ts';
import { readSettings } from '../site.ts';

/**
 * The mysql client inside the db container, as the site's database user and
 * against one of the site's databases only. The password reaches the client
 * through the container's own environment, not an argument.
 */
const CLIENT =
    'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql --default-character-set=utf8mb4 -h 127.0.0.1 -u"$MYSQL_USER" "${DB:-$MYSQL_DATABASE}"';

/**
 * Loads SQL from `input` into the site's database, or another its user owns
 * such as ActivityPub's, with the client of the server's own version, through
 * Compose with the profiles given.
 */
export const loadDatabase = (
    io: Io,
    dir: string,
    { profiles, database }: { profiles: string; database?: string },
    input: Readable,
    timeoutMs: number,
): Promise<ComposeResult> =>
    compose(
        io,
        dir,
        [
            'exec',
            '-T',
            ...(database === undefined ? [] : ['-e', `DB=${database}`]),
            'db',
            'sh',
            '-c',
            CLIENT,
        ],
        { env: { COMPOSE_PROFILES: profiles }, input, timeoutMs },
    );

export interface DatabaseSession {
    /** COMPOSE_PROFILES for finding the db container, when `.env` does not select it yet. */
    readonly profiles?: string;
    /** Another database the site's user owns, such as ActivityPub's; Ghost's by default. */
    readonly database?: string;
    /** What `docker compose ps` already said, when the caller has it. */
    readonly services?: readonly ServiceState[] | null;
    /** What could not be done, for the error: `the database could not be queried`. */
    readonly failure: string;
}

/**
 * Runs `work` with a connection to one of the site's databases, as the site's
 * own user, over the site's network. The connection is closed and the
 * network left however `work` ends. A database that cannot be reached is a
 * CliError naming `failure`.
 */
export async function withSiteDatabase<T>(
    io: Io,
    dir: string,
    { profiles, database, services, failure }: DatabaseSession,
    work: (sql: SqlConnection) => Promise<T>,
): Promise<T> {
    const settings = readSettings(dir);
    const value = (key: string, fallback: string) => settings?.get(key) || fallback;
    const known =
        services ??
        (await composePs(
            io,
            dir,
            profiles === undefined ? undefined : { COMPOSE_PROFILES: profiles },
        ));
    if (known === null) {
        throw new CliError(
            `${failure}: docker compose ps failed, so the db container was not found`,
        );
    }
    try {
        return await io.siteNetwork(known, ['db'], async (network) => {
            const address = network.address('db');
            if (address === null) {
                throw new NetworkUnavailable(`the db container has no address on ${network.name}`);
            }
            const sql = await io.clients.mysql({
                host: address.host,
                // The container's own port: DATABASE_PORT is where Ghost
                // connects, which is this unless the database is elsewhere.
                port: 3306,
                user: value('DATABASE_USER', 'ghost'),
                password: value('DATABASE_PASSWORD', ''),
                database: database ?? value('DATABASE_NAME', 'ghost'),
            });
            try {
                return await work(sql);
            } finally {
                await sql.close();
            }
        });
    } catch (error) {
        if (error instanceof ServiceUnreachable || error instanceof NetworkUnavailable) {
            throw new CliError(`${failure}: ${error.message}`);
        }
        throw error;
    }
}

/** The single value a one-row, one-column query returned, as a number; NaN otherwise. */
export const countOf = (rows: readonly unknown[][]): number =>
    rows.length === 1 && rows[0]!.length === 1 && /^\d+$/.test(String(rows[0]![0]))
        ? Number(rows[0]![0])
        : Number.NaN;

/** How many tables the connection's database holds; `base` counts tables only, not views. */
export async function tableCount(sql: SqlConnection, base = false): Promise<number> {
    return countOf(
        await sql.query(
            'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()' +
                (base ? " AND table_type = 'BASE TABLE'" : ''),
        ),
    );
}

/** One query counting the rows of every table, by name. Names are validated by the schema. */
export const rowCountQuery = (tables: readonly string[]): string =>
    tables.map((table) => `SELECT '${table}', COUNT(*) FROM \`${table}\``).join(' UNION ALL ');

/** The rows of each table, counted in one query. */
export async function rowCounts(
    sql: SqlConnection,
    tables: readonly string[],
): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const [table, count] of await sql.query(rowCountQuery(tables))) {
        if (typeof table === 'string' && /^\d+$/.test(String(count))) {
            counts.set(table, Number(count));
        }
    }
    return counts;
}

/**
 * Each table whose count in the database differs from the record, as a
 * sentence. `source` names what recorded the counts.
 */
export function rowMismatches(
    expected: Readonly<Record<string, number>>,
    actual: ReadonlyMap<string, number>,
    source = 'the bundle',
): string[] {
    return Object.entries(expected)
        .filter(([table, count]) => actual.get(table) !== count)
        .map(
            ([table, count]) =>
                `${table}: ${source} records ${count} rows, the database has ${actual.get(table) ?? 'none'}`,
        );
}

/**
 * mysqldump records who defined each view and trigger (`DEFINER=`), and only
 * an account with SET_USER_ID may create an object on another's behalf. The
 * load runs as the site's own user precisely so that it has no such
 * privilege, so these clauses are dropped and the objects belong to the
 * site's user, which is the account Ghost connects as. Only mysqldump's own
 * version-comment lines are rewritten:
 *
 *   /*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER *\/         (views)
 *   /*!50003 CREATE*\/ /*!50017 DEFINER=`root`@`%`*\/ /*!50003 TRIGGER ... (triggers)
 *
 * Row data never starts a line that way, and nothing else is changed.
 */
export function dropDefiner(line: string): string {
    if (/^\/\*!\d{5} DEFINER=/.test(line)) {
        return line.replace(/^(\/\*!\d{5}) DEFINER=`[^`]*`@`[^`]*`/, '$1');
    }
    if (/^\/\*!\d{5} CREATE\*\//.test(line)) {
        return line.replace(/\/\*!\d{5} DEFINER=`[^`]*`@`[^`]*`\*\/ ?/, '');
    }
    return line;
}

const NEWLINE = 0x0a;

/**
 * dropDefiner over a stream, byte for byte everywhere else. It holds one line
 * at a time, so the longest line bounds its memory: mysqldump starts a new
 * INSERT at net_buffer_length (1MB), so that is about the largest single row.
 */
export class DefinerFilter extends Transform {
    /** The current line, until its newline arrives. */
    private held: Buffer[] = [];

    override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
        let start = 0;
        for (let end = chunk.indexOf(NEWLINE); end >= 0; end = chunk.indexOf(NEWLINE, start)) {
            this.held.push(chunk.subarray(start, end + 1));
            this.push(rewrite(Buffer.concat(this.held)));
            this.held = [];
            start = end + 1;
        }
        this.held.push(chunk.subarray(start));
        done();
    }

    override _flush(done: TransformCallback): void {
        done(null, rewrite(Buffer.concat(this.held)));
    }
}

/**
 * Only mysqldump's own `/*!` lines are decoded and rewritten. latin1 maps
 * each byte to one character and back, so nothing else changes.
 */
const rewrite = (line: Buffer): Buffer =>
    line.subarray(0, 3).toString('latin1') === '/*!'
        ? Buffer.from(dropDefiner(line.toString('latin1')), 'latin1')
        : line;

/** database.sql as the client reads it: as it is, or for a dump, without DEFINER clauses. */
export function databaseInput(root: string, manifest: BundleManifest): Readable {
    const file = createReadStream(join(root, manifest.database.path));
    if (manifest.kind !== 'mysql-dump') {
        return file;
    }
    const filter = new DefinerFilter();
    file.on('error', (error) => filter.destroy(error));
    return file.pipe(filter);
}
