// What stricli hands every command as `this`: its own process streams, and
// the manager's Io, which is the seam tests substitute.
import type { CommandContext, StricliProcess } from '@stricli/core';
import type { Io } from './io.ts';

export interface ManagerContext extends CommandContext {
    readonly process: StricliProcess;
    readonly io: Io;
}

export function contextFor(io: Io): ManagerContext {
    const stream = (write: (text: string) => void) => ({
        write: (chunk: string) => {
            write(chunk);
            return true;
        },
    });
    return {
        process: { stdout: stream(io.stdout), stderr: stream(io.stderr), env: io.env },
        io,
    };
}
