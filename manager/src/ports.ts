// Host ports a site would publish, and which Docker containers hold them.
//
// Compose refuses a port a running container holds, but only once it is
// starting the site, after the site's files are written, and it cannot see a
// stopped site's ports at all, nor choose a free one. So install and a
// restore into a new directory ask the daemon first.
//
// A running container's port is a conflict now, and is refused. A stopped
// site's port is only a conflict if both sites run at once, which someone who
// runs one site at a time never does: a chosen port skips it, but a port asked
// for is only warned about, and `docker compose up` names it if it ever does
// collide.
import { listContainers, stoppedSiteContainers } from './docker/client.ts';
import type { Io } from './io.ts';

export interface TakenPorts {
    /** Every port a container publishes, or a stopped site's container will once it starts. */
    readonly published: ReadonlySet<number>;
    /** Each of `wanted` a running container holds, as `port N is already ...`, by port. */
    readonly holders: (wanted: readonly number[]) => Map<number, string>;
    /** Each of `wanted` only a stopped site's container publishes, as `port N is also ...`, by port. */
    readonly stopped: (wanted: readonly number[]) => Map<number, string>;
}

export async function takenPorts(io: Io): Promise<TakenPorts> {
    const running = await listContainers(io.docker);
    const stopped = await stoppedSiteContainers(io.docker);
    const describe = (
        containers: typeof running,
        wanted: readonly number[],
        line: (port: number, name: string) => string,
    ) => {
        const found = new Map<number, string>();
        for (const container of containers) {
            for (const port of container.publishedPorts.filter((each) => wanted.includes(each))) {
                found.set(port, line(port, container.name));
            }
        }
        return found;
    };
    return {
        published: new Set(
            [...running, ...stopped].flatMap((container) => container.publishedPorts),
        ),
        holders: (wanted) =>
            describe(
                running,
                wanted,
                (port, name) => `port ${port} is already in use by the Docker container ${name}`,
            ),
        stopped: (wanted) => {
            const held = new Set(describe(running, wanted, () => '').keys());
            return describe(
                stopped,
                wanted.filter((port) => !held.has(port)),
                (port, name) =>
                    `port ${port} is also published by the stopped container ${name}; only one can run at a time`,
            );
        },
    };
}
