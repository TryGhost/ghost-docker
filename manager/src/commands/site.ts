// `check`, `info` and `list`: what a site, or this host, looks like now.
import { defineCommand } from '../command.ts';
import { compose, composeError, composePs } from '../compose.ts';
import { validate } from '../config.ts';
import { loadContext } from '../context.ts';
import { listContainers } from '../docker/client.ts';
import { EXIT } from '../errors.ts';
import type { Io } from '../io.ts';
import { describeMetadata, readMetadata } from '../meta.ts';
import { failed, printChecks, type Check } from '../report.ts';
import { hasProfile, readSettings } from '../site.ts';
import { verifyIngress } from '../verify.ts';
import { installedSite } from './common.ts';
import { collect } from './doctor.ts';

const MANAGED_LABEL = 'org.ghost.docker.managed=true';

// --- check --------------------------------------------------------------------

/**
 * Diagnose a site: its host, its configuration, its services and database,
 * and its ingress. Host checks come first, because they are what still works
 * when Docker is broken, which is when a diagnosis matters most.
 */
export async function check(io: Io): Promise<number> {
    const { context, site } = installedSite(io);
    const all: Check[] = [];
    const section = (title: string, checks: Check[]) => {
        io.stdout(`\n${title}\n`);
        printChecks(io, checks);
        all.push(...checks);
    };

    io.stdout(`Site directory\n  ${site.dir}\n\nInstallation\n`);
    const metadata = readMetadata(site.dir);
    for (const line of describeMetadata(metadata)) {
        io.stdout(`  ${line}\n`);
    }
    if (metadata.state === 'invalid') {
        all.push({ status: 'error', label: 'metadata', detail: metadata.reason });
    }

    const host = await io.busy('Checking Docker and the site directory', () =>
        collect(context, io),
    );
    section('Host', host);

    const findings = await io.busy('Validating the configuration', () => validate(io, site.dir));
    section(
        'Configuration',
        findings.length === 0
            ? [
                  {
                      status: 'ok',
                      label: 'configuration',
                      detail: `.env and ghost.env are valid for a ${site.mode ?? 'mode-less'} site`,
                  },
              ]
            : findings.map((finding) => ({
                  status: finding.level === 'error' ? 'error' : 'warn',
                  label: finding.file,
                  detail: finding.message,
              })),
    );

    // doctor reports the daemon only when it cannot be reached.
    if (host.some((check) => check.label === 'docker daemon')) {
        io.stdout('\nServices\n  skipped: the Docker daemon is not reachable.\n');
        return EXIT.failure;
    }

    const services = await io.busy('Reading the services', () => composePs(io, site.dir));
    // Every container the project has, judged by its own state: a service is
    // running and healthy (or has no health check), a one-shot job exited 0.
    const serviceChecks: Check[] = (services ?? []).map((state) => {
        const done = state.State === 'exited' && state.ExitCode === 0;
        const healthy =
            state.State === 'running' && (state.Health === '' || state.Health === 'healthy');
        return {
            status: done || healthy ? 'ok' : 'error',
            label: state.Service,
            detail: done
                ? 'completed'
                : [
                      state.State,
                      state.Health,
                      state.State === 'exited' ? `exit ${state.ExitCode}` : '',
                  ]
                      .filter(Boolean)
                      .join(', '),
        };
    });
    if (services?.length === 0) {
        serviceChecks.push({
            status: 'error',
            label: 'services',
            detail: 'no containers. Start the site with: docker compose up -d',
        });
    }
    if (services === null) {
        serviceChecks.unshift({
            status: 'error',
            label: 'services',
            detail: 'docker compose ps failed',
        });
    }
    serviceChecks.push(
        await io.busy('Connecting to the database', () =>
            database(io, site.dir, site.settings.get),
        ),
    );
    section('Services', serviceChecks);

    const running = serviceChecks.find((entry) => entry.label === 'ghost')?.status === 'ok';
    if (running) {
        const ingress = await io.busy('Reaching the site through its ingress', () =>
            verifyIngress(io, site, services),
        );
        section('Ingress', ingress);
    } else {
        io.stdout('\nIngress\n  skipped: Ghost is not running.\n');
    }

    if (failed(all)) {
        io.stderr('\nProblems were reported above.\n');
        return EXIT.failure;
    }
    io.stdout('\nThis site looks healthy.\n');
    return EXIT.ok;
}

/**
 * A real client connection to the application database, as the application
 * user. The password reaches the client through MYSQL_PWD in its
 * environment, not its arguments.
 */
async function database(
    io: Io,
    dir: string,
    get: (key: string) => string | undefined,
): Promise<Check> {
    const result = await compose(
        io,
        dir,
        [
            'exec',
            '-T',
            '-e',
            'MYSQL_PWD',
            'db',
            'mysql',
            '-h',
            '127.0.0.1',
            '-u',
            get('DATABASE_USER') || 'ghost',
            '-e',
            'SELECT 1',
            get('DATABASE_NAME') || 'ghost',
        ],
        { timeoutMs: 60_000, env: { MYSQL_PWD: get('DATABASE_PASSWORD') ?? '' } },
    );
    return result.exitCode === 0
        ? {
              status: 'ok',
              label: 'database',
              detail: 'accepts a client connection to the application database',
          }
        : {
              status: 'error',
              label: 'database',
              detail: `could not be reached with the configured credentials: ${composeError(result, 1) || 'no answer'}`,
          };
}

export const checkCommand = defineCommand({
    brief: 'Diagnose this site: host, configuration, services, database connectivity and ingress.',
    run: (_values, _positionals, io) => check(io),
});

// --- info ---------------------------------------------------------------------

export const infoCommand = defineCommand({
    brief: "Print the recorded installation metadata, and where Mailpit's inbox is.",
    run: async (_values, _positionals, io) => {
        const context = loadContext(io.env);
        const metadata = readMetadata(context.siteDir);
        for (const line of describeMetadata(metadata)) {
            io.stdout(`${line}\n`);
        }
        // From `.env`, which says where it is now; the metadata records the install.
        const settings = readSettings(context.siteDir);
        if (settings && hasProfile(settings.get('COMPOSE_PROFILES') ?? '', 'mailpit')) {
            io.stdout(
                `mailpit        http://127.0.0.1:${settings.get('MAILPIT_PORT') || '8025'}\n`,
            );
        }
        return metadata.state === 'invalid' ? EXIT.failure : EXIT.ok;
    },
});

// --- list ---------------------------------------------------------------------

export const listCommand = defineCommand({
    brief: 'Every ghost-docker container on this host, stopped ones included.',
    run: async (_values, _positionals, io) => {
        const containers = await io.busy('Listing containers', () =>
            listContainers(io.docker, { all: true, labels: [MANAGED_LABEL] }),
        );
        if (containers.length === 0) {
            io.stdout('No ghost-docker containers exist on this host.\n');
        } else {
            const row = (...cells: string[]) =>
                `${cells[0]!.padEnd(28)} ${cells[1]!.padEnd(11)} ${cells[2]!.padEnd(20)} ${cells[3]!.padEnd(12)} ${cells[4]}\n`;
            io.stdout(row('SITE', 'MODE', 'SERVICE', 'LIFECYCLE', 'STATUS'));
            const label = (labels: Readonly<Record<string, string>>, name: string) =>
                labels[`org.ghost.docker.${name}`] ?? '';
            for (const container of containers.sort((a, b) =>
                `${label(a.labels, 'site')} ${label(a.labels, 'role')}`.localeCompare(
                    `${label(b.labels, 'site')} ${label(b.labels, 'role')}`,
                ),
            )) {
                io.stdout(
                    row(
                        label(container.labels, 'site'),
                        label(container.labels, 'mode'),
                        label(container.labels, 'role'),
                        label(container.labels, 'lifecycle'),
                        container.status,
                    ),
                );
            }
        }
        io.stdout(
            '\nOnly sites whose containers exist are listed, stopped ones included. There is no\n' +
                'registry of installations, so a site that has never been started cannot be found\n' +
                'from here; run ./ghost-docker check in its directory instead.\n',
        );
        return EXIT.ok;
    },
});
