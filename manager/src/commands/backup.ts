// `backup` and `restore` (plan §2.5): the site's databases, content and
// configuration, and putting them back, into the same directory or a new one.
// What they do is backup.ts and restore.ts; this is the command line and the
// lock.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { takeBackup } from '../backup.ts';
import { defineCommand, flag } from '../command.ts';
import { CliError, EXIT, UsageError } from '../errors.ts';
import { acquireLock } from '../lock.ts';
import { requireMetadata } from '../meta.ts';
import { restoreSite } from '../restore.ts';
import { installedSite, siteContext } from './common.ts';

export const backupCommand = defineCommand({
    brief: 'Back up the site: its databases, content and configuration, into backups/. See docs/install.md.',
    options: z.object({
        consistent: flag(
            'Stop Ghost and ActivityPub while the databases and content are captured, so they are one moment of the site; the site is down for that time.',
        ),
    }),
    async run(flags, _positionals, io) {
        const { site } = installedSite(io);
        const metadata = requireMetadata(site.dir, 'backup cannot tell how it was installed');
        const lock = acquireLock(site.dir, 'backup');
        let path: string;
        try {
            path = await takeBackup({ io, site, metadata, consistent: flags.consistent });
        } finally {
            lock.release();
        }
        io.stdout(
            `\nBacked up to ${path}\n` +
                'It is kept until you remove it. Copy it off this host to keep it safe.\n' +
                `Restore it with: ./ghost-docker restore ${path}\n`,
        );
        return EXIT.ok;
    },
});

export const restoreCommand = defineCommand({
    brief: 'Restore a backup, over its own site or into a new, empty directory. See docs/install.md.',
    options: z.object({
        yes: flag('Restore over the site in this directory without asking first.'),
    }),
    positionals: ['backup'],
    async run(flags, [given], io) {
        if (given === undefined) {
            throw new UsageError(
                'restore needs the backup to restore: ./ghost-docker restore backups/<backup>',
            );
        }
        const context = siteContext(io);
        const root = resolve(context.siteDir, given);
        if (!existsSync(root) || !statSync(root).isDirectory()) {
            throw new CliError(
                `${root} is not a directory. A backup is a directory under a site's backups/. Nothing has been changed.`,
            );
        }
        await restoreSite({ io, context, root, yes: flags.yes });
        return EXIT.ok;
    },
});
