// Running other programs: always an argument array, never a shell string, and
// always with a deadline. A Docker daemon that has wedged stops answering
// rather than returning an error, so a call without a deadline hangs.
import { execa } from 'execa';

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

export const exec: Exec = async (command, args, options = {}) => {
    const result = await execa(command, [...args], {
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 32 * 1024 * 1024,
        // Failure is a result here, not an exception: callers read the status.
        reject: false,
        stdin: 'ignore',
    });
    return {
        status: result.exitCode ?? null,
        stdout: result.stdout,
        // A program that could not be started at all has no stderr of its own;
        // say why instead of returning nothing.
        stderr: result.stderr || (result.exitCode === undefined ? (result.shortMessage ?? '') : ''),
        timedOut: result.timedOut,
    };
};
