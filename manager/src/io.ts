// Everything a command touches outside itself, so tests can substitute it.
import input from '@inquirer/input';
import select from '@inquirer/select';
import { statfsSync } from 'node:fs';
import { socketTransport, type DockerTransport } from './docker/transport.ts';
import { exec, type Exec } from './process.ts';

export interface Io {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    env: NodeJS.ProcessEnv;
    cwd: () => string;
    uid: () => number;
    gid: () => number;
    /** The Docker Engine API, over the mounted socket. */
    docker: DockerTransport;
    /** Other programs: Compose, and nothing else the daemon could answer for. */
    exec: Exec;
    /** Bytes free to this user on the filesystem holding `path`, or null when unknown. */
    freeBytes: (path: string) => number | null;
    /**
     * Questions for the person at the terminal, or null when there is none to
     * ask, so a missing answer is an error naming the option that supplies it.
     */
    prompt: Prompter | null;
}

export interface Prompter {
    choose: <T extends string>(
        message: string,
        choices: readonly { name: string; value: T }[],
    ) => Promise<T>;
    /** `check` returns an error message for an answer it refuses, which is asked again. */
    text: (message: string, check?: (answer: string) => string | null) => Promise<string>;
}

const terminal: Prompter = {
    choose: (message, choices) => select({ message, choices }),
    text: (message, check) =>
        input({ message, validate: (answer) => check?.(answer.trim()) ?? true }).then((answer) =>
            answer.trim(),
        ),
};

export const processIo: Io = {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    env: process.env,
    cwd: () => process.cwd(),
    // Optional in Node's types only for Windows, which this Linux image never is.
    uid: () => process.getuid?.() ?? 0,
    gid: () => process.getgid?.() ?? 0,
    docker: socketTransport(process.env.GD_DOCKER_SOCKET ?? '/var/run/docker.sock'),
    exec,
    freeBytes: (path) => {
        try {
            const stats = statfsSync(path);
            return stats.bavail * stats.bsize;
        } catch {
            return null;
        }
    },
    // The launcher attaches a terminal when it has one, also when piped from curl.
    prompt: process.stdin.isTTY && process.stdout.isTTY ? terminal : null,
};
