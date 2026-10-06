// Running other programs, written as a template: exec`docker compose version`.
// Interpolated values are whole arguments, never re-split, and an array is
// several; there is no shell. Every run has a deadline: a program that has
// wedged stops answering rather than returning an error.
import { execa, type ExecaMethod, type Options } from 'execa';

export interface ExecResult {
    /** The exit status, or null when the process was killed (deadline, signal) or never started. */
    status: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

export interface ExecOptions {
    timeoutMs?: number;
    cwd?: string;
    env?: Record<string, string | undefined>;
}

export type TemplateValue = string | number | readonly (string | number)[];

export interface Exec {
    (strings: TemplateStringsArray, ...values: TemplateValue[]): Promise<ExecResult>;
    /** The same, with these options layered on top. */
    with(options: ExecOptions): Exec;
}

const defaults: Options = {
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    // Failure is a result here, not an exception: callers read the status.
    reject: false,
    stdin: 'ignore',
};

function bind(instance: ExecaMethod<Options>): Exec {
    const run: Exec = async (strings, ...values) => {
        const result = await instance(strings, ...(values as TemplateValue[]));
        // Text, always: no option here asks execa for lines, buffers or streams,
        // which is why its wider result type is narrowed rather than handled.
        const stdout = typeof result.stdout === 'string' ? result.stdout : '';
        const stderr = typeof result.stderr === 'string' ? result.stderr : '';
        return {
            status: result.exitCode ?? null,
            stdout,
            // A program that could not be started at all has no stderr of its
            // own; say why instead of returning nothing.
            stderr: stderr || (result.exitCode === undefined ? (result.shortMessage ?? '') : ''),
            timedOut: result.timedOut,
        };
    };
    run.with = (options) =>
        bind(
            instance({
                ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
                ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
                ...(options.env !== undefined ? { env: options.env } : {}),
            }),
        );
    return run;
}

export const exec: Exec = bind(execa(defaults));
