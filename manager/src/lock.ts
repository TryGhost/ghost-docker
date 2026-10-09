// The site lock (docs/architecture.md#recovery): one operation that changes a running site at a
// time. self-update, backup, restore and `config set` take it; Ghost upgrades
// will when they land.
//
// A file in the site directory, created exclusively, naming the operation and
// when it started. A run that crashes leaves it behind, and nothing removes it
// automatically: the run may have stopped halfway, and only the operator can
// tell. `check` reports it, and says how to remove it.
import { closeSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CliError } from './errors.ts';
import { readIfExists } from './fs.ts';
import { LOCK_FILE } from './site.ts';
import { isoSeconds } from './meta.ts';

const lockSchema = z.object({
    operation: z.string().min(1),
    startedAt: z.string().min(1),
});

export type LockHolder = z.infer<typeof lockSchema>;

export type LockRead =
    | { state: 'free' }
    | { state: 'held'; holder: LockHolder }
    | { state: 'unreadable' };

export const lockPath = (dir: string): string => join(dir, LOCK_FILE);

export function readLock(dir: string): LockRead {
    const text = readIfExists(lockPath(dir));
    if (text === undefined) {
        return { state: 'free' };
    }
    try {
        return { state: 'held', holder: lockSchema.parse(JSON.parse(text)) };
    } catch {
        return { state: 'unreadable' };
    }
}

/** What the lock says, and what to do about one nothing is holding. */
export function describeLock(dir: string, read: LockRead): string {
    const what =
        read.state === 'held'
            ? `${read.holder.operation}, started ${read.holder.startedAt}`
            : 'an operation it does not name';
    return (
        `${LOCK_FILE} is held by ${what}.\n` +
        '  If that is still running, wait for it to finish. If it is not (it was interrupted),\n' +
        `  check the site with ./ghost-docker check, then remove the lock: rm ${lockPath(dir)}`
    );
}

export interface Lock {
    release(): void;
}

/** Take the lock, or refuse naming whoever holds it. */
export function acquireLock(dir: string, operation: string, now = new Date()): Lock {
    const path = lockPath(dir);
    let fd: number;
    try {
        fd = openSync(path, 'wx', 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new CliError(
                `another operation may be changing this site. ${describeLock(dir, readLock(dir))}\n` +
                    '  Nothing has been changed.',
            );
        }
        throw error;
    }
    const holder: LockHolder = {
        operation,
        startedAt: isoSeconds(now),
    };
    try {
        writeSync(fd, `${JSON.stringify(holder)}\n`);
    } finally {
        closeSync(fd);
    }
    return { release: () => rmSync(path, { force: true }) };
}
