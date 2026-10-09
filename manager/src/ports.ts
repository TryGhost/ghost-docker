// Host ports a site would publish, and which Docker containers hold them.
//
// Compose refuses a port a running container holds, but only once it is
// starting the site, after the site's files are written, and it cannot see a
// stopped site's ports at all, nor choose a free one. So install and a
// restore into a new directory ask the daemon first.
import { listContainers, stoppedSiteContainers } from './docker/client.ts';
import type { Io } from './io.ts';

export interface TakenPorts {
    /** Every port a container publishes, or a stopped site's container will once it starts. */
    readonly published: ReadonlySet<number>;
    /** Each of `wanted` a container holds, as `port N is already ...`, by port. */
    readonly holders: (wanted: readonly number[]) => Map<number, string>;
}

export async function takenPorts(io: Io): Promise<TakenPorts> {
    const running = await listContainers(io.docker);
    // A stopped site's ports count as taken: it would fail to start again.
    const stopped = await stoppedSiteContainers(io.docker);
    const containers = [...running, ...stopped];
    return {
        published: new Set(containers.flatMap((container) => container.publishedPorts)),
        holders: (wanted) => {
            const holders = new Map<number, string>();
            for (const container of containers) {
                for (const port of container.publishedPorts.filter((each) =>
                    wanted.includes(each),
                )) {
                    holders.set(
                        port,
                        running.includes(container)
                            ? `port ${port} is already in use by the Docker container ${container.name}`
                            : `port ${port} is already taken by the Docker container ${container.name}, which is stopped and publishes it when it starts`,
                    );
                }
            }
            return holders;
        },
    };
}
