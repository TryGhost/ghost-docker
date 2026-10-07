// The release payload: the files compose.yml needs beside it, which the
// manager image carries and writes into a site directory (plan §2.7).
//
// In image mode `install` writes them, with a checksum of each recorded in the
// metadata so that `update` can tell an untouched file from an edited one, and
// writes a copy of the launcher pinned to the image that installed the site.
// In clone mode the site is a checkout of the repository: the files are
// already there, are used in place, and nothing is written over them.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Context } from './context.ts';
import { inspectImage, splitReference } from './docker/client.ts';
import { CliError } from './errors.ts';
import { atomicWrite } from './fs.ts';
import type { Io } from './io.ts';

export const stackDir = (env: NodeJS.ProcessEnv): string =>
    env.GD_STACK_DIR ?? '/opt/ghost-docker/stack';
export const launcherSource = (env: NodeJS.ProcessEnv): string =>
    env.GD_LAUNCHER_SOURCE ?? '/opt/ghost-docker/launcher/ghost-docker';

/** The launcher's name in a site directory. */
export const LAUNCHER = 'ghost-docker';

export const sha256 = (content: string | Buffer): string =>
    createHash('sha256').update(content).digest('hex');

/** Is this site directory a checkout of the repository, whose files are used in place? */
export const isCheckout = (context: Context, dir: string): boolean =>
    context.source === 'checkout' && existsSync(join(dir, 'manager', 'Dockerfile'));

/** Every file of the payload, relative to the stack directory, in a stable order. */
export function payloadFiles(stack: string): string[] {
    const files: string[] = [];
    const walk = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
        )) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(path);
            } else if (entry.isFile()) {
                files.push(relative(stack, path));
            }
        }
    };
    walk(stack);
    return files;
}

/** Paths, files and directories, the payload and launcher would write over. */
export function payloadConflicts(dir: string, files: readonly string[]): string[] {
    return [...files, LAUNCHER].filter((file) => existsSync(join(dir, file)));
}

export interface Written {
    /** Checksums by relative path, for the metadata. */
    readonly checksums: Record<string, string>;
    /** Absolute paths of files created, in order. */
    readonly files: string[];
    /** Absolute paths of directories created, outermost first. */
    readonly directories: string[];
}

/** Create a directory and its missing parents, recording each one created. */
export function makeDirectories(path: string, created: string[]): void {
    if (existsSync(path)) {
        return;
    }
    makeDirectories(dirname(path), created);
    mkdirSync(path, { mode: 0o755 });
    created.push(path);
}

/** Copy the payload into the site, keeping each file's mode. */
export function writePayload(
    dir: string,
    stack: string,
    files: readonly string[],
    written: Written,
): void {
    for (const file of files) {
        const source = join(stack, file);
        const target = join(dir, file);
        makeDirectories(dirname(target), written.directories);
        const content = readFileSync(source);
        atomicWrite(target, content, statSync(source).mode & 0o777);
        written.files.push(target);
        written.checksums[file] = sha256(content);
    }
}

/**
 * The image the site's launcher runs: its repository digest, or, for an image
 * that has none, its own ID.
 */
export async function managerPin(io: Io, context: Context): Promise<string> {
    if (context.image === null) {
        throw new CliError(
            'the launcher did not say which image this is, so the site’s launcher cannot be pinned to it',
        );
    }
    const image = await inspectImage(io.docker, context.image);
    if (image === null) {
        throw new CliError(
            `the daemon does not hold ${context.image}, the image this manager runs from`,
        );
    }
    const repository = splitReference(context.image).repository;
    return image.repoDigests.find((entry) => entry.startsWith(`${repository}@`)) ?? image.id;
}

/** The launcher, with the pin written into it. */
export function pinnedLauncher(source: string, pin: string): string {
    const marker = /^readonly GD_PINNED_IMAGE=""$/m;
    if (!marker.test(source) || !/^[A-Za-z0-9._/:@-]+$/.test(pin)) {
        throw new CliError('the launcher in this image cannot be pinned; please report this');
    }
    return source.replace(marker, `readonly GD_PINNED_IMAGE="${pin}"`);
}

export function writeLauncher(
    dir: string,
    env: NodeJS.ProcessEnv,
    pin: string,
    written: Written,
): void {
    const content = pinnedLauncher(readFileSync(launcherSource(env), 'utf8'), pin);
    const target = join(dir, LAUNCHER);
    atomicWrite(target, content, 0o755);
    written.files.push(target);
    written.checksums[LAUNCHER] = sha256(content);
}
