// What every command about an installed site starts with.
import { loadContext, type Context } from '../context.ts';
import { CliError } from '../errors.ts';
import type { Io } from '../io.ts';
import { ENV_FILE, readSettings, siteFacts, type SiteFacts } from '../site.ts';

export interface InstalledSite {
    readonly context: Context;
    readonly site: SiteFacts;
}

/**
 * The launcher's context, and the site in its directory. The manager must be
 * working in the directory the launcher mounted, or every bind mount would
 * resolve to somewhere else.
 */
export function installedSite(io: Io): InstalledSite {
    const context = loadContext(io.env);
    const dir = context.siteDir;
    if (io.cwd() !== dir) {
        throw new CliError(
            `working in ${io.cwd()}, but the launcher gave the site directory as ${dir}`,
        );
    }
    const settings = readSettings(dir);
    if (settings === null) {
        throw new CliError(
            `${dir}/${ENV_FILE} does not exist, so this directory does not hold a site.\n` +
                '  Run ./ghost-docker install, or ./ghost-docker --dir PATH ... for a site elsewhere.',
        );
    }
    const site = siteFacts(dir, settings);
    const declared = settings.get('PROJECT_DIR');
    if (declared && declared !== dir) {
        throw new CliError(
            `.env says PROJECT_DIR is ${declared}, but the site is at ${dir}.\n` +
                '  If the site was moved, update PROJECT_DIR (./ghost-docker config set .env PROJECT_DIR ' +
                `${dir}) and check its bind mounts.`,
        );
    }
    return { context, site };
}
