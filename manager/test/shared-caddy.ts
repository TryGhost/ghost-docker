// A shared Caddy as the daemon shows it, for tests of the sites behind it:
// its network, its container, and the files in its caddy/sites/.
import assert from 'node:assert/strict';
import type { DockerRequest, DockerResponse } from '../src/docker/transport.ts';
import { frame } from '../src/docker/client.ts';
import { json } from './helpers.ts';

export const INFRA_DIR = '/srv/caddy';

/** A shared Caddy as the daemon would show it: its network, its container, and the files it mounts. */
export interface FakeShared {
    /** Files in its caddy/sites/, by name. */
    sites: Map<string, string>;
    /** Host names its loaded configuration matches. */
    hosts: Set<string>;
    running: boolean;
    /** What `caddy validate` says: null accepts. */
    refuse: string | null;
    /** Each command run in its container, with the user it ran as. */
    execs: { cmd: string[]; user: string }[];
    /** The labels the network was created with, when the manager created it. */
    created: Record<string, string> | null;
    exists: boolean;
    /** Another installation, creating the network or a routes file first. */
    raced: { network?: boolean; routes?: string };
    /** A routes write that runs, but whose result the daemon never reports. */
    lost: boolean;
}

export function fakeShared(): FakeShared {
    return {
        sites: new Map(),
        hosts: new Set(),
        running: true,
        refuse: null,
        execs: [],
        created: null,
        exists: true,
        raced: {},
        lost: false,
    };
}

export const CADDY = {
    Id: 'shared-caddy',
    Names: ['/ghost-infra-caddy-1'],
    State: 'running',
    Status: 'Up 2 minutes (healthy)',
    Labels: {
        'org.ghost.docker.managed': 'true',
        'org.ghost.docker.mode': 'infra',
        'com.docker.compose.project': 'ghost-infra',
        'com.docker.compose.project.working_dir': INFRA_DIR,
        'com.docker.compose.service': 'caddy',
    },
    Ports: [
        { PrivatePort: 80, PublicPort: 80, Type: 'tcp' },
        { PrivatePort: 443, PublicPort: 443, Type: 'tcp' },
    ],
    NetworkSettings: { Networks: { 'ghost-ingress': {} } },
};

/** The daemon's answers about the shared Caddy: its network, and commands run in its container. */
export function sharedApi(shared: FakeShared) {
    let pending: { cmd: string[]; user: string } | null = null;
    let status = 0;
    return (request: DockerRequest): DockerResponse | undefined => {
        const { method, path } = request;
        if (path === '/networks/ghost-ingress' && method === 'GET') {
            return shared.exists
                ? json(200, {
                      Id: 'ingress-id',
                      Name: 'ghost-ingress',
                      Labels: shared.created ?? {
                          'org.ghost.docker.infra.dir': INFRA_DIR,
                          'org.ghost.docker.infra.project': 'ghost-infra',
                      },
                  })
                : json(404, { message: 'network ghost-ingress not found' });
        }
        if (path === '/networks/create' && method === 'POST') {
            const body = request.body as { Name: string; Labels: Record<string, string> };
            assert.equal(body.Name, 'ghost-ingress');
            if (shared.raced.network) {
                shared.exists = true;
                return json(409, { message: 'network with name ghost-ingress already exists' });
            }
            shared.created = body.Labels;
            shared.exists = true;
            return json(201, { Id: 'ingress-id' });
        }
        if (path === '/networks/ghost-ingress' && method === 'DELETE') {
            shared.exists = false;
            shared.created = null;
            return { status: 204, body: Buffer.alloc(0) };
        }
        if (path === '/containers/shared-caddy/exec' && method === 'POST') {
            const body = request.body as { Cmd: string[]; User?: string };
            pending = { cmd: body.Cmd, user: body.User ?? '' };
            shared.execs.push(pending);
            return json(201, { Id: 'exec-1' });
        }
        if (path === '/exec/exec-1/start') {
            const { stdout, code } = run(shared, pending!);
            status = code;
            if (shared.lost && pending!.cmd[0] === 'sh' && !pending!.cmd[2]!.includes('grep')) {
                return { status: 500, body: Buffer.from('connection reset') };
            }
            return { status: 200, body: frame(code === 0 ? 1 : 2, stdout) };
        }
        if (path === '/exec/exec-1/json') {
            return json(200, { Running: false, ExitCode: status });
        }
        return undefined;
    };
}

/** A command in the shared Caddy's container, done to the fake's files. */
function run(shared: FakeShared, { cmd }: { cmd: string[] }): { stdout: string; code: number } {
    const name = (path: string) => path.replace('/etc/caddy/sites/', '');
    switch (cmd[0]) {
        case 'flock':
            // Reloads are serialized on the sites' directory.
            assert.equal(cmd[1], '/etc/caddy/sites');
            return run(shared, { cmd: cmd.slice(2) });
        case 'wget': {
            const routes = [...shared.hosts].map((host) => ({ match: [{ host: [host] }] }));
            return {
                stdout: JSON.stringify({ apps: { http: { servers: { srv0: { routes } } } } }),
                code: 0,
            };
        }
        case 'ls':
            return {
                stdout: [...shared.sites.keys()].map((file) => `${file}\n`).join(''),
                code: 0,
            };
        case 'cat': {
            const routes = shared.sites.get(name(cmd[1]!));
            return routes === undefined
                ? { stdout: `cat: ${cmd[1]}: No such file`, code: 1 }
                : { stdout: routes, code: 0 };
        }
        case 'stat':
            return { stdout: '1000:1000\n', code: 0 };
        case 'sh': {
            // sh -c SCRIPT sh MARKER FILE: removes the file if it is that write's.
            if (cmd[2]!.includes('grep')) {
                if (shared.sites.get(name(cmd[5]!))?.split('\n')[0] === cmd[4]) {
                    shared.sites.delete(name(cmd[5]!));
                }
                return { stdout: '', code: 0 };
            }
            // sh -c SCRIPT sh ROUTES FILE, which never overwrites a file.
            if (shared.raced.routes !== undefined) {
                shared.sites.set(name(cmd[5]!), shared.raced.routes);
            }
            if (shared.sites.has(name(cmd[5]!))) {
                return { stdout: '', code: 1 };
            }
            shared.sites.set(name(cmd[5]!), cmd[4]!);
            return { stdout: '', code: 0 };
        }
        case 'rm':
            shared.sites.delete(name(cmd.at(-1)!));
            return { stdout: '', code: 0 };
        case 'caddy':
            if (cmd[1] === 'validate' && shared.refuse !== null) {
                return { stdout: shared.refuse, code: 1 };
            }
            if (cmd[1] === 'reload') {
                // What the files now serve.
                shared.hosts = new Set(
                    [...shared.sites.values()].flatMap(
                        (routes) =>
                            /^([^\s#{][^{]*)\{/m
                                .exec(routes)?.[1]!
                                .split(',')
                                .map((host) => host.trim()) ?? [],
                    ),
                );
            }
            return { stdout: '', code: 0 };
        default:
            return { stdout: `unexpected: ${cmd.join(' ')}`, code: 127 };
    }
}
