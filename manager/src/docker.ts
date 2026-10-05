// What the Docker daemon says about itself and its host.
//
// The manager cannot look at the host: it is in a container. Everything it
// knows about the platform it asks the daemon for, through the mounted socket.
import { z } from 'zod';
import type { Exec } from './process.ts';

const info = z.object({
    ServerVersion: z.string().default(''),
    OperatingSystem: z.string().default(''),
    OSType: z.string().default(''),
    Architecture: z.string().default(''),
    MemTotal: z.number().default(0),
    SecurityOptions: z.array(z.string()).nullable().default([]),
});

export interface DaemonInfo {
    serverVersion: string;
    operatingSystem: string;
    osType: string;
    architecture: string;
    memoryBytes: number;
    rootless: boolean;
}

export type DaemonResult = { ok: true; info: DaemonInfo } | { ok: false; reason: string };

export async function daemonInfo(exec: Exec): Promise<DaemonResult> {
    const result = await exec('docker', ['info', '--format', '{{json .}}'], { timeoutMs: 20_000 });
    if (result.timedOut) {
        return {
            ok: false,
            reason: 'the Docker daemon did not answer within 20 seconds',
        };
    }
    if (result.status !== 0) {
        return {
            ok: false,
            reason: firstLine(result.stderr) || 'the Docker daemon could not be reached',
        };
    }
    let parsed;
    try {
        parsed = info.parse(JSON.parse(result.stdout));
    } catch {
        return { ok: false, reason: '`docker info` returned something that is not its usual JSON' };
    }
    return {
        ok: true,
        info: {
            serverVersion: parsed.ServerVersion,
            operatingSystem: parsed.OperatingSystem,
            osType: parsed.OSType,
            architecture: parsed.Architecture,
            memoryBytes: parsed.MemTotal,
            rootless: (parsed.SecurityOptions ?? []).some((option) => option.includes('rootless')),
        },
    };
}

/** The version of the Compose client in this image. */
export async function composeVersion(exec: Exec): Promise<string | null> {
    const result = await exec('docker', ['compose', 'version', '--short'], { timeoutMs: 20_000 });
    const version = result.stdout.trim();
    return result.status === 0 && version ? version : null;
}

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';
