// A site as Compose resolves it and as the daemon runs it, worked out once.
//
// `.env` says what the operator asked for; an override can change any of it:
// the project's name, a service's image, where its data is mounted. What a
// command relies on is what Compose resolves from every file the site runs
// with (`docker compose config`), and what is actually running is what the
// daemon says of the project's containers. Commands that change a site, or
// record it, ask here rather than read `.env` and guess.
import { isAbsolute, join, relative } from 'node:path';
import { composeConfig, composeFileList } from './compose.ts';
import { inspectImage, listContainers } from './docker/client.ts';
import { CliError } from './errors.ts';
import type { Io } from './io.ts';
import { PROJECT_LABEL, refuseForeignProject, WORKING_DIR_LABEL } from './project.ts';
import { COMPOSE_FILE, COMPOSE_OVERRIDE_FILE } from './site.ts';

/** The label Compose gives every container with the service it is of. */
const SERVICE_LABEL = 'com.docker.compose.service';

export interface Mount {
    /** `bind`, `volume` or `tmpfs`. */
    readonly type: string;
    /** A bind's absolute host path, or a volume's name. */
    readonly source: string;
    readonly target: string;
}

export interface ResolvedService {
    /** The image Compose resolves, or null for one it would build. */
    readonly image: string | null;
    /** Its restart policy; null when it has none. */
    readonly restart: string | null;
    readonly mounts: readonly Mount[];
    /** The networks it joins, by the names Docker knows them by. */
    readonly networks: readonly string[];
}

export interface ResolvedSite {
    readonly dir: string;
    /** The project's name as Compose resolves it, which an override's `name:` changes. */
    readonly project: string;
    /** Every Compose file, in the order Compose merges them. */
    readonly files: readonly string[];
    /** The overrides GD_COMPOSE_OVERRIDES adds, beyond compose.yml and compose.override.yml. */
    readonly overrides: readonly string[];
    /** The services the site's profiles select. */
    readonly services: Readonly<Record<string, ResolvedService>>;
}

/**
 * The site as Compose resolves it, refused when the project's containers
 * belong to another directory: whatever was done next would be done to them.
 */
export async function resolveSite(io: Io, dir: string): Promise<ResolvedSite> {
    const resolved = await composeConfig(io, dir);
    if (!resolved.ok) {
        throw new CliError(`Compose cannot resolve the project: ${resolved.reason}`);
    }
    const { project } = resolved;
    const name = (key: string) => project.networks[key]?.name || `${project.name}_${key}`;
    const services: Record<string, ResolvedService> = {};
    for (const [service, definition] of Object.entries(project.services)) {
        services[service] = {
            image: definition.image ?? null,
            restart: definition.restart ?? null,
            mounts: definition.volumes.map(({ type, source, target }) => ({
                type,
                source,
                target,
            })),
            networks: Object.keys(definition.networks).map(name),
        };
    }
    const files = composeFileList(dir, io.env.GD_COMPOSE_OVERRIDES);
    const site: ResolvedSite = {
        dir,
        project: project.name,
        files,
        overrides: files.filter(
            (file) => file !== join(dir, COMPOSE_FILE) && file !== join(dir, COMPOSE_OVERRIDE_FILE),
        ),
        services,
    };
    if (site.project !== '') {
        await refuseForeignProject(io, site.project, dir);
    }
    return site;
}

/** A path inside the site, relative to it, or null when it is elsewhere. */
export function insideSite(dir: string, path: string): string | null {
    const inside = relative(dir, path);
    return inside === '' || inside.startsWith('..') || isAbsolute(inside) ? null : inside;
}

// --- What runs --------------------------------------------------------------------

export interface RunningService {
    readonly service: string;
    readonly container: string;
    /** `running`, `exited` and so on. */
    readonly state: string;
    /** The image reference the container was created from. */
    readonly image: string;
    /** The image it runs, by ID. */
    readonly imageId: string;
}

/** The containers of the site's project that were made in its directory. */
export async function observeSite(io: Io, site: ResolvedSite): Promise<RunningService[]> {
    const containers = await listContainers(io.docker, {
        all: true,
        labels: [`${PROJECT_LABEL}=${site.project}`],
    });
    return containers
        .filter((container) => {
            const owner = container.labels[WORKING_DIR_LABEL];
            return owner === undefined || owner.replace(/\/+$/, '') === site.dir;
        })
        .map((container) => ({
            service: container.labels[SERVICE_LABEL] ?? '',
            container: container.name,
            state: container.state,
            image: container.image,
            imageId: container.imageId,
        }))
        .sort((a, b) => a.service.localeCompare(b.service));
}

export interface ImageIdentity {
    /** The reference the container was created from. */
    readonly image: string;
    /** The image's ID: what exactly ran, whatever its reference names later. */
    readonly id: string;
    /** Registry digests the daemon knows the image by, which another host can pull. */
    readonly digests: string[];
}

/** The exact image each running service runs. */
export async function runningImages(
    io: Io,
    running: readonly RunningService[],
): Promise<Record<string, ImageIdentity>> {
    const images: Record<string, ImageIdentity> = {};
    for (const each of running) {
        if (each.state !== 'running' || each.service === '' || each.imageId === '') {
            continue;
        }
        const inspected = await inspectImage(io.docker, each.imageId);
        images[each.service] = {
            image: each.image,
            id: each.imageId,
            digests: [...(inspected?.repoDigests ?? [])].sort(),
        };
    }
    return images;
}

/**
 * The services whose running container is not what Compose now resolves:
 * the configuration names another image, or its tag now names a newer one.
 * Either way `docker compose up -d` has not been run since.
 */
export async function imageDrift(
    io: Io,
    site: ResolvedSite,
    running: readonly RunningService[],
): Promise<string[]> {
    const drift: string[] = [];
    for (const each of running) {
        const configured = site.services[each.service]?.image;
        if (each.state !== 'running' || configured == null) {
            continue;
        }
        if (each.image !== configured) {
            drift.push(
                `${each.service} runs ${each.image}, and the configuration names ${configured}`,
            );
            continue;
        }
        const now = await inspectImage(io.docker, configured);
        if (now !== null && each.imageId !== '' && now.id !== each.imageId) {
            drift.push(
                `${each.service} runs ${each.imageId.slice(0, 19)}, and ${configured} now names ${now.id.slice(0, 19)}`,
            );
        }
    }
    return drift;
}
