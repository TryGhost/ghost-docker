// The application: its commands, how its errors read, and what it exits with.
//
// `run` is the whole CLI as a function: arguments and an Io in, an exit status
// out. main.ts is the only caller that touches the real process.
import { parseArgs } from 'node:util';
import { defineCommand, type Command } from './command.ts';
import { doctorCommand } from './commands/doctor.ts';
import { versionCommand, versionLine } from './commands/version.ts';
import { CliError, EXIT, UsageError } from './errors.ts';
import type { Io } from './io.ts';

const COMMANDS: Record<string, Command> = {
    version: versionCommand,
    doctor: doctorCommand,
    help: defineCommand({
        brief: 'Print this.',
        run: async (_values, _positionals, io) => {
            io.stdout(rootHelp());
            return EXIT.ok;
        },
    }),
};

const DESCRIPTION = `Self-hosted Ghost with Docker Compose: the manager.

Day-to-day operation is plain Docker Compose, from the site directory:
  docker compose ps | logs -f ghost | up -d | down

The plan is docs/ghost-cli-replacement.md in the repository.`;

export async function run(argv: readonly string[], io: Io): Promise<number> {
    const [name = 'help', ...rest] = argv;
    try {
        if (name === '--help' || name === '-h') {
            return await COMMANDS.help!.run({}, [], io);
        }
        if (name === '--version' || name === '-v') {
            io.stdout(`${versionLine().replace(/^ghost-docker /, '')}\n`);
            return EXIT.ok;
        }
        const command = COMMANDS[name];
        if (!command) {
            throw new UsageError(
                `unknown command: ${name}\nRun ghost-docker --help for the commands.`,
            );
        }
        const { values, positionals } = parse(name, command, rest);
        if (values.help === true) {
            io.stdout(commandHelp(name, command));
            return EXIT.ok;
        }
        return await command.run(camelKeys(values), positionals, io);
    } catch (error) {
        io.stderr(`${describe(error)}\n`);
        return error instanceof CliError ? error.exitCode : EXIT.failure;
    }
}

function parse(name: string, command: Command, args: string[]) {
    const usage = (message: string) =>
        new UsageError(`${message}\nRun ghost-docker ${name} --help for its options.`);
    let parsed;
    try {
        parsed = parseArgs({
            args,
            // parseArgs ignores the `brief` each option carries.
            options: { ...command.options, help: { type: 'boolean', short: 'h' } },
            strict: true,
            allowPositionals: true,
        });
    } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')) {
            throw usage((error as Error).message);
        }
        throw error;
    }
    const most = command.positionals ?? 0;
    if (parsed.positionals.length > most) {
        throw usage(
            `too many arguments: expected at most ${most}, got ${parsed.positionals.join(' ')}`,
        );
    }
    return parsed;
}

const camelKeys = <T>(values: Record<string, T>): Record<string, T> =>
    Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
            key.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase()),
            value,
        ]),
    );

/** How errors read: ours by their message, anything else as a bug to report. */
const describe = (error: unknown): string => {
    if (error instanceof CliError) {
        return `error: ${error.message}`;
    }
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return `error: ghost-docker failed unexpectedly. Please report this:\n${detail}`;
};

/** Two columns, the first padded to its widest entry. */
const columns = (rows: [string, string][]) => {
    const width = Math.max(...rows.map(([left]) => left.length));
    return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}\n`).join('');
};

function rootHelp(): string {
    const commands = Object.entries(COMMANDS).map(([name, { brief }]): [string, string] => [
        name,
        brief,
    ]);
    return (
        'USAGE\n' +
        commands.map(([name]) => `  ghost-docker ${usageLine(name)}\n`).join('') +
        '  ghost-docker --help\n  ghost-docker --version\n\n' +
        `${DESCRIPTION}\n\n` +
        'FLAGS\n' +
        columns([
            ['-h --help', 'Print help information and exit'],
            ['-v --version', 'Print version information and exit'],
        ]) +
        '\nCOMMANDS\n' +
        columns(commands)
    );
}

function usageLine(name: string): string {
    const flags = Object.entries(COMMANDS[name]?.options ?? {}).map(([flag, option]) =>
        option.type === 'string' ? `(--${flag} <value>)` : `(--${flag})`,
    );
    return [name, ...flags].join(' ');
}

function commandHelp(name: string, command: Command): string {
    const flags = Object.entries(command.options ?? {}).map(([flag, option]): [string, string] => [
        `${option.short ? `-${option.short}` : '  '} --${flag}${option.type === 'string' ? ' <value>' : ''}`,
        option.brief,
    ]);
    return (
        'USAGE\n' +
        `  ghost-docker ${usageLine(name)}\n` +
        `  ghost-docker ${name} --help\n\n` +
        `${command.brief}\n\n` +
        'FLAGS\n' +
        columns([...flags, ['-h --help', 'Print help information and exit']])
    );
}
