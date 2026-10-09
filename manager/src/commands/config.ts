// `config get|set|validate`: the configuration split, read and written
// through the one encoder.
//
// Values are never logged, only key names: any value in either file may be a
// credential, and a list of "sensitive" names would miss one. `get` prints a
// value because it was asked for one.
import { join } from 'node:path';
import { defineCommand } from '../command.ts';
import { operatorKeyTest, validate } from '../config.ts';
import * as env from '../env.ts';
import { EXIT, UsageError } from '../errors.ts';
import { atomicWrite, PRIVATE, readIfExists } from '../fs.ts';
import type { Io } from '../io.ts';
import { printChecks } from '../report.ts';
import { CONFIG_FILES, ENV_FILE, GHOST_ENV_FILE, type ConfigFile } from '../site.ts';
import { installedSite } from './common.ts';

const isConfigFile = (value: string | undefined): value is ConfigFile =>
    (CONFIG_FILES as readonly string[]).includes(value ?? '');

/**
 * `[FILE] KEY ...`. Without a file, the key says where it belongs: `.env`
 * when Compose interpolates it (overrides included), it is a COMPOSE_* setting, or `.env`
 * already has it; otherwise `ghost.env`.
 */
async function target(
    io: Io,
    dir: string,
    args: readonly string[],
    arity: number,
): Promise<{ file: ConfigFile; rest: string[] }> {
    if (args.length === arity + 1) {
        const [file, ...rest] = args;
        if (!isConfigFile(file)) {
            throw new UsageError(
                `the file must be ${CONFIG_FILES.join(' or ')}: got ${JSON.stringify(file)}`,
            );
        }
        return { file, rest };
    }
    if (args.length !== arity) {
        throw new UsageError(`expected ${arity === 1 ? '[FILE] KEY' : '[FILE] KEY VALUE'}`);
    }
    const key = args[0]!;
    if (isConfigFile(key)) {
        throw new UsageError(`expected a key after ${key}`);
    }
    const isOperatorKey = await operatorKeyTest(io, dir);
    return { file: isOperatorKey(key) ? ENV_FILE : GHOST_ENV_FILE, rest: [...args] };
}

function checkKey(key: string): void {
    if (!env.isValidKey(key)) {
        throw new UsageError(`${JSON.stringify(key)} is not a valid variable name`);
    }
}

export const getCommand = defineCommand({
    brief: 'Print one decoded value.',
    positionals: ['file', 'key'],
    run: async (_values, args, io) => {
        const { site } = installedSite(io);
        const { file, rest } = await target(io, site.dir, args, 1);
        const key = rest[0]!;
        checkKey(key);
        const value = env.get(readIfExists(join(site.dir, file)) ?? '', key);
        if (value === undefined) {
            io.stderr(`error: ${key} is not set in ${file}\n`);
            return EXIT.failure;
        }
        io.stdout(`${value}\n`);
        return EXIT.ok;
    },
});

export const setCommand = defineCommand({
    brief:
        'Write one value, encoded for Compose, atomically. Without a file, the key decides: ' +
        'a setting Compose interpolates goes in .env, anything else in ghost.env. ' +
        'A value that starts with a dash goes after --.',
    positionals: ['file', 'key', 'value'],
    run: async (_values, args, io) => {
        const { site } = installedSite(io);
        const { file, rest } = await target(io, site.dir, args, 2);
        const [key, value] = rest as [string, string];
        checkKey(key);
        const path = join(site.dir, file);
        const before = readIfExists(path);
        // A new file is private; an existing one keeps its mode.
        atomicWrite(
            path,
            env.set(before ?? '', key, value),
            before === undefined ? PRIVATE : undefined,
        );
        io.stderr(`updated ${key} in ${file}\n`);
        if (file === ENV_FILE) {
            io.stderr(
                'Compose reads .env when services are created: apply it with docker compose up -d' +
                    (key.endsWith('URL') ? '; the routes are in caddy/sites/site.caddy' : '') +
                    '.\n',
            );
        } else {
            io.stderr(
                'Ghost reads ghost.env when it starts: apply it with docker compose up -d.\n',
            );
        }
        return EXIT.ok;
    },
});

export async function validateSite(io: Io): Promise<number> {
    const { site } = installedSite(io);
    const findings = await io.busy('Validating the configuration', () => validate(io, site.dir));
    printChecks(
        io,
        findings.map((finding) => ({
            status: finding.level === 'error' ? 'error' : 'warn',
            label: finding.file,
            detail: finding.message,
        })),
        10,
    );
    if (findings.some((finding) => finding.level === 'error')) {
        return EXIT.failure;
    }
    io.stdout(
        `.env and ghost.env are valid for ${site.mode === null ? 'this' : `a ${site.mode}`} site\n`,
    );
    return EXIT.ok;
}

export const validateCommand = defineCommand({
    brief: 'Check .env and ghost.env: required keys by mode, exactly one site mode, keys in the wrong file, values Compose would interpolate.',
    run: (_values, _positionals, io) => validateSite(io),
});
