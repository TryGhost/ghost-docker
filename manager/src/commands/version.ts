import { buildCommand } from '@stricli/core';
import type { ManagerContext } from '../context-stricli.ts';
import { managerVersion } from '../versions.ts';

/** `ghost-docker 1.2.3 (abc1234)`, or `ghost-docker dev` from a source tree. */
export function versionLine(): string {
    const { version, commit } = managerVersion();
    return `ghost-docker ${version}${commit ? ` (${commit.slice(0, 7)})` : ''}`;
}

export const versionCommand = buildCommand<Record<string, never>, [], ManagerContext>({
    func() {
        this.io.stdout(`${versionLine()}\n`);
    },
    parameters: { flags: {} },
    docs: { brief: "Print the manager's version." },
});
