import { defineCommand } from '../command.ts';
import { EXIT } from '../errors.ts';
import { managerVersion } from '../versions.ts';

/** `ghost-docker 1.2.3 (abc1234)`, or `ghost-docker dev` from a source tree. */
export function versionLine(): string {
    const { version, commit } = managerVersion();
    return `ghost-docker ${version}${commit ? ` (${commit.slice(0, 7)})` : ''}`;
}

export const versionCommand = defineCommand({
    brief: "Print the manager's version.",
    run: async (_values, _positionals, io) => {
        io.stdout(`${versionLine()}\n`);
        return EXIT.ok;
    },
});
