// `remove`: a site taken down, and behind the shared Caddy, its routes taken
// out of it, so every other site behind it is left as it was. The site's
// directory, data and backups stay, for the operator to keep or delete.
import { z } from 'zod';
import { defineCommand, flag } from '../command.ts';
import { ALL_PROFILES, composeDown, composeError } from '../compose.ts';
import { CliError, EXIT, UsageError } from '../errors.ts';
import type { Io } from '../io.ts';
import { acquireLock } from '../lock.ts';
import { refuseForeignProject } from '../project.ts';
import { ok } from '../report.ts';
import {
    describeShared,
    findSharedCaddy,
    removeRoutes,
    routesPath,
    runningCaddy,
} from '../shared.ts';
import { installedSite } from './common.ts';

export const removeCommand = defineCommand({
    brief: 'Take the site down, and behind the shared Caddy, remove its routes from it. Its directory and data stay. See docs/install.md.',
    options: z.object({
        yes: flag('Remove the site without asking first.'),
    }),
    async run(flags, _positionals, io) {
        const { site } = installedSite(io);
        const dir = site.dir;
        const project = site.settings.get('COMPOSE_PROJECT_NAME') || '';
        await refuseForeignProject(io, project, dir);
        const shared = site.member ? await findSharedCaddy(io) : null;
        if (shared !== null) {
            runningCaddy(shared);
        }
        await confirm(io, dir, project, flags.yes);

        const lock = acquireLock(dir, 'remove');
        try {
            if (shared !== null) {
                await io.busy('Removing the routes from the shared Caddy', () =>
                    removeRoutes(io, shared, project),
                );
                ok(
                    io,
                    'routes',
                    `${routesPath(shared, project)} removed; ${describeShared(shared)} reloaded without them`,
                );
            }
            const down = await io.busy("Stopping and removing the site's containers", () =>
                composeDown(io, dir, { profiles: ALL_PROFILES }),
            );
            if (down.exitCode !== 0) {
                throw new CliError(
                    `docker compose down failed: ${composeError(down, 4)}\n` +
                        '  Run it again in this directory once the cause is fixed.',
                );
            }
            ok(io, 'services', `the containers and networks of ${project} are removed`);
        } finally {
            lock.release();
        }
        io.stdout(
            `\nThe site is removed. ${dir} still holds its configuration, data and backups:\n` +
                'docker compose up -d starts it again' +
                (shared === null
                    ? ''
                    : `, once its routes are back in ${routesPath(shared, project)}`) +
                '.\nTo delete it for good, remove the directory (with sudo: MySQL owns data/mysql).\n',
        );
        return EXIT.ok;
    },
});

/** Taking a site down is never a surprise: it is asked, or --yes says so. */
async function confirm(io: Io, dir: string, project: string, yes: boolean) {
    if (yes) {
        return;
    }
    if (io.prompt === null) {
        throw new UsageError(
            `remove takes down the site in ${dir} (${project}).\n` +
                '  Run it again with --yes to go ahead. Nothing has been changed.',
        );
    }
    const answer = await io.prompt.choose(
        `Take down ${project} and remove its containers? Its directory and data stay.`,
        [
            { name: 'No, change nothing', value: 'no' },
            { name: 'Yes, remove the site', value: 'yes' },
        ],
    );
    if (answer !== 'yes') {
        throw new CliError('the removal was cancelled. Nothing has been changed.');
    }
}
