// A site's Compose project: its name, chosen once at installation, and who
// owns it on this daemon.
//
// Compose finds a project's containers by name alone. Two directories whose
// `.env` named the same project would each take the other's containers for
// their own, and `up` in one would recreate the other's. So a name is chosen
// that no project on the daemon has, kept in `.env`, and every command that
// changes a site first asks the daemon whether the project's containers
// belong to another directory.
import { basename } from 'node:path';
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator';
import { listContainers } from './docker/client.ts';
import { CliError } from './errors.ts';
import type { Io } from './io.ts';
import type { SiteMode } from './site.ts';

/** The label Compose gives every container of a project. */
export const PROJECT_LABEL = 'com.docker.compose.project';
/** The label naming the project directory a container was made from. */
export const WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';

/** A lowercase, dash-separated token that Compose accepts in a project name. */
export const slug = (value: string): string =>
    value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

/** How much of a directory's name a local project keeps, so container names stay readable. */
const DIRECTORY_CHARACTERS = 24;

/**
 * `secondary-roadrunner`: an adjective and an animal, as Docker names a
 * container it was given no name for. About 427,000 pairs, so a clash is
 * rare, and a clash is retried.
 */
export const randomName = (): string =>
    uniqueNamesGenerator({
        dictionaries: [adjectives, animals],
        separator: '-',
        style: 'lowerCase',
    });

/** How many names are tried before giving up on finding a free one. */
const ATTEMPTS = 100;

/**
 * The site's stable identity, and the suffix of every service's network
 * alias. Chosen once and kept in `.env`, so it does not change when the
 * directory is renamed. A production site is named for its domain, which two
 * sites on one host cannot share anyway. A local one is named for its
 * directory and a random pair, `ghost-local-blog-secondary-roadrunner`, so two
 * directories with the same name are two projects; one `taken` holds is
 * never chosen.
 */
export function projectName(
    mode: SiteMode,
    domain: string,
    dir: string,
    taken: ReadonlySet<string> = new Set(),
    generate: () => string = randomName,
): string {
    if (mode === 'production') {
        return `ghost-${slug(domain)}`;
    }
    const directory =
        slug(basename(dir)).slice(0, DIRECTORY_CHARACTERS).replace(/-+$/, '') || 'site';
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const name = `ghost-local-${directory}-${generate()}`;
        if (!taken.has(name)) {
            return name;
        }
    }
    throw new CliError(
        `no free project name for ${dir} after ${ATTEMPTS} tries. Nothing has been changed.`,
    );
}

/** Every Compose project that has containers on the daemon, stopped ones included. */
export async function knownProjects(io: Io): Promise<Set<string>> {
    const containers = await listContainers(io.docker, { all: true, labels: [PROJECT_LABEL] });
    return new Set(containers.map((container) => container.labels[PROJECT_LABEL] ?? ''));
}

export interface ProjectOwners {
    /** The project's containers, by name. */
    readonly containers: readonly string[];
    /** The directories they were made from, other than `dir`. */
    readonly foreign: readonly string[];
}

/** The containers of `project`, and which other directories they belong to. */
export async function projectOwners(io: Io, project: string, dir: string): Promise<ProjectOwners> {
    const containers = await listContainers(io.docker, {
        all: true,
        labels: [`${PROJECT_LABEL}=${project}`],
    });
    const foreign = new Set<string>();
    for (const container of containers) {
        const owner = container.labels[WORKING_DIR_LABEL];
        if (owner !== undefined && owner.replace(/\/+$/, '') !== dir) {
            foreign.add(owner);
        }
    }
    return { containers: containers.map((container) => container.name), foreign: [...foreign] };
}

/** Why `project` cannot be used from `dir`, or null when nothing else owns it. */
export async function foreignProject(io: Io, project: string, dir: string): Promise<string | null> {
    const { containers, foreign } = await projectOwners(io, project, dir);
    if (foreign.length === 0) {
        return null;
    }
    return (
        `the Compose project ${project} belongs to ${foreign.join(' and ')}: its containers ` +
        `(${containers.slice(0, 3).join(', ')}${containers.length > 3 ? ', …' : ''}) were made there, not in ${dir}`
    );
}

/**
 * Refuses to work on a site whose project's containers were made in another
 * directory: Compose would act on that site's containers as this one's.
 */
export async function refuseForeignProject(io: Io, project: string, dir: string): Promise<void> {
    const reason = await foreignProject(io, project, dir);
    if (reason !== null) {
        throw new CliError(
            `${reason}.\n` +
                '  Compose takes containers with the same project name for one site, so this command would\n' +
                "  change the other directory's. If this site was moved here, remove the old containers with\n" +
                '  `docker compose down` in this directory; otherwise take the other site down first.\n' +
                '  Nothing has been changed.',
        );
    }
}
