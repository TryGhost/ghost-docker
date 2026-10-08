// Reading a migration bundle: unpacked into private staging inside the site
// directory, and validated there ("Reading the bundle" in docs/bundle-v1.md).
//
// Importing a bundle means trusting it: its SQL becomes the site's database
// and its themes become the site. What is defended here is narrower. Nothing
// in a bundle can be written outside the staging directory, and nothing in it
// is anything but a regular file or a directory: every entry is checked
// before anything is extracted (an absolute path, a `..` component, a
// symbolic or hard link, a device or any other special entry is refused), and
// the unpacked tree is checked again afterwards whatever produced it.
//
// Every later step of an import works from the staged copy; the bundle itself
// is only ever read, and the launcher mounts it read-only.
import {
    chmodSync,
    closeSync,
    copyFileSync,
    createWriteStream,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    rmSync,
    statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import yauzl from 'yauzl';
import { CliError } from '../errors.ts';
import type { Io } from '../io.ts';
import { CONTENT_ROOT, namedFiles, readManifest, type BundleManifest } from './manifest.ts';

/** The staging directory, inside the site directory. */
export const STAGING = '.import';
/** Kept free on the site's filesystem after unpacking, for the database load. */
export const RESERVE_BYTES = 256 * 1024 ** 2;
const MANIFEST_LIMIT = 1024 * 1024;

/** A bundle that is not one, or not one this host can take. Nothing was changed. */
export class BundleRefused extends CliError {}

export interface StagedBundle {
    /** The private staging directory; removed when the import ends. */
    readonly staging: string;
    /** The bundle's root inside it: where manifest.json is. */
    readonly root: string;
    readonly manifest: BundleManifest;
}

type EntryType = 'file' | 'directory' | 'symlink' | 'hardlink' | 'special';

const ONLY_FILES = 'Bundles hold only regular files and directories.';

/** Refuses an entry that is not a plain file or directory inside the bundle. */
function checkEntry(name: string, type: EntryType): void {
    const parts = name.split('/');
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || parts.includes('..')) {
        throw new BundleRefused(`the archive holds a path that leaves the bundle: ${name}`);
    }
    switch (type) {
        case 'symlink':
            throw new BundleRefused(
                `the bundle contains a symbolic link: ${clean(name)}. ${ONLY_FILES}`,
            );
        case 'hardlink':
            throw new BundleRefused(
                `the bundle contains a hard link: ${clean(name)}. ${ONLY_FILES}`,
            );
        case 'special':
            throw new BundleRefused(
                `the bundle contains a special file: ${clean(name)}. ${ONLY_FILES}`,
            );
        default:
    }
}

/** `./content/x` as `content/x`. */
const clean = (name: string) => name.replace(/^(\.\/)+/, '').replace(/\/$/, '');

/**
 * macOS tar stores extended attributes as `._name` AppleDouble files beside
 * each entry. They are not part of the bundle; macOS's own tar turns them
 * back into attributes on extraction, and they are skipped here.
 */
const isAppleDouble = (name: string) => basename(name).startsWith('._');

const megabytes = (bytes: number) => `${Math.floor(bytes / 1024 ** 2)} MB`;

function checkSpace(io: Io, target: string, needed: number): void {
    const free = io.freeBytes(target);
    if (free !== null && needed + RESERVE_BYTES > free) {
        throw new BundleRefused(
            `the bundle unpacks to ${megabytes(needed)} and the site directory's filesystem has ${megabytes(free)} free; ` +
                `an import needs that and ${megabytes(RESERVE_BYTES)} more for the database`,
        );
    }
}

// --- Directories --------------------------------------------------------------

/** Every entry under `root`, relative to it, not following links. */
function walk(root: string): { name: string; type: EntryType; size: number }[] {
    const found: { name: string; type: EntryType; size: number }[] = [];
    const visit = (relative: string) => {
        for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort(
            (a, b) => a.name.localeCompare(b.name),
        )) {
            const name = relative === '' ? entry.name : `${relative}/${entry.name}`;
            if (entry.isDirectory()) {
                found.push({ name, type: 'directory', size: 0 });
                visit(name);
            } else if (entry.isFile()) {
                found.push({ name, type: 'file', size: lstatSync(join(root, name)).size });
            } else {
                found.push({ name, type: entry.isSymbolicLink() ? 'symlink' : 'special', size: 0 });
            }
        }
    };
    visit('');
    return found;
}

function copyDirectory(io: Io, bundle: string, target: string): void {
    const entries = walk(bundle);
    for (const entry of entries) {
        checkEntry(entry.name, entry.type);
    }
    checkSpace(
        io,
        target,
        entries.reduce((sum, entry) => sum + entry.size, 0),
    );
    for (const entry of entries) {
        const destination = join(target, entry.name);
        if (entry.type === 'directory') {
            mkdirSync(destination, { mode: 0o700 });
        } else {
            copyFileSync(join(bundle, entry.name), destination);
        }
    }
}

// --- Tar archives -----------------------------------------------------------

const TAR_TYPES: Record<string, EntryType> = {
    File: 'file',
    OldFile: 'file',
    ContiguousFile: 'file',
    Directory: 'directory',
    SymbolicLink: 'symlink',
    Link: 'hardlink',
};

const NOT_AN_ARCHIVE =
    'the bundle is not an archive made by `ghost migrate-export`, or it is corrupt or truncated';

/** A tar archive, compressed or not: node-tar recognises gzip itself. */
async function unpackTar(io: Io, bundle: string, target: string): Promise<void> {
    // Every entry is checked before anything is written.
    let size = 0;
    let refused: unknown = null;
    try {
        await tar.t({
            file: bundle,
            strict: true,
            onReadEntry: (entry) => {
                try {
                    checkEntry(entry.path, TAR_TYPES[entry.type] ?? 'special');
                } catch (problem) {
                    refused ??= problem;
                }
                size += entry.size ?? 0;
            },
        });
    } catch {
        throw new BundleRefused(NOT_AN_ARCHIVE);
    }
    if (refused !== null) {
        throw refused;
    }
    checkSpace(io, target, size);

    // And filtered again as it is extracted, whatever the listing said.
    let unexpected: string | null = null;
    try {
        await tar.x({
            file: bundle,
            cwd: target,
            strict: true,
            preserveOwner: false,
            filter: (path, entry) => {
                const type = TAR_TYPES[(entry as tar.ReadEntry).type] ?? 'special';
                if (type !== 'file' && type !== 'directory') {
                    unexpected ??= path;
                    return false;
                }
                return !(type === 'file' && isAppleDouble(path));
            },
        });
    } catch {
        throw new BundleRefused(NOT_AN_ARCHIVE);
    }
    if (unexpected !== null) {
        throw new BundleRefused(
            `the bundle contains a special file: ${clean(unexpected)}. ${ONLY_FILES}`,
        );
    }
}

// --- Zip archives -------------------------------------------------------------

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

const openZip = (path: string) =>
    new Promise<yauzl.ZipFile>((resolve, reject) =>
        yauzl.open(path, { lazyEntries: true, autoClose: false }, (error, zip) =>
            error ? reject(error) : resolve(zip),
        ),
    );

function zipEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
    return new Promise((resolve, reject) => {
        const entries: yauzl.Entry[] = [];
        zip.on('entry', (entry: yauzl.Entry) => {
            entries.push(entry);
            zip.readEntry();
        });
        zip.on('end', () => resolve(entries));
        zip.on('error', reject);
        zip.readEntry();
    });
}

/** What a zip entry is, from the Unix mode in its external attributes. */
function zipType(entry: yauzl.Entry): EntryType {
    const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
    if (mode === S_IFLNK) {
        return 'symlink';
    }
    if (mode === S_IFDIR || entry.fileName.endsWith('/')) {
        return 'directory';
    }
    // No Unix mode at all: an archiver that records none makes plain files.
    return mode === 0 || mode === S_IFREG ? 'file' : 'special';
}

async function unpackZip(io: Io, bundle: string, target: string): Promise<void> {
    let zip: yauzl.ZipFile;
    let entries: yauzl.Entry[];
    try {
        zip = await openZip(bundle);
        entries = await zipEntries(zip);
    } catch (error) {
        // yauzl refuses unsafe names itself, before they are ever handed over.
        const message = (error as Error).message;
        const unsafe = /^(?:invalid relative path|absolute path): (.*)$/.exec(message);
        if (unsafe) {
            throw new BundleRefused(
                `the archive holds a path that leaves the bundle: ${unsafe[1]}`,
            );
        }
        throw new BundleRefused(NOT_AN_ARCHIVE);
    }
    try {
        for (const entry of entries) {
            checkEntry(entry.fileName, zipType(entry));
        }
        checkSpace(
            io,
            target,
            entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0),
        );
        for (const entry of entries) {
            const destination = join(target, entry.fileName);
            if (zipType(entry) === 'directory') {
                mkdirSync(destination, { recursive: true, mode: 0o700 });
                continue;
            }
            mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
            const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
                zip.openReadStream(entry, (error, opened) =>
                    error ? reject(error) : resolve(opened),
                ),
            );
            await pipeline(stream, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
        }
    } catch (error) {
        if (error instanceof BundleRefused) {
            throw error;
        }
        throw new BundleRefused(NOT_AN_ARCHIVE);
    } finally {
        zip.close();
    }
}

// --- The bundle ---------------------------------------------------------------

/** The first bytes of a file. */
function magic(path: string, length: number): Buffer {
    const fd = openSync(path, 'r');
    try {
        const buffer = Buffer.alloc(length);
        return buffer.subarray(0, readSync(fd, buffer, 0, length, 0));
    } finally {
        closeSync(fd);
    }
}

/** Copies or unpacks the bundle into the empty `target`. */
async function unpack(io: Io, bundle: string, target: string): Promise<void> {
    let stats;
    try {
        stats = statSync(bundle);
    } catch {
        throw new BundleRefused(`there is no bundle at ${bundle}`);
    }
    if (stats.isDirectory()) {
        copyDirectory(io, bundle, target);
    } else if (!stats.isFile()) {
        throw new BundleRefused(`${bundle} is neither a bundle directory nor an archive`);
    } else if (magic(bundle, 2).toString('latin1') === 'PK') {
        // By content, not by name.
        await unpackZip(io, bundle, target);
    } else {
        await unpackTar(io, bundle, target);
    }
}

/**
 * An archive made with `tar -C parent name` keeps the bundle under one top
 * level directory. That is the same bundle, whose root is that directory.
 */
function bundleRoot(unpacked: string): string {
    if (existsSync(join(unpacked, 'manifest.json'))) {
        return unpacked;
    }
    const entries = readdirSync(unpacked).filter((name) => !isAppleDouble(name));
    const only = entries.length === 1 ? join(unpacked, entries[0]!) : null;
    return only !== null && lstatSync(only).isDirectory() && existsSync(join(only, 'manifest.json'))
        ? only
        : unpacked;
}

/** The unpacked bundle meets the contract, or this says how it does not. */
function validate(root: string): BundleManifest {
    for (const entry of walk(root)) {
        checkEntry(entry.name, entry.type);
    }
    const path = join(root, 'manifest.json');
    if (!existsSync(path)) {
        throw new BundleRefused(
            'the bundle has no manifest.json; it was not made by `ghost migrate-export`',
        );
    }
    if (lstatSync(path).size > MANIFEST_LIMIT) {
        throw new BundleRefused('manifest.json is implausibly large');
    }
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        throw new BundleRefused('manifest.json is not valid JSON');
    }
    const result = readManifest(value);
    if (!result.ok) {
        throw new BundleRefused(
            `manifest.json does not meet bundle v1 (docs/bundle-v1.md):\n${result.problems.map((problem) => `    ${problem}`).join('\n')}`,
        );
    }
    const content = join(root, CONTENT_ROOT);
    if (!existsSync(content) || !lstatSync(content).isDirectory()) {
        throw new BundleRefused('the bundle has no content/ directory');
    }
    for (const file of namedFiles(result.manifest)) {
        const named = join(root, file);
        if (!existsSync(named) || !lstatSync(named).isFile()) {
            throw new BundleRefused(
                `manifest.json names ${file}, which is not a file in the bundle`,
            );
        }
    }
    return result.manifest;
}

/**
 * Content is served by Ghost and read by theme developers, like the content
 * of a fresh install, whatever modes the archive recorded; everything else
 * stays private to the caller.
 */
function settleModes(root: string): void {
    for (const entry of walk(root)) {
        const path = join(root, entry.name);
        const content = entry.name === 'content' || entry.name.startsWith('content/');
        if (entry.type === 'directory') {
            chmodSync(path, content ? 0o755 : 0o700);
        } else {
            const executable = (lstatSync(path).mode & 0o100) !== 0;
            chmodSync(path, content ? (executable ? 0o755 : 0o644) : 0o600);
        }
    }
}

/**
 * Unpacks BUNDLE into the site's staging directory and validates it. A bundle
 * that is refused leaves nothing behind.
 */
export async function stageBundle(io: Io, dir: string, bundle: string): Promise<StagedBundle> {
    const staging = join(dir, STAGING);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { mode: 0o700 });
    chmodSync(staging, 0o700);
    try {
        const unpacked = join(staging, 'bundle');
        mkdirSync(unpacked, { mode: 0o700 });
        await unpack(io, bundle, unpacked);
        // An archive records its own modes; whatever they were, the caller must
        // be able to read, move and remove what was unpacked.
        for (const entry of walk(unpacked)) {
            if (entry.type === 'directory') {
                chmodSync(join(unpacked, entry.name), 0o700);
            }
        }
        const root = bundleRoot(unpacked);
        const manifest = validate(root);
        const free = io.freeBytes(staging);
        if (free !== null && free < RESERVE_BYTES) {
            throw new BundleRefused(
                `unpacking the bundle left ${megabytes(free)} free on the site directory's filesystem, too little to load its database`,
            );
        }
        settleModes(root);
        return { staging, root, manifest };
    } catch (error) {
        removeStaging(dir);
        throw error;
    }
}

export function removeStaging(dir: string): void {
    const staging = join(dir, STAGING);
    if (!existsSync(staging)) {
        return;
    }
    // Directories the archive made unwritable could not otherwise be emptied.
    try {
        for (const entry of walk(staging)) {
            if (entry.type === 'directory') {
                chmodSync(join(staging, entry.name), 0o700);
            }
        }
    } catch {
        // Removed as far as it can be, below.
    }
    rmSync(staging, { recursive: true, force: true });
}
