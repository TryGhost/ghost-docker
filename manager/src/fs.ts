// Writing files into the site directory.
//
// Everything is written as the caller (the entrypoint dropped to their uid and
// gid), so ownership needs no fixing up. A file is replaced atomically: written
// beside its destination, flushed, and renamed over it, so a reader never sees
// half of one and a failure never leaves one truncated.
import { randomBytes } from 'node:crypto';
import {
    closeSync,
    cpSync,
    fchmodSync,
    existsSync,
    fsyncSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Credentials can be in any file the manager writes until it says otherwise. */
export const PRIVATE = 0o600;

/**
 * Replace `path` with `content`. The mode is `mode` when given, otherwise the
 * existing file's, otherwise private.
 */
export function atomicWrite(path: string, content: string | Buffer, mode?: number): void {
    const target = mode ?? (existsSync(path) ? statSync(path).mode & 0o7777 : PRIVATE);
    const temporary = join(
        dirname(path),
        `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`,
    );
    // Created with the final mode, so the content is never readable by anyone
    // it should not be, even for an instant.
    const fd = openSync(temporary, 'wx', target);
    try {
        // The umask must not loosen or tighten what was asked for.
        fchmodSync(fd, target);
        writeSync(fd, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
        fsyncSync(fd);
    } catch (error) {
        closeSync(fd);
        rmSync(temporary, { force: true });
        throw error;
    }
    closeSync(fd);
    try {
        renameSync(temporary, path);
    } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    }
}

/** A file's text, or undefined when it does not exist. */
export function readIfExists(path: string): string | undefined {
    try {
        return readFileSync(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

/** Permission bits of a file, or undefined when it does not exist. */
export function modeOf(path: string): number | undefined {
    try {
        return statSync(path).mode & 0o777;
    } catch {
        return undefined;
    }
}

/** Whether `a` and `b` hold the same: a file's bytes, a directory's entries, recursively. */
export function sameTree(a: string, b: string): boolean {
    if (!existsSync(a) || !existsSync(b)) {
        return false;
    }
    const left = statSync(a);
    const right = statSync(b);
    if (left.isDirectory() !== right.isDirectory()) {
        return false;
    }
    if (!left.isDirectory()) {
        return readFileSync(a).equals(readFileSync(b));
    }
    const entries = readdirSync(a).sort();
    const others = readdirSync(b).sort();
    return (
        entries.join('\0') === others.join('\0') &&
        entries.every((entry) => sameTree(join(a, entry), join(b, entry)))
    );
}

/**
 * Copies each of `paths`, relative to `from`, that exists to the same place
 * under `to`, keeping timestamps. Returns the paths it copied.
 */
export function copyPresent(from: string, paths: Iterable<string>, to: string): string[] {
    const copied: string[] = [];
    for (const path of new Set(paths)) {
        const source = join(from, path);
        if (existsSync(source)) {
            cpSync(source, join(to, path), { recursive: true, preserveTimestamps: true });
            copied.push(path);
        }
    }
    return copied;
}
