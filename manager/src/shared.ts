// The shared Caddy: one Caddy for several production sites on a server, as
// Ghost-CLI ran several sites behind one nginx. Only one process can hold 80
// and 443, so Caddy is shared; everything else, MySQL included, stays per
// site. It is a Compose project of its own (`install --infra`), on a network
// the manager creates and no project owns, which each member's Ghost and
// optional services join under their unique aliases. The network's labels say
// where the shared Caddy's directory is.
//
// Each member's routes are a file in that directory's caddy/sites/, named for
// the member's project. The manager cannot see that directory, only its own
// site's, so it reads and writes it through the running Caddy container, which
// mounts it: what is written is exactly what Caddy reads. See docs/caddy.md.
import { CliError } from './errors.ts';
import {
    execInContainer,
    inspectNetwork,
    listContainers,
    type ContainerFacts,
} from './docker/client.ts';
import type { RunResult } from './docker/client.ts';
import type { Io } from './io.ts';
import { PROJECT_LABEL, WORKING_DIR_LABEL } from './project.ts';

/** The shared Caddy's network. One per daemon, as 80 and 443 are. */
export const INGRESS_NETWORK = 'ghost-ingress';
/** The network's labels: the shared Caddy's directory and project. */
export const INFRA_DIR_LABEL = 'org.ghost.docker.infra.dir';
export const INFRA_PROJECT_LABEL = 'org.ghost.docker.infra.project';
/** The label Compose gives each container its service's name. */
export const SERVICE_LABEL = 'com.docker.compose.service';
/** The default project name of the shared Caddy. */
export const INFRA_PROJECT = 'ghost-infra';

/** Where the shared Caddy container mounts the members' routes. */
const SITES = '/etc/caddy/sites';
const CADDYFILE = '/etc/caddy/Caddyfile';

export interface SharedCaddy {
    readonly network: string;
    /** The shared Caddy's directory on the host. */
    readonly dir: string;
    readonly project: string;
    /** Its Caddy container, running or not; null when it has none. */
    readonly container: ContainerFacts | null;
}

/** The shared Caddy on this daemon, or null when there is none. */
export async function findSharedCaddy(io: Io): Promise<SharedCaddy | null> {
    const network = await inspectNetwork(io.docker, INGRESS_NETWORK);
    if (network === null) {
        return null;
    }
    const project = network.labels[INFRA_PROJECT_LABEL] ?? '';
    const [container] =
        project === ''
            ? []
            : await listContainers(io.docker, {
                  all: true,
                  labels: [`${PROJECT_LABEL}=${project}`, `${SERVICE_LABEL}=caddy`],
              });
    return {
        network: network.name,
        dir: container?.labels[WORKING_DIR_LABEL] ?? network.labels[INFRA_DIR_LABEL] ?? '',
        project,
        container: container ?? null,
    };
}

/** How to name the shared Caddy to a person. */
export const describeShared = (shared: SharedCaddy): string =>
    `the shared Caddy${shared.dir ? ` in ${shared.dir}` : ''}`;

/**
 * The shared Caddy's container, which must be running for its routes to be
 * read or changed; otherwise a CliError saying how to start it.
 */
export function runningCaddy(shared: SharedCaddy): ContainerFacts {
    const { container } = shared;
    if (container === null || container.state !== 'running') {
        throw new CliError(
            `${describeShared(shared)} is not running, so its routes cannot be read or changed.\n` +
                `  Start it in its directory: cd ${shared.dir || '<its directory>'} && docker compose up -d\n` +
                '  Nothing has been changed.',
        );
    }
    return container;
}

/** The member's routes file, in the shared Caddy's caddy/sites/. */
export const routesFile = (project: string): string => `${project}.caddy`;

/** The routes file, as a person finds it on the host. */
export const routesPath = (shared: SharedCaddy, project: string): string =>
    `${shared.dir || '<the shared Caddy>'}/caddy/sites/${routesFile(project)}`;

const inCaddy = (
    io: Io,
    caddy: ContainerFacts,
    cmd: readonly string[],
    user?: string,
): Promise<RunResult> => execInContainer(io.docker, caddy.id, { cmd, user });

/** What a command in the Caddy container said when it failed, for an error. */
const said = (result: RunResult): string =>
    (result.stderr.trim() || result.stdout.trim() || 'no output')
        .split('\n')
        .slice(-8)
        .map((line) => `    ${line}`)
        .join('\n');

/** Every host name the shared Caddy's loaded configuration matches, lowercase. */
export async function servedHosts(io: Io, caddy: ContainerFacts): Promise<Set<string>> {
    // Its admin API listens inside the container only, as the health check uses it.
    const result = await inCaddy(io, caddy, [
        'wget',
        '-q',
        '-O',
        '-',
        'http://127.0.0.1:2019/config/',
    ]);
    if (result.status !== 0) {
        throw new CliError(
            `the shared Caddy's configuration could not be read from its admin API:\n${said(result)}`,
        );
    }
    const hosts = new Set<string>();
    const walk = (value: unknown): void => {
        if (Array.isArray(value)) {
            value.forEach(walk);
        } else if (value !== null && typeof value === 'object') {
            for (const [key, inner] of Object.entries(value)) {
                if (key === 'host' && Array.isArray(inner)) {
                    for (const host of inner) {
                        if (typeof host === 'string') {
                            hosts.add(host.toLowerCase());
                        }
                    }
                } else {
                    walk(inner);
                }
            }
        }
    };
    walk(result.stdout.trim() === '' ? null : JSON.parse(result.stdout));
    return hosts;
}

/** The files in the shared Caddy's caddy/sites/. */
export async function routeFiles(io: Io, caddy: ContainerFacts): Promise<string[]> {
    const result = await inCaddy(io, caddy, ['ls', '-1A', SITES]);
    if (result.status !== 0) {
        throw new CliError(`the shared Caddy's ${SITES} could not be listed:\n${said(result)}`);
    }
    return result.stdout.split('\n').filter((line) => line !== '');
}

/**
 * Refuses a member whose project already has routes in the shared Caddy, or
 * whose domains it already serves, for whichever site: before anything is
 * written. Caddy would also refuse a second block for one address, but only
 * once the file was there.
 */
export async function refuseTaken(
    io: Io,
    shared: SharedCaddy,
    project: string,
    domains: readonly string[],
): Promise<void> {
    const caddy = runningCaddy(shared);
    if ((await routeFiles(io, caddy)).includes(routesFile(project))) {
        throw new CliError(
            `${routesPath(shared, project)} already exists: the project ${project} already has routes in\n` +
                '  the shared Caddy. Choose another name with --name, or remove that site first\n' +
                '  (./ghost-docker remove, in its directory). Nothing has been changed.',
        );
    }
    const served = await servedHosts(io, caddy);
    const taken = domains
        .map((domain) => domain.toLowerCase())
        .filter((domain) => served.has(domain));
    if (taken.length > 0) {
        throw new CliError(
            `the shared Caddy already serves ${taken.join(' and ')}, for another site or in its own\n` +
                `  configuration (${shared.dir || 'its directory'}/caddy). Two sites cannot share a domain.\n` +
                '  Nothing has been changed.',
        );
    }
}

/**
 * Writes the member's routes into the shared Caddy, owned by whoever owns its
 * caddy/sites/, has Caddy validate its whole configuration with them, and
 * reloads it. Routes Caddy refuses are removed again, and Caddy keeps serving
 * what it served.
 */
export async function addRoutes(
    io: Io,
    shared: SharedCaddy,
    project: string,
    routes: string,
): Promise<void> {
    const caddy = runningCaddy(shared);
    const owner = await inCaddy(io, caddy, ['stat', '-c', '%u:%g', SITES]);
    if (owner.status !== 0) {
        throw new CliError(`the shared Caddy's ${SITES} could not be read:\n${said(owner)}`);
    }
    const file = `${SITES}/${routesFile(project)}`;
    // Written beside it under a name the Caddyfile's *.caddy does not import,
    // then renamed, so Caddy never reads half a file.
    const written = await inCaddy(
        io,
        caddy,
        [
            'sh',
            '-c',
            'umask 022 && [ ! -e "$2" ] && printf "%s" "$1" > "$2.new" && mv "$2.new" "$2"',
            'sh',
            routes,
            file,
        ],
        owner.stdout.trim(),
    );
    if (written.status !== 0) {
        throw new CliError(
            `the routes could not be written to the shared Caddy:\n${said(written)}`,
        );
    }
    const valid = await inCaddy(io, caddy, ['caddy', 'validate', '--config', CADDYFILE]);
    if (valid.status !== 0) {
        const removed = await inCaddy(io, caddy, ['rm', '-f', file], owner.stdout.trim());
        if (removed.status !== 0) {
            throw new CliError(
                `the shared Caddy does not accept its configuration with these routes, and they could not\n` +
                    `  be removed again: remove ${routesPath(shared, project)} by hand. Until then Caddy keeps\n` +
                    `  serving, but will not start again. Caddy said:\n${said(valid)}`,
            );
        }
        throw new CliError(
            `the shared Caddy does not accept its configuration with these routes, so they were removed\n` +
                `  again; Caddy still serves what it served. Caddy said:\n${said(valid)}`,
        );
    }
    await reloadCaddy(io, shared);
}

/**
 * Removes the member's routes from the shared Caddy and reloads it. Routes
 * that are already gone are not an error.
 */
export async function removeRoutes(io: Io, shared: SharedCaddy, project: string): Promise<void> {
    const caddy = runningCaddy(shared);
    const removed = await inCaddy(io, caddy, ['rm', '-f', `${SITES}/${routesFile(project)}`]);
    if (removed.status !== 0) {
        throw new CliError(
            `${routesPath(shared, project)} could not be removed:\n${said(removed)}`,
        );
    }
    await reloadCaddy(io, shared);
}

/**
 * `caddy reload`: the configuration loads whole, or Caddy says why and keeps
 * serving the one it had.
 */
export async function reloadCaddy(io: Io, shared: SharedCaddy): Promise<void> {
    const caddy = runningCaddy(shared);
    const reloaded = await inCaddy(io, caddy, ['caddy', 'reload', '--config', CADDYFILE]);
    if (reloaded.status !== 0) {
        throw new CliError(
            `the shared Caddy did not load its configuration, and keeps serving the one it had.\n` +
                `  Caddy said:\n${said(reloaded)}`,
        );
    }
}
