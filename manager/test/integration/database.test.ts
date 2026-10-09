// Loading SQL into a site's real MySQL: the stream the manager pipes to the
// db container's own client, as backup restores and bundle imports do. The
// unit tests check that every byte reaches a scripted client; this checks
// what the real client and server make of them.
//
// One site, `delta`, with only its database started. Each test loads into
// tables of its own, as the site's user.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CliError } from '../../src/errors.ts';
import { loadFile, rowCounts, withSiteDatabase } from '../../src/import/database.ts';
import { makeSite, realIo, type TestSite } from './site.ts';

const io = realIo();
let delta: TestSite;
/** Where the SQL files are written: the site's own directory, as a backup's is. */
let root: string;

/** Rows enough that the file reaches the client in many pieces. */
const ROWS = 5000;
/** Text MySQL's utf8mb4 holds and its utf8 does not. */
const TITLE = 'Kept whole: 𝓖𝓱𝓸𝓼𝓽 ✓ — “quoted”';

before(
    async () => {
        delta = makeSite(io, 'delta', { profiles: 'local' });
        root = join(delta.dir, 'sql');
        mkdirSync(root);
        await delta.up('db');
    },
    { timeout: 1_200_000 },
);

after(async () => {
    await delta?.down();
});

const load = (file: string, filter: boolean) =>
    loadFile(io, delta.dir, { profiles: 'local' }, { root, file, filter, spinner: file });

const query = <T>(work: Parameters<typeof withSiteDatabase<T>>[3]) =>
    withSiteDatabase(io, delta.dir, { failure: 'the database could not be asked' }, work);

/** As mysqldump writes a table and a view whose definer is root. */
function dump(table: string): string {
    const rows = Array.from(
        { length: ROWS },
        (_, i) => `INSERT INTO \`${table}\` VALUES (${i + 1},'row ${i + 1} of ${ROWS}');`,
    );
    return [
        '-- MySQL dump',
        '/*!40101 SET NAMES utf8mb4 */;',
        `CREATE TABLE \`${table}\` (\`id\` int NOT NULL, \`title\` varchar(255) NOT NULL, PRIMARY KEY (\`id\`)) DEFAULT CHARSET=utf8mb4;`,
        ...rows,
        `UPDATE \`${table}\` SET \`title\` = '${TITLE}' WHERE \`id\` = ${ROWS};`,
        '/*!50001 CREATE ALGORITHM=UNDEFINED */',
        '/*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */',
        `/*!50001 VIEW \`${table}_view\` AS select count(0) AS \`n\` from \`${table}\` */;`,
        '-- Dump completed on 2026-10-09',
        '',
    ].join('\n');
}

test('a dump streamed to the client loads whole: every row, utf8mb4, and its view', async () => {
    writeFileSync(join(root, 'whole.sql'), dump('whole'));
    const result = await load('whole.sql', true);
    assert.equal(result.exitCode, 0, result.stderr);

    const loaded = await query(async (sql) => ({
        rows: await rowCounts(sql, ['whole']),
        title: String((await sql.query(`SELECT title FROM whole WHERE id = ${ROWS}`))[0]![0]),
        view: Number((await sql.query('SELECT n FROM whole_view'))[0]![0]),
    }));
    assert.deepEqual([...loaded.rows], [['whole', ROWS]]);
    assert.equal(loaded.title, TITLE);
    // Created as the site's user once the filter dropped root's DEFINER.
    assert.equal(loaded.view, ROWS);
});

test('unfiltered, a root DEFINER is refused by the server, so the filter is what lets it load', async () => {
    writeFileSync(join(root, 'definer.sql'), dump('definer'));
    const result = await load('definer.sql', false);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /ERROR 1227 .*SUPER or SET_USER_ID/);
});

test('SQL cut off mid-statement fails the load, naming the line', async () => {
    const whole = dump('cut');
    writeFileSync(
        join(root, 'cut.sql'),
        whole.slice(0, whole.indexOf(`VALUES (${ROWS / 2},`) + 12),
    );
    const result = await load('cut.sql', true);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /ERROR 1064 .* at line \d+/);
});

test('a file that cannot be read is an error, never half a load', async () => {
    mkdirSync(join(root, 'unreadable.sql'));
    await assert.rejects(
        load('unreadable.sql', true),
        (error) =>
            error instanceof CliError && /unreadable\.sql could not be read/.test(error.message),
    );
    const tables = await query((sql) => sql.query("SHOW TABLES LIKE 'unreadable%'"));
    assert.deepEqual(tables, []);
});
