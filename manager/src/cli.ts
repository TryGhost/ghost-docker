// The command dispatcher.
//
// `run` is the whole CLI as a function: arguments and an Io in, an exit status
// out. main.ts is the only caller that touches the real process.
import { doctor } from './commands/doctor.ts';
import { CliError, EXIT, UnimplementedError, UsageError } from './errors.ts';
import type { Io } from './io.ts';
import { parseOptions } from './options.ts';
import { managerVersion } from './versions.ts';

const USAGE = `Usage: ghost-docker <command> [options]

Commands
  version    Print the manager's version.
  doctor     Report what the manager can see: Docker, the platform, the site
             directory and who owns what is written there.
             --json         machine-readable output
             --keep-probe   leave the probe file so its ownership can be
                            inspected from the host
  help       Print this.

Not implemented yet; each names the plan step it lands in:
  install, config, caddy, check, info, list, update, backup, restore, upgrade

Day-to-day operation is plain Docker Compose, from the site directory:
  docker compose ps | logs -f ghost | up -d | down

The plan is docs/ghost-cli-replacement.md in the repository.
`;

/** Documented commands whose step has not landed, and the step that delivers each. */
const PLANNED: Record<string, { step: string; hint?: string }> = {
    install: { step: 'N3' },
    config: { step: 'N3' },
    caddy: { step: 'N3' },
    check: { step: 'N3', hint: '`doctor` reports what the manager can see today' },
    info: { step: 'N3' },
    list: { step: 'N3' },
    update: { step: 'S6a' },
    backup: { step: 'S4' },
    restore: { step: 'S4' },
    upgrade: {
        step: 'S7',
        hint: 'until then, change the Ghost version pin and run `docker compose up -d` after a backup',
    },
};

export async function run(argv: readonly string[], io: Io): Promise<number> {
    try {
        return await dispatch(argv, io);
    } catch (error) {
        if (error instanceof CliError) {
            io.stderr(`error: ${error.message}\n`);
            if (error instanceof UsageError) {
                io.stderr('\n' + USAGE);
            }
            return error.exitCode;
        }
        // Anything else is a bug in the manager. Say so, with what is needed to
        // report it, rather than printing a stack trace as if it were guidance.
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        io.stderr(`error: ghost-docker failed unexpectedly. Please report this:\n${detail}\n`);
        return EXIT.failure;
    }
}

async function dispatch(argv: readonly string[], io: Io): Promise<number> {
    const [command, ...args] = argv;

    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
        io.stdout(USAGE);
        return EXIT.ok;
    }

    if (command === 'version' || command === '--version') {
        parseOptions('version', args, {});
        const { version, commit } = managerVersion();
        io.stdout(`ghost-docker ${version}${commit ? ` (${commit.slice(0, 7)})` : ''}\n`);
        return EXIT.ok;
    }

    const planned = PLANNED[command];
    if (planned !== undefined) {
        throw new UnimplementedError(`ghost-docker ${command}`, planned.step, planned.hint);
    }

    if (command === 'doctor') {
        return doctor(args, io);
    }

    throw new UsageError(`unknown command: ${command}`);
}
