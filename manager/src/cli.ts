// The application: its commands, how its errors read, and what it exits with.
//
// `run` is the whole CLI as a function: arguments and an Io in, an exit status
// out. main.ts is the only caller that touches the real process.
import { parseArgs } from 'node:util';
import { defineCommand, type Command } from './command.ts';
import { getCommand, setCommand, validateCommand } from './commands/config.ts';
import { doctorCommand } from './commands/doctor.ts';
import { installCommand } from './commands/install.ts';
import { checkCommand, infoCommand, listCommand } from './commands/site.ts';
import { updateCommand } from './commands/update.ts';
import { versionCommand } from './commands/version.ts';
import { CliError, EXIT, UsageError } from './errors.ts';
import type { Io } from './io.ts';

/** A command of two words, such as `config get`, is keyed by both. */
const COMMANDS: Record<string, Command> = {
    install: installCommand,
    'config get': getCommand,
    'config set': setCommand,
    'config validate': validateCommand,
    check: checkCommand,
    info: infoCommand,
    list: listCommand,
    update: updateCommand,
    version: versionCommand,
    doctor: doctorCommand,
    help: defineCommand({
        brief: 'Print this, or with a command, its help.',
        positionals: ['command', 'subcommand'],
        run: async (_values, topic, io) => {
            const name = topic.join(' ');
            io.stdout(
                name === ''
                    ? rootHelp()
                    : subcommands(name).length > 0
                      ? groupHelp(name)
                      : commandHelp(name, lookup(name)),
            );
            return EXIT.ok;
        },
    }),
};

/** The conventional flags, as the commands they stand for. */
const ALIASES: Record<string, string> = {
    '--help': 'help',
    '-h': 'help',
    '--version': 'version',
    '-v': 'version',
};

const DESCRIPTION = `Self-hosted Ghost with Docker Compose: the manager.

Day-to-day operation is plain Docker Compose, from the site directory:
  docker compose ps | logs -f ghost | up -d | down

The plan is docs/ghost-cli-replacement.md in the repository.`;

export async function run(argv: readonly string[], io: Io): Promise<number> {
    const [first = 'help', ...others] = argv;
    const grouped = `${first} ${others[0]}`;
    const [name, rest] =
        grouped in COMMANDS ? [grouped, others.slice(1)] : [ALIASES[first] ?? first, others];
    // Asking for help wins over whatever else is wrong with the line.
    // After `--` it is an argument like any other.
    const end = rest.indexOf('--');
    const helping = (end === -1 ? rest : rest.slice(0, end)).some(
        (arg) => arg === '--help' || arg === '-h',
    );
    try {
        if (helping && subcommands(name).length > 0) {
            io.stdout(groupHelp(name));
            return EXIT.ok;
        }
        const command = lookup(name);
        if (helping) {
            io.stdout(commandHelp(name, command));
            return EXIT.ok;
        }
        const { values, positionals } = parse(name, command, rest);
        return await command.run(camelKeys(values), positionals, io);
    } catch (error) {
        io.stderr(`${describe(error)}\n`);
        return error instanceof CliError ? error.exitCode : EXIT.failure;
    }
}

function lookup(name: string): Command {
    const command = COMMANDS[name];
    if (!command) {
        const group = subcommands(name);
        throw new UsageError(
            group.length > 0
                ? `${name} takes a subcommand: ${group.map((key) => key.split(' ')[1]).join(', ')}\nRun ghost-docker ${name} --help for them.`
                : `unknown command: ${name}\nRun ghost-docker --help for the commands.`,
        );
    }
    return command;
}

/** `config` → `config get`, `config set`, …; nothing for a one-word command. */
const subcommands = (name: string): string[] =>
    Object.keys(COMMANDS).filter((key) => key.startsWith(`${name} `));

function parse(name: string, command: Command, args: string[]) {
    const usage = (message: string) =>
        new UsageError(`${message}\nRun ghost-docker ${name} --help for its options.`);
    let parsed;
    try {
        parsed = parseArgs({
            args,
            // parseArgs ignores the `brief` each option carries.
            options: command.options ?? {},
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
    const most = command.positionals?.length ?? 0;
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

function groupHelp(name: string): string {
    const group = subcommands(name);
    return (
        'USAGE\n' +
        group.map((key) => `  ghost-docker ${usageLine(key)}\n`).join('') +
        '\nCOMMANDS\n' +
        columns(group.map((key): [string, string] => [key, COMMANDS[key]!.brief]))
    );
}

function usageLine(name: string): string {
    const command = COMMANDS[name];
    const parts = Object.entries(command?.options ?? {}).map(([flag, option]) =>
        option.type === 'string' ? `(--${flag} <value>)` : `(--${flag})`,
    );
    parts.push(...(command?.positionals ?? []).map((positional) => `[<${positional}>]`));
    return [name, ...parts].join(' ');
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
