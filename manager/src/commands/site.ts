// `check`, `info` and `list`: what a site, or this host, looks like now.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from '../command.ts';
import { composeProjects, composePs, type ServiceState } from '../compose.ts';
import { findingChecks, validate } from '../config.ts';
import { loadContext } from '../context.ts';
import { listContainers } from '../docker/client.ts';
import { CliError, EXIT } from '../errors.ts';
import { withSiteDatabase } from '../import/database.ts';
import type { Io } from '../io.ts';
import { describeLock, readLock } from '../lock.ts';
import { describeMetadata, readMetadata } from '../meta.ts';
import { failed, printChecks, type Check } from '../report.ts';
import { hasProfile, readSettings, RESTORE_DIR } from '../site.ts';
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
    // Left by an operation that is still running, or one that was interrupted.
    const lock = readLock(site.dir);
    if (lock.state !== 'free') {
        const held: Check = {
            status: 'error',
            label: 'lock',
            detail: describeLock(site.dir, lock),
        };
        printChecks(io, [held]);
        all.push(held);
    }
    // A restore over the site that did not finish keeps the site as it was here.
    if (existsSync(join(site.dir, RESTORE_DIR))) {
        const aside: Check = {
            status: 'warn',
            label: RESTORE_DIR,
            detail:
                `${join(site.dir, RESTORE_DIR)} holds the site as it was before a restore that did not finish.\n` +
                'Once the site is as it should be, remove it (with sudo: MySQL owns part of it).',
        };
        printChecks(io, [aside]);
        all.push(aside);
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
            : findingChecks(findings),
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
        await io.busy('Connecting to the database', () => database(io, site.dir, services)),
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
 * user, from the manager over the site's network.
 */
async function database(
    io: Io,
    dir: string,
    services: readonly ServiceState[] | null,
): Promise<Check> {
    try {
        await withSiteDatabase(
            io,
            dir,
            { services, failure: 'could not be reached with the configured credentials' },
            (sql) => sql.query('SELECT 1'),
        );
    } catch (error) {
        if (error instanceof CliError) {
            return { status: 'error', label: 'database', detail: error.message };
        }
        throw error;
    }
    return {
        status: 'ok',
        label: 'database',
        detail: 'accepts a client connection to the application database',
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
    brief: 'Every ghost-docker site on this host whose containers exist, and its directory.',
    run: async (_values, _positionals, io) => {
        // Compose knows each project and where its files are; Docker's labels
        // say which projects are ghost-docker sites, and in which mode.
        const [containers, projects] = await io.busy('Listing sites', () =>
            Promise.all([
                listContainers(io.docker, { all: true, labels: [MANAGED_LABEL] }),
                composeProjects(io),
            ]),
        );
        if (projects === null) {
            io.stderr('error: docker compose ls failed\n');
            return EXIT.failure;
        }
        const modes = new Map(
            containers.map((container) => [
                container.labels['com.docker.compose.project'] ?? '',
                container.labels['org.ghost.docker.mode'] ?? '',
            ]),
        );
        const sites = projects
            .filter((project) => modes.has(project.name))
            .sort((a, b) => a.name.localeCompare(b.name));
        if (sites.length === 0) {
            io.stdout('No ghost-docker site has containers on this host.\n');
        } else {
            const row = (...cells: string[]) =>
                `${cells[0]!.padEnd(28)} ${cells[1]!.padEnd(11)} ${cells[2]!.padEnd(20)} ${cells[3]}\n`;
            io.stdout(row('SITE', 'MODE', 'STATUS', 'DIRECTORY'));
            for (const site of sites) {
                io.stdout(row(site.name, modes.get(site.name)!, site.status, site.dir));
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
