// Everything a command touches outside itself, so tests can substitute it.
import { exec, type Exec } from './process.ts';

export interface Io {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    env: NodeJS.ProcessEnv;
    cwd: () => string;
    uid: () => number;
    gid: () => number;
    exec: Exec;
}

export const processIo: Io = {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    env: process.env,
    cwd: () => process.cwd(),
    // Optional in Node's types only for Windows, which this Linux image never is.
    uid: () => process.getuid?.() ?? 0,
    gid: () => process.getgid?.() ?? 0,
    exec,
};
