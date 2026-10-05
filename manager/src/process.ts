// Running other programs: always an argument array, never a shell string, and
// always with a deadline. A Docker daemon that has wedged stops answering
// rather than returning an error, so a call without a deadline hangs.
import { execFile } from 'node:child_process';

export interface ExecResult {
    /** The exit status, or null when the process was killed (deadline, signal). */
    status: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

export type Exec = (
    command: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
) => Promise<ExecResult>;

export const exec: Exec = (command, args, options = {}) =>
    new Promise((resolve) => {
        execFile(
            command,
            [...args],
            { timeout: options.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
            (error, stdout, stderr) => {
                if (!error) {
                    resolve({ status: 0, stdout, stderr, timedOut: false });
                    return;
                }
                const failure = error as NodeJS.ErrnoException & { killed?: boolean };
                resolve({
                    status: typeof failure.code === 'number' ? failure.code : null,
                    stdout,
                    // A program that could not be started at all has no stderr of its
                    // own; say why instead of returning nothing.
                    stderr: stderr || (typeof failure.code === 'string' ? failure.message : ''),
                    timedOut: failure.killed === true,
                });
            },
        );
    });
