// The site's database, as an import loads and checks it.
//
// The database is always loaded as the site's own MySQL user, never as root,
// so whatever a dump contains can affect nothing but that site's database.
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import type { BundleManifest } from '../bundle/manifest.ts';
import { compose, type ComposeResult } from '../compose.ts';
import type { Io } from '../io.ts';

/**
 * The mysql client inside the db container, as the site's database user and
 * against the site's database only. The password reaches the client through
 * the container's own environment, not an argument.
 */
const CLIENT =
    'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql --default-character-set=utf8mb4 -h 127.0.0.1 -u"$MYSQL_USER" "$@" "$MYSQL_DATABASE"';

export interface Mysql {
    /** Runs SQL from `input` as the site's user. */
    run: (
        input: string | Readable,
        args?: readonly string[],
        timeoutMs?: number,
    ) => Promise<ComposeResult>;
}

/** The site's database, through Compose with the profiles given. */
export const siteMysql = (io: Io, dir: string, profiles: string): Mysql => ({
    run: (input, args = [], timeoutMs = 60_000) =>
        compose(io, dir, ['exec', '-T', 'db', 'sh', '-c', CLIENT, 'mysql', ...args], {
            env: { COMPOSE_PROFILES: profiles },
            input,
            timeoutMs,
        }),
});

/** `--batch --skip-column-names`: tab-separated rows, nothing else. */
export const BATCH = ['--batch', '--skip-column-names'] as const;

/** One query counting the rows of every table, by name. Names are validated by the schema. */
export const rowCountQuery = (tables: readonly string[]): string =>
    `${tables.map((table) => `SELECT '${table}', COUNT(*) FROM \`${table}\``).join(' UNION ALL ')};\n`;

/**
 * Each table whose count in the database differs from the bundle's record,
 * as a sentence. `output` is the batch output of rowCountQuery.
 */
export function rowMismatches(
    expected: Readonly<Record<string, number>>,
    output: string,
): string[] {
    const actual = new Map<string, number>();
    for (const line of output.split('\n')) {
        const [table, count] = line.split('\t');
        if (table && count !== undefined && /^\d+$/.test(count.trim())) {
            actual.set(table, Number(count.trim()));
        }
    }
    return Object.entries(expected)
        .filter(([table, count]) => actual.get(table) !== count)
        .map(
            ([table, count]) =>
                `${table}: the bundle records ${count} rows, the database has ${actual.get(table) ?? 'none'}`,
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

const SLASH = 0x2f;
const STAR = 0x2a;
const BANG = 0x21;
const NEWLINE = 0x0a;

/**
 * dropDefiner over a stream, byte for byte everywhere else. Only lines that
 * start `/*!` are held whole and rewritten; every other line, however long
 * (an extended INSERT can be megabytes), passes straight through.
 */
export class DefinerFilter extends Transform {
    /** The start of the current line while it is undecided or held. */
    private held: Buffer[] = [];
    private heldLength = 0;
    private state: 'start' | 'pass' | 'hold' = 'start';

    override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
        let at = 0;
        while (at < chunk.length) {
            if (this.state === 'pass') {
                const end = chunk.indexOf(NEWLINE, at);
                if (end < 0) {
                    this.push(chunk.subarray(at));
                    break;
                }
                this.push(chunk.subarray(at, end + 1));
                at = end + 1;
                this.state = 'start';
                continue;
            }
            if (this.state === 'start') {
                // Up to three bytes decide it: `/*!` is held, anything else passes.
                const take = Math.min(3 - this.heldLength, chunk.length - at);
                const piece = chunk.subarray(at, at + take);
                const newline = piece.indexOf(NEWLINE);
                if (newline >= 0) {
                    this.hold(piece.subarray(0, newline + 1));
                    this.flush();
                    at += newline + 1;
                    continue;
                }
                this.hold(piece);
                at += take;
                if (this.heldLength < 3) {
                    continue;
                }
                const start = Buffer.concat(this.held);
                if (start[0] === SLASH && start[1] === STAR && start[2] === BANG) {
                    this.state = 'hold';
                } else {
                    this.flush();
                    this.state = 'pass';
                }
                continue;
            }
            const end = chunk.indexOf(NEWLINE, at);
            if (end < 0) {
                this.hold(chunk.subarray(at));
                break;
            }
            this.hold(chunk.subarray(at, end + 1));
            at = end + 1;
            this.rewrite();
            this.state = 'start';
        }
        done();
    }

    override _flush(done: TransformCallback): void {
        if (this.state === 'hold') {
            this.rewrite();
        } else {
            this.flush();
        }
        done();
    }

    private hold(piece: Buffer): void {
        this.held.push(piece);
        this.heldLength += piece.length;
    }

    private flush(): void {
        if (this.heldLength > 0) {
            this.push(Buffer.concat(this.held));
        }
        this.held = [];
        this.heldLength = 0;
    }

    /** latin1 maps each byte to one character and back, so nothing else changes. */
    private rewrite(): void {
        this.held = [
            Buffer.from(dropDefiner(Buffer.concat(this.held).toString('latin1')), 'latin1'),
        ];
        this.flush();
    }
}

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
