// The application: its commands, how its errors read, and what it exits with.
//
// `run` is the whole CLI as a function: arguments and an Io in, an exit status
// out. main.ts is the only caller that touches the real process.
import {
    buildApplication,
    buildCommand,
    buildRouteMap,
    run as runApplication,
    text_en,
    type ApplicationText,
} from '@stricli/core';
import { doctorCommand } from './commands/doctor.ts';
import { versionCommand, versionLine } from './commands/version.ts';
import { contextFor, type ManagerContext } from './context-stricli.ts';
import { CliError, EXIT, UnimplementedError } from './errors.ts';
import type { Io } from './io.ts';

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

const plannedCommand = (name: string, step: string) =>
    buildCommand<Record<string, never>, [], ManagerContext>({
        func() {
            throw unimplemented(name);
        },
        parameters: { flags: {} },
        docs: { brief: `Not implemented yet; lands in plan step ${step}.` },
    });

const unimplemented = (name: string) => {
    const planned = PLANNED[name]!;
    return new UnimplementedError(`ghost-docker ${name}`, planned.step, planned.hint);
};

function buildApp() {
    const routes = buildRouteMap<string, ManagerContext>({
        routes: {
            version: versionCommand,
            doctor: doctorCommand,
            help: buildCommand<Record<string, never>, [], ManagerContext>({
                async func() {
                    await runApplication(app, ['--help'], this);
                },
                parameters: { flags: {} },
                docs: { brief: 'Print this.' },
            }),
            ...Object.fromEntries(
                Object.entries(PLANNED).map(([name, { step }]) => [
                    name,
                    plannedCommand(name, step),
                ]),
            ),
        },
        docs: {
            brief: 'Self-hosted Ghost with Docker Compose: the manager.',
            fullDescription: `Self-hosted Ghost with Docker Compose: the manager.

Day-to-day operation is plain Docker Compose, from the site directory:
  docker compose ps | logs -f ghost | up -d | down

The plan is docs/ghost-cli-replacement.md in the repository.`,
        },
    });
    const app = buildApplication(routes, {
        name: 'ghost-docker',
        versionInfo: { currentVersion: versionLine().replace(/^ghost-docker /, '') },
        scanner: { caseStyle: 'allow-kebab-for-camel' },
        localization: { loadText: () => text },
        determineExitCode: (error) => (error instanceof CliError ? error.exitCode : EXIT.failure),
    });
    return app;
}

/** How errors read: ours by their message, anything else as a bug to report. */
const describe = (error: unknown): string => {
    if (error instanceof CliError) {
        return `error: ${error.message}`;
    }
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return `error: ghost-docker failed unexpectedly. Please report this:\n${detail}`;
};

const text: ApplicationText = {
    ...text_en,
    noCommandRegisteredForInput: ({ input, corrections }) =>
        `error: unknown command: ${input}` +
        (corrections.length > 0 ? ` (did you mean ${corrections.join(', ')}?)` : '') +
        '\nRun ghost-docker --help for the commands.',
    exceptionWhileParsingArguments(error, ansiColor) {
        return `error: ${text_en.exceptionWhileParsingArguments.call(this, error, ansiColor)}`;
    },
    exceptionWhileRunningCommand: (error) => describe(error),
    commandErrorResult: (error) => describe(error),
};

export async function run(argv: readonly string[], io: Io): Promise<number> {
    // A planned command is refused whatever follows it, and before anything
    // else is checked: a script written against the documented interface gets
    // an answer it can act on. stricli would reject the options first.
    const first = argv[0];
    if (first !== undefined && first in PLANNED) {
        io.stderr(`${describe(unimplemented(first))}\n`);
        return EXIT.unimplemented;
    }

    const context = contextFor(io);
    await runApplication(buildApp(), argv, context);
    return exitStatus(context.process.exitCode);
}

/** stricli's own negative codes for a bad command line become the usage status. */
function exitStatus(code: number | string | null | undefined): number {
    if (typeof code !== 'number') {
        return EXIT.ok;
    }
    if (code >= 0) {
        return code;
    }
    // -4 InvalidArgument, -5 UnknownCommand; the rest are internal failures.
    return code === -4 || code === -5 ? EXIT.usage : EXIT.failure;
}
