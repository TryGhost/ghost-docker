// Staging a migration bundle: what is accepted, and everything that is refused.
//
// Nothing here needs Docker. Archives a well-behaved tar or zip would never
// produce (absolute paths, `..`, links, devices) are built byte by byte.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { crc32, gzipSync } from 'node:zlib';
import { STAGING, stageBundle, type StagedBundle } from '../src/bundle/stage.ts';
import { harness, type Harness } from './helpers.ts';
import { fixture, type Manifest } from './site.ts';

let h: Harness;
let work: string;
let site: string;
let counter = 0;
beforeEach(() => {
    h = harness();
    work = join(h.dir, 'work');
    mkdirSync(work);
});
afterEach(() => h.cleanup());

/** Stages a bundle into a fresh site directory. */
async function stage(bundle: string): Promise<StagedBundle> {
    counter += 1;
    site = join(h.dir, `site-${counter}`);
    mkdirSync(site);
    return stageBundle(site, bundle);
}

/** Stages a bundle that must be refused, and checks nothing was left behind. */
async function refused(bundle: string, pattern: RegExp): Promise<void> {
    await assert.rejects(stage(bundle), (error: Error) => {
        assert.match(error.message, pattern);
        return true;
    });
    assert.ok(!existsSync(join(site, STAGING)), 'left a staging directory behind');
}

/** A bundle directory for a manifest, with the files that manifest names. */
function bundleDir(manifest: Manifest, name = 'bundle'): string {
    const root = join(work, name);
    mkdirSync(join(root, 'content', 'themes', 'source'), { recursive: true });
    mkdirSync(join(root, 'content', 'images'), { recursive: true });
    writeFileSync(join(root, 'content', 'themes', 'source', 'package.json'), '{"name":"source"}\n');
    writeFileSync(join(root, 'content', 'images', '.hidden'), 'dotfile\n');
    for (const path of [manifest?.database?.path, manifest?.database?.members]) {
        if (typeof path !== 'string' || path.includes('..') || path.startsWith('/')) {
            continue;
        }
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), 'data\n');
    }
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return root;
}

const tarOf = (source: string, name: string, flags = '-czf') => {
    const archive = join(work, name);
    execFileSync('tar', [flags, archive, '-C', source, '.']);
    return archive;
};

// --- Archives no real archiver emits ---------------------------------------------

function tarEntry(
    name: string,
    { type = '0', data = Buffer.alloc(0), linkname = '' } = {},
): Buffer {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.write('        ', 148, 'ascii');
    header.write(type, 156, 'ascii');
    header.write(linkname, 157, 100, 'utf8');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let sum = 0;
    for (const byte of header) {
        sum += byte;
    }
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
    return Buffer.concat([header, data, padding]);
}

function tarball(name: string, entries: Buffer[]): string {
    const path = join(work, name);
    writeFileSync(path, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
    return path;
}

/** A stored (uncompressed) zip, with each entry's Unix mode. */
function zip(name: string, entries: { name: string; data?: string; mode?: number }[]): string {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const data = Buffer.from(entry.data ?? '');
        const fileName = Buffer.from(entry.name);
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(fileName.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE((3 << 8) | 30, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(fileName.length, 28);
        central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        locals.push(local, fileName, data);
        centrals.push(central, fileName);
        offset += local.length + fileName.length + data.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    const path = join(work, name);
    writeFileSync(path, Buffer.concat([...locals, directory, end]));
    return path;
}

/** A zip of a bundle directory's files, as an archiver would write it. */
function zipOf(source: string, name: string): string {
    const entries: { name: string; data?: string; mode?: number }[] = [];
    const walk = (relative: string) => {
        for (const entry of readdirSync(join(source, relative), { withFileTypes: true })) {
            const path = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                entries.push({ name: `${path}/`, mode: 0o040755 });
                walk(path);
            } else {
                entries.push({ name: path, data: readFileSync(join(source, path), 'utf8') });
            }
        }
    };
    walk('');
    return zip(name, entries);
}

const manifestEntry = (manifest = fixture('mysql-data')) =>
    tarEntry('manifest.json', { data: Buffer.from(JSON.stringify(manifest)) });

// --- Accepted ---------------------------------------------------------------

describe('staging a valid bundle', () => {
    for (const kind of ['mysql-dump', 'mysql-data', 'portable']) {
        test(`a ${kind} bundle directory is copied and its manifest read`, async () => {
            const staged = await stage(bundleDir(fixture(kind)));
            assert.deepEqual(staged.manifest, fixture(kind));
            assert.equal(staged.root, join(site, STAGING, 'bundle'));
            assert.ok(existsSync(join(staged.root, 'content', 'themes', 'source', 'package.json')));
            assert.ok(
                existsSync(join(staged.root, 'content', 'images', '.hidden')),
                'dropped a dotfile',
            );
        });
    }

    test('a .tgz made by the system tar extracts to the same tree', async () => {
        const staged = await stage(tarOf(bundleDir(fixture('mysql-data')), 'bundle.tgz'));
        assert.equal(readFileSync(join(staged.root, 'database.sql'), 'utf8'), 'data\n');
        assert.ok(existsSync(join(staged.root, 'content', 'images', '.hidden')));
        // macOS tar's `._name` attribute files are not part of the bundle.
        assert.deepEqual(readdirSync(staged.root).sort(), [
            'content',
            'database.sql',
            'manifest.json',
        ]);
    });

    test('an archive that wraps the bundle in one directory is the same bundle', async () => {
        bundleDir(fixture('mysql-dump'), 'ghost-migration-site');
        const archive = join(work, 'wrapped.tgz');
        execFileSync('tar', ['-czf', archive, '-C', work, 'ghost-migration-site']);
        const staged = await stage(archive);
        assert.deepEqual(readdirSync(staged.root).sort(), [
            'content',
            'database.sql',
            'manifest.json',
        ]);
    });

    test('an uncompressed tar is read too', async () => {
        const staged = await stage(tarOf(bundleDir(fixture('mysql-dump')), 'bundle.tar', '-cf'));
        assert.equal(staged.manifest.kind, 'mysql-dump');
    });

    test('a path longer than a tar header field survives', async () => {
        const source = bundleDir(fixture('mysql-dump'));
        const parts = Array<string>(12).fill('a-directory-name-of-some-length');
        mkdirSync(join(source, 'content', 'images', ...parts), { recursive: true });
        writeFileSync(join(source, 'content', 'images', ...parts, 'photo.jpg'), 'pixels');
        const staged = await stage(tarOf(source, 'long.tgz'));
        assert.equal(
            readFileSync(join(staged.root, 'content', 'images', ...parts, 'photo.jpg'), 'utf8'),
            'pixels',
        );
    });

    test('a zip archive is read', async () => {
        const staged = await stage(zipOf(bundleDir(fixture('mysql-data')), 'bundle.zip'));
        assert.equal(readFileSync(join(staged.root, 'database.sql'), 'utf8'), 'data\n');
        assert.ok(existsSync(join(staged.root, 'content', 'images', '.hidden')));
    });

    test('a zip without directory entries makes its directories', async () => {
        const manifest = fixture('mysql-dump');
        const staged = await stage(
            zip('flat.zip', [
                { name: 'manifest.json', data: JSON.stringify(manifest) },
                { name: 'database.sql', data: 'data\n' },
                { name: 'content/images/2026/photo.jpg', data: 'pixels' },
            ]),
        );
        assert.equal(
            readFileSync(join(staged.root, 'content/images/2026/photo.jpg'), 'utf8'),
            'pixels',
        );
    });

    test('the staging directory is private', async () => {
        await stage(tarOf(bundleDir(fixture('mysql-data')), 'bundle.tgz'));
        assert.equal(statSync(join(site, STAGING)).mode & 0o077, 0);
    });

    test('staging again replaces what an earlier attempt left', async () => {
        const first = await stage(bundleDir(fixture('mysql-dump')));
        writeFileSync(join(first.staging, 'stale'), 'x');
        const again = await stageBundle(site, join(work, 'bundle'));
        assert.ok(!existsSync(join(again.staging, 'stale')));
    });

    test('the bundle itself is left exactly as it was', async () => {
        const source = bundleDir(fixture('mysql-data'));
        const archive = tarOf(source, 'bundle.tgz');
        const before = readFileSync(archive);
        await stage(archive);
        await stage(source);
        assert.deepEqual(readFileSync(archive), before);
        assert.ok(existsSync(join(source, 'content', 'images', '.hidden')));
    });
});

// --- Refused ----------------------------------------------------------------

describe('entries that could leave the bundle, or are not files', () => {
    test('a symbolic link in a bundle directory', async () => {
        const source = bundleDir(fixture('mysql-dump'));
        symlinkSync('/etc/passwd', join(source, 'content', 'images', 'link'));
        await refused(source, /symbolic link: content\/images\/link/);
    });

    test('a symbolic link in an archive', async () => {
        const source = bundleDir(fixture('mysql-dump'));
        symlinkSync('../../../outside', join(source, 'content', 'themes', 'escape'));
        await refused(tarOf(source, 'symlink.tgz'), /symbolic link: content\/themes\/escape/);
    });

    test('a hard link in an archive', async () => {
        const archive = tarball('hardlink.tgz', [
            manifestEntry(),
            tarEntry('content/passwd', { type: '1', linkname: '/etc/passwd' }),
        ]);
        await refused(archive, /hard link: content\/passwd/);
    });

    test('an absolute path', async () => {
        const archive = tarball('absolute.tgz', [
            manifestEntry(),
            tarEntry('/tmp/ghost-docker-escape', { data: Buffer.from('x') }),
        ]);
        await refused(archive, /leaves the bundle: \/tmp\/ghost-docker-escape/);
        assert.ok(!existsSync('/tmp/ghost-docker-escape'));
    });

    test('a path with a .. component', async () => {
        const archive = tarball('dotdot.tgz', [
            manifestEntry(),
            tarEntry('content/../../escape', { data: Buffer.from('x') }),
        ]);
        await refused(archive, /leaves the bundle: content\/\.\.\/\.\.\/escape/);
        assert.ok(!existsSync(join(h.dir, 'escape')));
    });

    test('a device node', async () => {
        const archive = tarball('device.tgz', [
            manifestEntry(),
            tarEntry('content/null', { type: '3' }),
        ]);
        await refused(archive, /special file: content\/null/);
    });

    test('a FIFO', async () => {
        const archive = tarball('fifo.tgz', [
            manifestEntry(),
            tarEntry('content/pipe', { type: '6' }),
        ]);
        await refused(archive, /special file: content\/pipe/);
    });

    test('a symbolic link in a zip', async () => {
        const archive = zip('symlink.zip', [
            { name: 'manifest.json', data: JSON.stringify(fixture('mysql-dump')) },
            { name: 'content/link', data: '/etc/passwd', mode: 0o120777 },
        ]);
        await refused(archive, /symbolic link: content\/link/);
    });

    test('a .. path in a zip', async () => {
        const archive = zip('dotdot.zip', [
            { name: 'manifest.json', data: '{}' },
            { name: 'content/../../escape', data: 'x' },
        ]);
        await refused(archive, /leaves the bundle: content\/\.\.\/\.\.\/escape/);
        assert.ok(!existsSync(join(h.dir, 'escape')));
    });

    test('an absolute path in a zip', async () => {
        const archive = zip('absolute.zip', [{ name: '/tmp/ghost-docker-escape', data: 'x' }]);
        await refused(archive, /leaves the bundle: \/tmp\/ghost-docker-escape/);
    });

    test('a manifest that is a symbolic link', async () => {
        const source = bundleDir(fixture('mysql-dump'));
        rmSync(join(source, 'manifest.json'));
        symlinkSync('/etc/hosts', join(source, 'manifest.json'));
        await refused(source, /symbolic link: manifest\.json/);
    });
});

describe('archives that are not bundles', () => {
    test('a truncated archive', async () => {
        const archive = tarOf(bundleDir(fixture('mysql-dump')), 'whole.tgz');
        const bytes = readFileSync(archive);
        const cut = join(work, 'cut.tgz');
        writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
        await refused(cut, /corrupt or truncated/);
    });

    test('a file that is no archive at all', async () => {
        const file = join(work, 'notes.txt');
        writeFileSync(file, 'not a bundle\n'.repeat(100));
        await refused(file, /not an archive made by `ghost migrate-export`/);
    });

    test('gzip of something that is not tar', async () => {
        const file = join(work, 'notes.tgz');
        writeFileSync(file, gzipSync(Buffer.from('not a tar archive\n'.repeat(100))));
        await refused(file, /not an archive made by `ghost migrate-export`/);
    });

    test('a zip that is cut short', async () => {
        const archive = zipOf(bundleDir(fixture('mysql-dump')), 'whole.zip');
        const cut = join(work, 'cut.zip');
        writeFileSync(cut, readFileSync(archive).subarray(0, 40));
        await refused(cut, /corrupt or truncated/);
    });

    test('a path that does not exist', async () => {
        await refused(join(work, 'missing.tgz'), /there is no bundle at .*missing\.tgz/);
    });

    test('a directory with no manifest', async () => {
        const source = join(work, 'empty');
        mkdirSync(join(source, 'content'), { recursive: true });
        await refused(source, /no manifest\.json/);
    });

    test('a manifest that is not JSON', async () => {
        const source = bundleDir(fixture('mysql-dump'));
        writeFileSync(join(source, 'manifest.json'), '{ not json');
        await refused(source, /manifest\.json is not valid JSON/);
    });

    test('a manifest that does not meet the contract names each problem', async () => {
        const manifest = fixture('mysql-data');
        manifest.bundleVersion = 2;
        manifest.database.rows.posts = -1;
        await refused(
            bundleDir(manifest),
            /does not meet bundle v1.*\n.*bundleVersion: is 2.*\n.*database\.rows\.posts: is not a row count/,
        );
    });

    test('a database file the manifest names that is not there', async () => {
        const source = bundleDir(fixture('mysql-dump'));
        rmSync(join(source, 'database.sql'));
        await refused(source, /names database\.sql, which is not a file in the bundle/);
    });

    test('a database file that is a directory', async () => {
        const source = bundleDir(fixture('mysql-dump'));
        rmSync(join(source, 'database.sql'));
        mkdirSync(join(source, 'database.sql'));
        await refused(source, /names database\.sql, which is not a file in the bundle/);
    });

    test('a portable members file that is not there', async () => {
        const source = bundleDir(fixture('portable'));
        rmSync(join(source, 'content', 'data', 'members.csv'));
        await refused(source, /names content\/data\/members\.csv, which is not a file/);
    });

    test('no content directory', async () => {
        const source = bundleDir(fixture('mysql-dump'));
        rmSync(join(source, 'content'), { recursive: true });
        await refused(source, /no content\/ directory/);
    });
});
