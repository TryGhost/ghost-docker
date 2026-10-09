// Everything a command touches outside itself, so tests can substitute it.
import input from '@inquirer/input';
import select from '@inquirer/select';
import { lookup } from 'node:dns/promises';
import { readFileSync, statfsSync } from 'node:fs';
import { connect } from 'node:net';
import { hostname } from 'node:os';
import { Spinner } from 'picospinner';
import { nodeClients, type Clients } from './clients.ts';
import type { ServiceState } from './compose.ts';
import { onSiteNetwork, type SiteNetwork } from './network.ts';
import { socketTransport, type DockerTransport } from './docker/transport.ts';
import { exec, type Exec } from './process.ts';

export interface Io {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    /**
     * Runs `work` behind a spinner, cleared when it settles; at no terminal it
     * simply runs. Nothing may be printed meanwhile: the spinner owns the last line.
     */
    busy: <T>(text: string, work: () => Promise<T>) => Promise<T>;
    env: NodeJS.ProcessEnv;
    cwd: () => string;
    uid: () => number;
    gid: () => number;
    /** The Docker Engine API, over the mounted socket. */
    docker: DockerTransport;
    /** Other programs: Compose, and nothing else the daemon could answer for. */
    exec: Exec;
    /**
     * The manager's own container, as the daemon names it, or null when it
     * cannot tell; it joins a site's network by this (network.ts).
     */
    containerId: () => string | null;
    /**
     * Runs `work` with the manager on the network the running containers of
     * `wanted` share, and off it again however `work` ends (network.ts).
     */
    siteNetwork: <T>(
        services: readonly ServiceState[],
        wanted: readonly string[],
        work: (network: SiteNetwork) => Promise<T>,
    ) => Promise<T>;
    /** A site's services, spoken to directly once the manager is on its network. */
    clients: Clients;
    /** Bytes free to this user on the filesystem holding `path`, or null when unknown. */
    freeBytes: (path: string) => number | null;
    /**
     * Whether something on the host answers on its loopback `port`, or null
     * where the host cannot be reached that way (see HOST_ALIAS).
     */
    hostListens: (port: number) => Promise<boolean | null>;
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

const isTTY = process.stdin.isTTY && process.stdout.isTTY;

/**
 * The host itself, from a container, on Docker Desktop and OrbStack. Their
 * daemon is in a VM whose port forwarding publishes a port that a host
 * process already holds without any error, and the host process keeps
 * answering it. A Linux engine has no such alias, and there the bind fails
 * loudly instead.
 */
const HOST_ALIAS = 'host.docker.internal';

async function hostListens(port: number): Promise<boolean | null> {
    let address: string;
    try {
        ({ address } = await lookup(HOST_ALIAS));
    } catch {
        return null;
    }
    return new Promise((resolve) => {
        const socket = connect({ host: address, port, timeout: 1500 });
        const settle = (listening: boolean) => {
            socket.destroy();
            resolve(listening);
        };
        socket.once('connect', () => settle(true));
        socket.once('timeout', () => settle(false));
        socket.once('error', () => settle(false));
    });
}

/**
 * Docker bind-mounts the container's own hostname, hosts and resolv.conf
 * from the directory named by its full ID, rootless Docker and Docker
 * Desktop included, so the mount table names it whatever the hostname was
 * set to. The default hostname, the short ID, is the fallback.
 */
function containerId(): string | null {
    try {
        const id = /\/containers\/([0-9a-f]{64})\//.exec(
            readFileSync('/proc/self/mountinfo', 'utf8'),
        );
        if (id) {
            return id[1]!;
        }
    } catch {
        // Not Linux, or no /proc: not in a container.
    }
    const name = hostname();
    return /^[0-9a-f]{12,64}$/.test(name) ? name : null;
}

export const processIo: Io = {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    busy: async (text, work) => {
        if (!isTTY) {
            return work();
        }
        const spinner = new Spinner(text);
        spinner.start();
        try {
            return await work();
        } finally {
            spinner.stop();
        }
    },
    env: process.env,
    cwd: () => process.cwd(),
    // Optional in Node's types only for Windows, which this Linux image never is.
    uid: () => process.getuid?.() ?? 0,
    gid: () => process.getgid?.() ?? 0,
    docker: socketTransport(process.env.GD_DOCKER_SOCKET ?? '/var/run/docker.sock'),
    exec,
    containerId,
    siteNetwork: (services, wanted, work) => onSiteNetwork(processIo, services, wanted, work),
    clients: nodeClients,
    hostListens,
    freeBytes: (path) => {
        try {
            const stats = statfsSync(path);
            return stats.bavail * stats.bsize;
        } catch {
            return null;
        }
    },
    // The launcher attaches a terminal when it has one, also when piped from curl.
    prompt: isTTY ? terminal : null,
};
