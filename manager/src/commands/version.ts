import { defineCommand } from '../command.ts';
import { EXIT } from '../errors.ts';
import { managerVersion } from '../versions.ts';

/** `ghost-docker 1.2.3 (abc1234)`, or `ghost-docker dev` from a source tree. */
export const versionCommand = defineCommand({
    brief: "Print the manager's version.",
    run: async (_values, _positionals, io) => {
        const { version, commit } = managerVersion();
        io.stdout(`ghost-docker ${version}${commit ? ` (${commit.slice(0, 7)})` : ''}\n`);
        return EXIT.ok;
    },
});
