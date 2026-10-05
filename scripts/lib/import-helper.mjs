// Stage and validate a migration bundle.
//
//   node import-helper.mjs stage BUNDLE STAGING
//
// BUNDLE is a bundle directory, or a .tgz/.tar archive of one, produced by
// `ghost migrate-export`. STAGING is an existing, empty, private directory.
// On success STAGING/bundle holds a validated copy of the bundle, the
// manifest is printed to stdout, and the exit status is 0. On any failure a
// message goes to stderr, the status is 1, and STAGING/bundle is removed.
//
// A bundle is a file somebody else produced, so nothing in it is trusted:
//
//   * Archives are read by the parser below, never by a tar binary. Only
//     regular files and directories are materialised. Symbolic links, hard
//     links, devices and every other entry type are rejected outright; the
//     exporter never emits them.
//   * Every path is relative, has no `..` component, and is created
//     exclusively, so no entry can be written through another one.
//   * Expansion is bounded by an entry count and by the free space of the
//     staging filesystem, checked while writing rather than estimated from the
//     compressed size.
//
// scripts/lib/import.sh runs this inside a pinned image with no network, a
// read-only root filesystem and a read-only view of the bundle. It has no
// dependencies beyond Node itself, and the tests run it directly.
//
// The manifest contract is docs/bundle-v1.md.
import {
  createReadStream, mkdirSync, openSync, writeSync, closeSync, readFileSync,
  lstatSync, readdirSync, rmSync, renameSync, statfsSync, existsSync, readSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { createGunzip } from 'node:zlib';

const BLOCK = 512;
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;
const PRIVATE_FILE_MODE = 0o600;

// Left free on the staging filesystem after extraction, for the database
// load and the images that follow.
const RESERVE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = Number(process.env.GD_IMPORT_MAX_ENTRIES ?? 1_000_000);
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 4096;

class BundleError extends Error {}
const fail = (message) => { throw new BundleError(message); };

// --- Paths -----------------------------------------------------------------

/**
 * A bundle-relative path as its components, or a BundleError. Leading `./` and
 * a trailing `/` are dropped; anything that could leave the bundle is refused
 * rather than normalised away.
 */
export function safePath(raw, what = 'path') {
  if (typeof raw !== 'string' || raw.length === 0) fail(`${what} is empty`);
  if (Buffer.byteLength(raw) > MAX_PATH_BYTES) fail(`${what} is too long`);
  if (raw.includes('\0')) fail(`${what} contains a NUL byte: ${JSON.stringify(raw)}`);
  if (raw.startsWith('/')) fail(`${what} is absolute: ${raw}`);
  const parts = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') fail(`${what} leaves the bundle: ${raw}`);
    parts.push(part);
  }
  return parts;
}

// --- Space accounting ------------------------------------------------------

function budget(staging) {
  let limit = Number(process.env.GD_IMPORT_MAX_BYTES ?? 0);
  if (!(limit > 0)) {
    const fsinfo = statfsSync(staging);
    limit = Number(fsinfo.bavail) * Number(fsinfo.bsize) - RESERVE_BYTES;
  }
  let bytes = 0;
  let entries = 0;
  return {
    entry() {
      entries += 1;
      if (entries > MAX_ENTRIES) fail(`the bundle has more than ${MAX_ENTRIES} entries`);
    },
    bytes(count) {
      bytes += count;
      if (bytes > limit) {
        fail('the bundle does not fit in the free space of the site directory\'s filesystem '
          + `(${Math.max(0, Math.floor(limit / 1048576))} MB usable)`);
      }
    },
  };
}

// --- Writing ---------------------------------------------------------------

function makeDir(root, parts) {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch {
      mkdirSync(current, { mode: DIR_MODE });
      continue;
    }
    if (!info.isDirectory()) fail(`${parts.join('/')} passes through a file`);
  }
  return current;
}

/** Exclusive create: an entry can never replace or write through another. */
function openNew(root, parts) {
  if (parts.length === 0) fail('an entry has no name');
  makeDir(root, parts.slice(0, -1));
  try {
    return openSync(join(root, ...parts), 'wx', FILE_MODE);
  } catch (error) {
    if (error.code === 'EEXIST') fail(`the bundle contains ${parts.join('/')} more than once`);
    throw error;
  }
}

// --- Tar -------------------------------------------------------------------

const text = (buffer) => {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString('utf8');
};

function numeric(field, what) {
  // GNU base-256 for values that do not fit the octal field.
  if (field[0] & 0x80) {
    let value = 0n;
    for (let i = 1; i < field.length; i += 1) value = (value << 8n) | BigInt(field[i]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${what} is implausibly large`);
    return Number(value);
  }
  const digits = text(field).trim();
  if (digits === '') return 0;
  if (!/^[0-7]+$/.test(digits)) fail(`the archive has a malformed ${what}`);
  return parseInt(digits, 8);
}

function checksumOk(header) {
  let stored;
  try {
    stored = numeric(header.subarray(148, 156), 'header checksum');
  } catch {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += (i >= 148 && i < 156) ? 32 : header[i];
  return sum === stored;
}

function paxRecords(buffer) {
  const records = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(buffer.subarray(offset, space).toString('ascii'));
    if (!Number.isInteger(length) || length <= 0 || offset + length > buffer.length) {
      fail('the archive has a malformed extended header');
    }
    const record = buffer.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/** Reads exact byte counts from a stream, with back-pressure. */
function reader(stream) {
  const iterator = stream[Symbol.asyncIterator]();
  let chunks = [];
  let available = 0;
  let ended = false;

  const fill = async (count) => {
    while (available < count && !ended) {
      const { value, done } = await iterator.next();
      if (done) { ended = true; break; }
      chunks.push(value);
      available += value.length;
    }
  };

  return {
    /** Exactly `count` bytes, or null at a clean end of input. */
    async read(count) {
      await fill(count);
      if (available === 0 && count > 0) return null;
      if (available < count) fail('the archive is truncated');
      const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      const out = all.subarray(0, count);
      const rest = all.subarray(count);
      chunks = rest.length ? [rest] : [];
      available = rest.length;
      return out;
    },
    /** Streams `count` bytes to `sink(chunk)` without buffering them all. */
    async pipe(count, sink) {
      let left = count;
      while (left > 0) {
        await fill(1);
        if (available === 0) fail('the archive is truncated');
        const head = chunks[0];
        const take = Math.min(left, head.length);
        sink(head.subarray(0, take));
        if (take === head.length) chunks.shift(); else chunks[0] = head.subarray(take);
        available -= take;
        left -= take;
      }
    },
  };
}

const TYPE_NAMES = {
  1: 'a hard link', 2: 'a symbolic link', 3: 'a character device', 4: 'a block device',
  6: 'a FIFO', S: 'a sparse file',
};

async function extractTar(stream, root, account) {
  const input = reader(stream);
  let pending = {};
  let longName = null;
  let sawEntry = false;

  for (;;) {
    const header = await input.read(BLOCK);
    if (header === null) break;
    if (header.every((byte) => byte === 0)) {
      // Two zero blocks end an archive; whatever follows is padding.
      break;
    }
    if (!checksumOk(header)) fail('the archive is corrupt, or is not a tar archive');

    const type = String.fromCharCode(header[156] || 0x30);
    const size = numeric(header.subarray(124, 136), 'entry size');
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    // Metadata entries describe the entry that follows them.
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      if (size > MAX_MANIFEST_BYTES) fail('the archive has an oversized extended header');
      const body = (await input.read(padded) ?? fail('the archive is truncated')).subarray(0, size);
      if (type === 'x') pending = paxRecords(body);
      else if (type === 'L') longName = text(body);
      // 'g' sets archive-wide defaults that nothing here uses; 'K' names a
      // link target, and links are rejected below whatever they point at.
      continue;
    }

    const prefix = text(header.subarray(345, 500));
    const ustarName = text(header.subarray(0, 100));
    const isUstar = text(header.subarray(257, 262)) === 'ustar';
    const name = pending.path ?? longName
      ?? (isUstar && prefix ? `${prefix}/${ustarName}` : ustarName);
    const realSize = pending.size !== undefined ? Number(pending.size) : size;
    if (!Number.isSafeInteger(realSize) || realSize < 0) fail('the archive has a malformed entry size');
    const realPadded = Math.ceil(realSize / BLOCK) * BLOCK;
    pending = {};
    longName = null;

    account.entry();
    sawEntry = true;

    if (type === '5') {
      const parts = safePath(name, 'an archive entry');
      makeDir(root, parts);
      if (realPadded) await input.pipe(realPadded, () => {});
      continue;
    }
    if (type !== '0' && type !== '7') {
      fail(`the bundle contains ${TYPE_NAMES[type] ?? `an unsupported entry (type ${JSON.stringify(type)})`}: `
        + `${name}. Bundles hold only regular files and directories.`);
    }
    // A pre-POSIX archive marks a directory with a trailing slash.
    if (name.endsWith('/')) {
      makeDir(root, safePath(name, 'an archive entry'));
      if (realPadded) await input.pipe(realPadded, () => {});
      continue;
    }

    const parts = safePath(name, 'an archive entry');
    account.bytes(realSize);
    const fd = openNew(root, parts);
    try {
      await input.pipe(realSize, (chunk) => {
        let written = 0;
        while (written < chunk.length) written += writeSync(fd, chunk, written);
      });
    } finally {
      closeSync(fd);
    }
    if (realPadded > realSize) await input.pipe(realPadded - realSize, () => {});
  }

  if (!sawEntry) fail('the archive is empty');
}

// --- Directory bundles -----------------------------------------------------

function copyTree(source, root, account) {
  const walk = (from, parts) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const here = [...parts, entry.name];
      const path = join(from, entry.name);
      // lstat, never stat: a link is reported as a link, not followed.
      const info = lstatSync(path);
      account.entry();
      safePath(here.join('/'), 'a bundle entry');
      if (info.isDirectory()) {
        makeDir(root, here);
        walk(path, here);
      } else if (info.isFile()) {
        account.bytes(info.size);
        const out = openNew(root, here);
        const input = openSync(path, 'r');
        try {
          const buffer = Buffer.allocUnsafe(1024 * 1024);
          for (;;) {
            const count = readSync(input, buffer, 0, buffer.length, null);
            if (count === 0) break;
            let written = 0;
            while (written < count) written += writeSync(out, buffer, written, count - written);
          }
        } finally {
          closeSync(input);
          closeSync(out);
        }
      } else {
        const kind = info.isSymbolicLink() ? 'a symbolic link' : 'a special file';
        fail(`the bundle contains ${kind}: ${here.join('/')}. Bundles hold only regular files and directories.`);
      }
    }
  };
  walk(source, []);
}

// --- Detecting what was given ----------------------------------------------

function sniff(path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(BLOCK);
    const count = readSync(fd, head, 0, BLOCK, 0);
    if (count >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'tgz';
    if (count >= 4 && head[0] === 0x50 && head[1] === 0x4b) return 'zip';
    if (count === BLOCK && text(head.subarray(257, 262)) === 'ustar') return 'tar';
    return 'unknown';
  } finally {
    closeSync(fd);
  }
}

// --- Manifest --------------------------------------------------------------

const KINDS = ['mysql-dump', 'mysql-data', 'portable'];
const DRAFT_ALIASES = ['ghostVersion', 'sourceEnvironment', 'configValues'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function regularFile(root, raw, what) {
  const parts = safePath(raw, what);
  let info;
  try {
    info = lstatSync(join(root, ...parts));
  } catch {
    fail(`${what} names ${raw}, which is not in the bundle`);
  }
  if (!info.isFile()) fail(`${what} names ${raw}, which is not a regular file`);
  return parts.join('/');
}

function httpUrl(value, what) {
  if (typeof value !== 'string') fail(`${what} is missing or is not a string`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${what} is not a URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail(`${what} is not an http(s) URL: ${value}`);
}

/** Validates a parsed manifest against docs/bundle-v1.md. Returns it unchanged. */
export function validateManifest(manifest, root) {
  if (!isObject(manifest)) fail('manifest.json is not a JSON object');

  if (manifest.bundleVersion !== 1) {
    fail(`this is not a version 1 bundle (bundleVersion is ${JSON.stringify(manifest.bundleVersion)}). `
      + 'Export it again with Ghost-CLI 1.33.0 or later.');
  }
  for (const alias of DRAFT_ALIASES) {
    if (alias in manifest) fail(`manifest.json uses the unsupported draft field ${alias}. Export the site again with Ghost-CLI 1.33.0 or later.`);
  }

  const created = manifest.bundleCreatedAt;
  if (typeof created !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(created)
    || Number.isNaN(Date.parse(created))) {
    fail('manifest.json has no valid bundleCreatedAt (an RFC 3339 timestamp in UTC)');
  }

  if (manifest.sourceInstallType !== 'local' && manifest.sourceInstallType !== 'production') {
    fail(`manifest.json sourceInstallType must be "local" or "production", not ${JSON.stringify(manifest.sourceInstallType)}`);
  }
  if (!KINDS.includes(manifest.kind)) {
    fail(`manifest.json kind must be one of ${KINDS.join(', ')}, not ${JSON.stringify(manifest.kind)}`);
  }

  const version = manifest.ghost?.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail('manifest.json has no exact ghost.version');
  }
  if (!version.startsWith('6.')) {
    fail(`the source site runs Ghost ${version}; only Ghost 6.x can be imported. `
      + 'Run `ghost update` in the source installation, then export it again.');
  }

  httpUrl(manifest.url, 'manifest.json url');
  if (manifest.adminUrl !== undefined && manifest.adminUrl !== null) httpUrl(manifest.adminUrl, 'manifest.json adminUrl');

  if (manifest.content !== 'content/') fail('manifest.json content must be "content/"');
  let content;
  try {
    content = lstatSync(join(root, 'content'));
  } catch {
    fail('the bundle has no content/ directory');
  }
  if (!content.isDirectory()) fail('content/ in the bundle is not a directory');

  const database = manifest.database;
  if (!isObject(database)) fail('manifest.json has no database object');
  if ('kind' in database) fail('manifest.json uses the unsupported draft field database.kind. Export the site again with Ghost-CLI 1.33.0 or later.');

  if (manifest.kind === 'portable') {
    regularFile(root, database.path, 'manifest.json database.path');
    regularFile(root, database.members, 'manifest.json database.members');
  } else {
    if (database.path !== 'database.sql') fail(`manifest.json database.path must be "database.sql" for a ${manifest.kind} bundle`);
    regularFile(root, database.path, 'manifest.json database.path');
  }

  if (manifest.kind === 'mysql-data') {
    const rows = database.rows;
    if (!isObject(rows) || Object.keys(rows).length === 0) {
      fail('manifest.json database.rows is required for a mysql-data bundle');
    }
    for (const [table, count] of Object.entries(rows)) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(table)) fail(`manifest.json database.rows names an invalid table: ${JSON.stringify(table)}`);
      if (!Number.isSafeInteger(count) || count < 0) fail(`manifest.json database.rows.${table} is not a row count`);
    }
  }

  const config = manifest.config;
  if (!isObject(config)) fail('manifest.json has no config object');
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'string') fail(`manifest.json config.${key} is not a string; bundle v1 config values are raw strings`);
  }

  return manifest;
}

// --- Staging ---------------------------------------------------------------

/**
 * An archive made with `tar -C parent name` keeps the bundle under one top
 * level directory. That is the same bundle, so it is lifted to the root.
 */
function liftSingleRoot(root) {
  if (existsSync(join(root, 'manifest.json'))) return;
  // macOS tar adds `._name` metadata files beside what it archives; they do
  // not make the wrapping directory any less the only thing in the archive.
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => !(entry.isFile() && entry.name.startsWith('._')));
  if (entries.length !== 1 || !entries[0].isDirectory()) return;
  const inner = join(root, entries[0].name);
  if (!existsSync(join(inner, 'manifest.json'))) return;
  const aside = `${root}.lift`;
  renameSync(inner, aside);
  rmSync(root, { recursive: true });
  renameSync(aside, root);
}

export async function stage(bundle, staging) {
  const root = join(staging, 'bundle');
  let source;
  try {
    source = lstatSync(bundle);
  } catch {
    fail(`there is no bundle at ${process.env.GD_IMPORT_BUNDLE_NAME ?? bundle}`);
  }
  if (existsSync(root)) fail(`${root} already exists`);
  mkdirSync(root, { mode: 0o700 });

  try {
    const account = budget(staging);
    if (source.isDirectory()) {
      copyTree(bundle, root, account);
    } else if (source.isFile()) {
      const kind = sniff(bundle);
      if (kind === 'zip') {
        fail('zip bundles are not read directly. Extract the archive and pass the resulting directory, '
          + 'or export again with `--archive tgz`.');
      }
      if (kind === 'unknown') fail('the bundle is neither a directory nor a tar archive made by `ghost migrate-export`');
      const file = createReadStream(bundle);
      const stream = kind === 'tgz' ? file.pipe(createGunzip()) : file;
      try {
        await extractTar(stream, root, account);
      } catch (error) {
        if (error instanceof BundleError) throw error;
        if (typeof error.code === 'string' && error.code.startsWith('Z_')) fail('the archive is corrupt or truncated');
        throw error;
      } finally {
        file.destroy();
      }
    } else {
      fail('the bundle is neither a directory nor a regular file');
    }

    liftSingleRoot(root);

    const manifestPath = join(root, 'manifest.json');
    let info;
    try {
      info = lstatSync(manifestPath);
    } catch {
      fail('the bundle has no manifest.json; it was not made by `ghost migrate-export`');
    }
    if (!info.isFile()) fail('manifest.json is not a regular file');
    if (info.size > MAX_MANIFEST_BYTES) fail('manifest.json is implausibly large');

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      fail('manifest.json is not valid JSON');
    }
    validateManifest(manifest, root);

    // The validated manifest, kept beside the bundle rather than inside it so
    // later steps read exactly what was checked.
    const fd = openSync(join(staging, 'manifest.json'), 'wx', PRIVATE_FILE_MODE);
    try {
      writeSync(fd, `${JSON.stringify(manifest)}\n`);
    } finally {
      closeSync(fd);
    }
    return manifest;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.lift`, { recursive: true, force: true });
    rmSync(join(staging, 'manifest.json'), { force: true });
    throw error;
  }
}

// --- Command line ----------------------------------------------------------

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const [command, bundle, staging] = process.argv.slice(2);
  if (command !== 'stage' || !bundle || !staging) {
    process.stderr.write('usage: import-helper.mjs stage BUNDLE STAGING\n');
    process.exit(2);
  }
  try {
    const manifest = await stage(bundle, staging);
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  } catch (error) {
    if (error instanceof BundleError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}
