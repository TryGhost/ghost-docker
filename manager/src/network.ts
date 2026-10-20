// Joining a site's network, so its services can be spoken to directly
// (clients.ts). The manager is a container on the default bridge, where
// 127.0.0.1 is itself; the daemon attaches it to the network the site's
// running containers share, discovered rather than guessed, and detaches it
// when the last phase holding it finishes, before anything can take the site
// down. An attachment the manager already had is never taken away. Services
// are addressed by their per-site alias, or by address when an override
// removed it (docs/architecture.md#verification-and-service-access).
import type { ServiceState } from './compose.ts';
import {
    connectNetwork,
    DaemonError,
    disconnectNetwork,
    inspectContainer,
    type ContainerDetail,
    type Endpoint,
} from './docker/client.ts';
import { DaemonTimeout, DaemonUnreachable, type DockerTransport } from './docker/transport.ts';
import type { Io } from './io.ts';
import { PROJECT_LABEL } from './project.ts';

/** The manager could not join the site's network, or the services are not on one. */
export class NetworkUnavailable extends Error {}

export interface ServiceAddress {
    /** What to connect to: the per-site alias, or the address on the network. */
    readonly host: string;
    /** How to name it to a person: the per-site alias, or the service's own name. */
    readonly name: string;
}

export interface SiteNetwork {
    /** The network's name, as Docker knows it. */
    readonly name: string;
    /** Null when the service has no running container on the network. */
    address: (service: string) => ServiceAddress | null;
}

/** How many phases of this process hold each network, per daemon. */
interface Hold {
    count: number;
    /** Whether the manager joined it, and so leaves it again. */
    ours: boolean;
    /** The last join or leave; the next waits for it. */
    transition: Promise<void>;
}

const holds = new WeakMap<DockerTransport, Map<string, Hold>>();

const daemonFailure = (error: unknown): boolean =>
    error instanceof DaemonError ||
    error instanceof DaemonUnreachable ||
    error instanceof DaemonTimeout;

async function join(docker: DockerTransport, hold: Hold, network: Endpoint, self: string) {
    const manager = await inspectContainer(docker, self);
    if (manager === null) {
        throw new NetworkUnavailable(
            `the daemon has no container ${self}, which the manager took to be its own`,
        );
    }
    if (manager.endpoints.some((endpoint) => endpoint.networkId === network.networkId)) {
        hold.ours = false;
        return;
    }
    try {
        await connectNetwork(docker, network.networkId, manager.id);
        hold.ours = true;
    } catch (error) {
        // Joined meanwhile by something else: it is not ours to leave.
        if (error instanceof DaemonError && /already exists/i.test(error.message)) {
            hold.ours = false;
            return;
        }
        throw error;
    }
}

async function acquire(docker: DockerTransport, network: Endpoint, self: string): Promise<Hold> {
    let held = holds.get(docker);
    if (held === undefined) {
        held = new Map();
        holds.set(docker, held);
    }
    let hold = held.get(network.networkId);
    if (hold === undefined) {
        hold = { count: 0, ours: false, transition: Promise.resolve() };
        held.set(network.networkId, hold);
    }
    hold.count += 1;
    if (hold.count === 1) {
        const current = hold;
        current.transition = current.transition
            .catch(() => undefined)
            .then(() => join(docker, current, network, self));
    }
    try {
        await hold.transition;
    } catch (error) {
        hold.count -= 1;
        throw error;
    }
    return hold;
}

async function release(docker: DockerTransport, hold: Hold, network: Endpoint, self: string) {
    hold.count -= 1;
    if (hold.count > 0) {
        return;
    }
    hold.transition = hold.transition
        .catch(() => undefined)
        .then(async () => {
            if (hold.ours) {
                hold.ours = false;
                await disconnectNetwork(docker, network.networkId, self);
            }
        });
    await hold.transition;
}

interface Target {
    readonly service: string;
    readonly container: ContainerDetail;
}

/** The per-site alias Compose gives a service: `db-<project>`. */
const aliasOf = ({ service, container }: Target): string =>
    `${service}-${container.labels[PROJECT_LABEL] ?? ''}`;

/**
 * Runs `work` with the manager on the network the running containers of
 * `wanted` share. `services` is what `docker compose ps` said; the network
 * itself is read from the daemon.
 */
export async function onSiteNetwork<T>(
    io: Io,
    services: readonly ServiceState[],
    wanted: readonly string[],
    work: (network: SiteNetwork) => Promise<T>,
): Promise<T> {
    const self = io.containerId();
    if (self === null) {
        throw new NetworkUnavailable(
            "the manager cannot tell which container it is running in, so it cannot join the site's network",
        );
    }

    const targets: Target[] = [];
    try {
        for (const service of wanted) {
            const state = services.find(
                (entry) => entry.Service === service && entry.State === 'running' && entry.ID,
            );
            const container = state ? await inspectContainer(io.docker, state.ID) : null;
            if (container !== null) {
                targets.push({ service, container });
            }
        }
    } catch (error) {
        if (daemonFailure(error)) {
            throw new NetworkUnavailable(
                `the site's containers could not be inspected: ${(error as Error).message}`,
            );
        }
        throw error;
    }
    const [first] = targets;
    if (first === undefined) {
        throw new NetworkUnavailable(`no ${wanted.join(' or ')} container is running`);
    }

    const shared = first.container.endpoints.filter((endpoint) =>
        targets.every((target) =>
            target.container.endpoints.some((other) => other.networkId === endpoint.networkId),
        ),
    );
    const network = shared.find((endpoint) => endpoint.names.includes(aliasOf(first))) ?? shared[0];
    if (network === undefined) {
        throw new NetworkUnavailable(
            `the ${targets.map((target) => target.service).join(', ')} containers share no network`,
        );
    }

    let hold: Hold;
    try {
        hold = await acquire(io.docker, network, self);
    } catch (error) {
        if (daemonFailure(error)) {
            throw new NetworkUnavailable(
                `the manager could not join the site's network ${network.network}: ${(error as Error).message}`,
            );
        }
        throw error;
    }

    const site: SiteNetwork = {
        name: network.network,
        address: (service) => {
            const target = targets.find((each) => each.service === service);
            const endpoint = target?.container.endpoints.find(
                (each) => each.networkId === network.networkId,
            );
            if (target === undefined || endpoint === undefined) {
                return null;
            }
            const alias = aliasOf(target);
            if (endpoint.names.includes(alias)) {
                return { host: alias, name: alias };
            }
            return endpoint.address ? { host: endpoint.address, name: service } : null;
        },
    };

    let result: T;
    try {
        result = await work(site);
    } catch (error) {
        // The work's own failure is the one to report; leaving is still tried.
        await release(io.docker, hold, network, self).catch(() => undefined);
        throw error;
    }
    try {
        await release(io.docker, hold, network, self);
    } catch (error) {
        throw new NetworkUnavailable(
            `the manager could not leave the site's network ${network.network}: ${(error as Error).message}`,
        );
    }
    return result;
}
