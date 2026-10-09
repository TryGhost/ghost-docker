// What an installation created, so that a failure removes exactly that and
// leaves the site directory as it was.
//
// An import also keeps this record in its marker file as it goes (a journal),
// so that an import killed before it could clean up is removed by the next one.
import { existsSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { removeStaging } from './bundle/stage.ts';
import { ALL_PROFILES, composeDown, composeError } from './compose.ts';
import type { Context } from './context.ts';
import { removeAsRoot } from './asroot.ts';
import { atomicWrite, PRIVATE, readIfExists } from './fs.ts';
import type { Io } from './io.ts';
import type { Written } from './payload.ts';
import { DATA_DIRS, ENV_FILE, GHOST_ENV_FILE, META_FILE } from './site.ts';

const journalSchema = z.object({
    files: z.array(z.string().startsWith('/')),
    directories: z.array(z.string().startsWith('/')),
    data: z.array(z.string().startsWith('/')),
    project: z.boolean(),
});

export class Created implements Written {
    readonly checksums: Record<string, string> = {};
    readonly files: string[] = [];
    readonly directories: string[] = [];
    /** Data directories, which containers may have filled with files they own. */
    readonly data: string[] = [];
    /** Compose has created something for this project: a network, containers, volumes. */
    project = false;
    /** The import marker, when this is an import. */
    journal: string | null = null;

    private readonly io: Io;
    private readonly context: Context;
    private readonly dir: string;

    constructor(io: Io, context: Context, dir: string) {
        this.io = io;
        this.context = context;
        this.dir = dir;
    }

    /**
     * What an unfinished import's marker recorded. A marker that cannot be
     * read stands for everything an import writes besides the payload.
     */
    static fromJournal(io: Io, context: Context, dir: string, journal: string): Created {
        const created = new Created(io, context, dir);
        created.journal = journal;
        let recorded: z.infer<typeof journalSchema>;
        try {
            recorded = journalSchema.parse(JSON.parse(readIfExists(journal) ?? ''));
        } catch {
            recorded = {
                files: [ENV_FILE, GHOST_ENV_FILE, META_FILE].map((file) => join(dir, file)),
                directories: [],
                data: DATA_DIRS.map((data) => join(dir, data)),
                project: true,
            };
        }
        // Only ever inside this site directory, whatever the file says.
        const inside = (path: string) => path.startsWith(`${dir}/`);
        created.files.push(...recorded.files.filter(inside));
        created.directories.push(...recorded.directories.filter(inside));
        created.data.push(...recorded.data.filter(inside));
        created.project = recorded.project && existsSync(join(dir, ENV_FILE));
        return created;
    }

    file(path: string) {
        this.files.push(path);
        this.save();
    }

    /** Records what has been created so far in the import marker, if there is one. */
    save() {
        if (this.journal === null) {
            return;
        }
        const { files, directories, data, project } = this;
        atomicWrite(
            this.journal,
            `${JSON.stringify({ files, directories, data, project }, null, 2)}\n`,
            PRIVATE,
        );
    }

    async remove(): Promise<string[]> {
        const leftovers: string[] = [];
        if (this.project) {
            // Every profile, so whatever was started is found; the .env it
            // interpolates is still in place.
            const down = await composeDown(this.io, this.dir, {
                volumes: true,
                profiles: ALL_PROFILES,
            });
            if (down.exitCode !== 0) {
                leftovers.push(
                    `the project's containers (docker compose down failed: ${composeError(down, 2)})`,
                );
            }
        }
        if (this.data.length > 0) {
            leftovers.push(...(await this.removeData()));
        }
        for (const file of [...this.files].reverse()) {
            rmSync(file, { force: true });
        }
        for (const directory of [...this.directories].reverse()) {
            try {
                rmdirSync(directory);
            } catch {
                if (existsSync(directory)) {
                    leftovers.push(directory);
                }
            }
        }
        if (this.journal !== null) {
            removeStaging(this.dir);
            // Kept while anything is left, so the next import tries again.
            if (leftovers.length === 0) {
                rmSync(this.journal, { force: true });
            }
        }
        return leftovers;
    }

    /** MySQL's data directory belongs to MySQL's user once it has run (asroot.ts). */
    private async removeData(): Promise<string[]> {
        const left = await removeAsRoot(
            this.io,
            this.context.image,
            this.dir,
            this.data.map((path) => path.slice(this.dir.length + 1)),
            120_000,
        );
        return left.map((path) => join(this.dir, path));
    }
}
