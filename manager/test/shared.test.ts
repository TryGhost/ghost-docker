// The shared Caddy, against a scripted daemon and Compose: `install --infra`,
// a production install joining it, the refusals before anything is written,
// and `list`, `check`, `remove` and `config validate` knowing about it. What
// the real Caddy does with the routes is test/integration/shared.test.ts, and
// several sites on one server tests/e2e/shared-caddy.sh.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import * as env from '../src/env.ts';
import type { DockerRequest, DockerResponse } from '../src/docker/transport.ts';
import { frame } from '../src/docker/client.ts';
import { payloadFiles } from '../src/payload.ts';
import { layoutOf, readSettings, siteFacts, siteMode } from '../src/site.ts';
import { verifyIngress } from '../src/verify.ts';
import { failed, harness, json, ok, type Harness } from './helpers.ts';
import { imageApi, imageStack, rootContainer } from './site.ts';

const INFRA_DIR = '/srv/caddy';

/** A shared Caddy as the daemon would show it: its network, its container, and the files it mounts. */
interface FakeShared {
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
}

function fakeShared(): FakeShared {
    return {
        sites: new Map(),
        hosts: new Set(),
        running: true,
        refuse: null,
        execs: [],
        created: null,
        exists: true,
    };
}

const CADDY = {
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
function sharedApi(shared: FakeShared) {
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
        case 'stat':
            return { stdout: '1000:1000\n', code: 0 };
        case 'sh': {
            // sh -c SCRIPT sh ROUTES FILE
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

let h: Harness;
let shared: FakeShared;
let compose: string[][];
let ps: () => string;
beforeEach(() => {
    h = harness();
    imageStack(h);
    shared = fakeShared();
    compose = [];
    ps = () => '';
    const images = imageApi();
    const caddy = sharedApi(shared);
    h.daemon.api = (request) => images(request) ?? caddy(request);
    h.daemon.run = rootContainer;
    h.daemon.containers = [CADDY];
    h.daemon.composeRun = (args) => {
        compose.push(args);
        switch (args[0]) {
            case 'config':
                return ok(JSON.stringify({ services: { ghost: { environment: {} } } }));
            case 'ps':
                return ok(ps());
            default:
                return ok('');
        }
    };
});
afterEach(() => h.cleanup());

const settings = () => env.toRecord(readFileSync(join(h.dir, '.env'), 'utf8'));
const files = () =>
    readdirSync(h.dir)
        .filter((name) => name !== '.ghost-docker-probe')
        .sort();

describe('install --infra', () => {
    beforeEach(() => {
        shared.exists = false;
        h.daemon.containers = [];
    });

    test('sets up Caddy alone, on a network no project owns, labelled with where it is', async () => {
        ps = () =>
            JSON.stringify({ ID: 'c', Service: 'caddy', State: 'running', Health: 'healthy' });
        const result = await h.run('install', '--infra');
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(shared.created, {
            'org.ghost.docker.managed': 'true',
            'org.ghost.docker.infra.dir': h.dir,
            'org.ghost.docker.infra.project': 'ghost-infra',
        });
        assert.deepEqual(
            {
                profiles: settings().COMPOSE_PROFILES,
                mode: settings().SITE_MODE,
                project: settings().COMPOSE_PROJECT_NAME,
                network: settings().INGRESS_NETWORK,
                external: settings().INGRESS_EXTERNAL,
                http: settings().HTTP_PORT,
                url: settings().URL,
            },
            {
                profiles: 'infra',
                mode: 'infra',
                project: 'ghost-infra',
                network: 'ghost-ingress',
                external: 'true',
                http: '80',
                url: undefined,
            },
        );
        // Caddy's files, and nothing of a site's: no Ghost, MySQL or metadata.
        assert.deepEqual(files(), [
            '.env',
            '.env.example',
            'caddy',
            'compose.ipv6.yml',
            'compose.yml',
            'ghost-docker',
        ]);
        assert.ok(existsSync(join(h.dir, 'caddy', 'sites')));
        assert.ok(compose.some((args) => args[0] === 'up'));
        assert.match(result.stdout, /The shared Caddy is installed/);
    });

    test('a server has one: a second is refused before anything is written', async () => {
        shared.exists = true;
        const result = await h.run('install', '--infra');
        assert.equal(result.code, 1);
        assert.match(result.stderr, /already has the shared Caddy in \/srv\/caddy/);
        assert.deepEqual(files(), []);
    });

    test('80 and 443 must be free', async () => {
        h.daemon.containers = [{ ...CADDY, Id: 'p', Names: ['/operators-proxy'], Labels: {} }];
        const result = await h.run('install', '--infra');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /port 80 is already in use by the Docker container operators-proxy/,
        );
        assert.equal(shared.created, null);
    });

    test('it takes no site options', async () => {
        const result = await h.run(
            'install',
            '--infra',
            '--domain',
            'example.com',
            '--with',
            'activitypub',
        );
        assert.equal(result.code, 2);
        assert.match(
            result.stderr,
            /--infra sets up the shared Caddy alone, so it takes no --domain, --with/,
        );
    });

    test('a failed start removes the network with everything else', async () => {
        h.daemon.composeRun = (args) =>
            args[0] === 'up' ? failed(1, 'Bind for 0.0.0.0:80 failed') : ok('');
        const result = await h.run('install', '--infra');
        assert.equal(result.code, 1);
        assert.equal(shared.exists, false);
        assert.deepEqual(files(), []);
    });
});

describe('a production install on a server with the shared Caddy', () => {
    test('joins it: no Caddy of its own, its routes in the shared Caddy, loaded', async () => {
        const result = await h.run(
            'install',
            '--domain',
            'example.com',
            '--with',
            'activitypub',
            '--no-start',
        );
        assert.equal(result.code, 0, result.stderr);
        const values = settings();
        assert.equal(values.COMPOSE_PROFILES, 'member,activitypub');
        assert.equal(values.SITE_MODE, 'production');
        assert.equal(values.INGRESS_NETWORK, 'ghost-ingress');
        assert.equal(values.INGRESS_EXTERNAL, 'true');
        assert.equal(values.HTTP_PORT, undefined);
        assert.ok(!existsSync(join(h.dir, 'caddy')), 'a member has no caddy/ of its own');
        const routes = shared.sites.get('ghost-example-com.caddy')!;
        assert.match(routes, /^example\.com \{$/m);
        assert.match(routes, /reverse_proxy ghost-ghost-example-com:2368/);
        assert.match(routes, /ActivityPub activitypub-ghost-example-com:8080/);
        // Written as whoever owns caddy/sites/, then validated, then loaded.
        const commands = shared.execs.map(
            ({ cmd, user }) => `${cmd[0]} ${cmd[1]}${user ? ` as ${user}` : ''}`,
        );
        assert.deepEqual(commands.slice(-4), [
            'stat -c',
            'sh -c as 1000:1000',
            'caddy validate',
            'caddy reload',
        ]);
        assert.ok(shared.hosts.has('example.com'));
        const metadata = JSON.parse(readFileSync(join(h.dir, '.ghost-docker.json'), 'utf8'));
        assert.equal(metadata.mode, 'production');
        assert.ok(!Object.keys(metadata.payload).some((file) => file.startsWith('caddy/')));
        assert.match(
            result.stdout,
            /Routes +\/srv\/caddy\/caddy\/sites\/ghost-example-com\.caddy, served by the shared Caddy/,
        );
    });

    test('80 and 443 are the shared Caddy’s, and not asked for', async () => {
        const result = await h.run('install', '--domain', 'example.com', '--no-start');
        assert.equal(result.code, 0, result.stderr);
    });

    test('a domain it already serves is refused before anything is written', async () => {
        shared.hosts.add('www.example.com');
        const result = await h.run(
            'install',
            '--domain',
            'blog.example.com',
            '--admin-domain',
            'www.example.com',
            '--no-start',
        );
        assert.equal(result.code, 1);
        assert.match(result.stderr, /already serves www\.example\.com/);
        assert.deepEqual(files(), []);
        assert.equal(shared.sites.size, 0);
    });

    test('a project that already has routes is refused before anything is written', async () => {
        shared.sites.set('ghost-example-com.caddy', 'routes of another directory');
        const result = await h.run('install', '--domain', 'example.com', '--no-start');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /ghost-example-com\.caddy already exists: the project ghost-example-com already has routes/,
        );
        assert.match(result.stderr, /--name/);
        assert.deepEqual(files(), []);
        assert.equal(shared.sites.get('ghost-example-com.caddy'), 'routes of another directory');
    });

    test('a stopped shared Caddy is refused, saying how to start it', async () => {
        h.daemon.containers = [{ ...CADDY, State: 'exited' }];
        const result = await h.run('install', '--domain', 'example.com', '--no-start');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /the shared Caddy in \/srv\/caddy is not running[\s\S]*cd \/srv\/caddy && docker compose up -d/,
        );
        assert.deepEqual(files(), []);
    });

    test('routes Caddy refuses are removed with everything else the installation created', async () => {
        shared.refuse = 'Error: adapting config using caddyfile: ambiguous site definition';
        const result = await h.run('install', '--domain', 'example.com', '--no-start');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /does not accept its configuration[\s\S]*ambiguous site definition/,
        );
        assert.equal(shared.sites.size, 0);
        assert.deepEqual(files(), []);
    });

    test('a local site never joins it', async () => {
        const result = await h.run('install', '--local', '--no-start');
        assert.equal(result.code, 0, result.stderr);
        assert.equal(settings().COMPOSE_PROFILES, 'local');
        assert.equal(settings().INGRESS_NETWORK, undefined);
        assert.deepEqual(shared.execs, []);
    });
});

describe('a server without one', () => {
    test('a production site gets a Caddy and a network of its own, as before', async () => {
        shared.exists = false;
        h.daemon.containers = [];
        const result = await h.run('install', '--domain', 'example.com', '--no-start');
        assert.equal(result.code, 0, result.stderr);
        assert.equal(settings().COMPOSE_PROFILES, 'production');
        assert.equal(settings().INGRESS_NETWORK, undefined);
        assert.ok(existsSync(join(h.dir, 'caddy', 'sites', 'site.caddy')));
    });
});

/** A member's .env, as install writes it. */
const memberEnv = (project = 'ghost-example-com') =>
    writeFileSync(
        join(h.dir, '.env'),
        env.serializeAll([
            ['COMPOSE_PROFILES', 'member'],
            ['SITE_MODE', 'production'],
            ['COMPOSE_PROJECT_NAME', project],
            ['PROJECT_DIR', h.dir],
            ['URL', 'https://example.com'],
            ['GHOST_VERSION', '6-next-alpine'],
            ['DATABASE_PASSWORD', 'a'],
            ['DATABASE_ROOT_PASSWORD', 'b'],
            ['INGRESS_NETWORK', 'ghost-ingress'],
            ['INGRESS_EXTERNAL', 'true'],
        ]),
        { mode: 0o600 },
    );

describe('remove', () => {
    test("a member's routes are removed and the shared Caddy reloaded, then the site is taken down", async () => {
        memberEnv();
        shared.sites.set('ghost-example-com.caddy', 'example.com {\n}\n');
        shared.sites.set('ghost-other-com.caddy', 'other.com {\n}\n');
        const result = await h.run('remove', '--yes');
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual([...shared.sites.keys()], ['ghost-other-com.caddy']);
        assert.deepEqual(shared.execs.map(({ cmd }) => cmd[0]).slice(-2), ['rm', 'caddy']);
        assert.ok(compose.some((args) => args[0] === 'down' && !args.includes('--volumes')));
        assert.ok(existsSync(join(h.dir, '.env')), 'the directory and its data stay');
        assert.match(result.stdout, /still holds its configuration, data and backups/);
    });

    test('it is asked, or --yes says so', async () => {
        memberEnv();
        shared.sites.set('ghost-example-com.caddy', 'x');
        const result = await h.run('remove');
        assert.equal(result.code, 2);
        assert.match(result.stderr, /Run it again with --yes/);
        assert.equal(shared.sites.size, 1);
        assert.ok(!compose.some((args) => args[0] === 'down'));
    });

    test('the shared Caddy itself is not a site', async () => {
        writeFileSync(
            join(h.dir, '.env'),
            env.serializeAll([
                ['COMPOSE_PROFILES', 'infra'],
                ['SITE_MODE', 'infra'],
            ]),
        );
        const result = await h.run('remove', '--yes');
        assert.equal(result.code, 1);
        assert.match(result.stderr, /holds the shared Caddy, not a site/);
    });
});

describe('verification', () => {
    const answer = {
        status: 200,
        body: JSON.stringify({ site: { url: 'https://example.com/' } }),
        location: null,
        certificate: {
            issuer: "Let's Encrypt",
            covers: true,
            validTo: '2027-01-07T12:00:00.000Z',
            expired: false,
            untrusted: null,
        },
    };

    test("a member is asked for through the shared Caddy, whose routes file is this site's", async () => {
        memberEnv();
        shared.sites.set('ghost-example-com.caddy', 'example.com {\n}\n');
        ps = () =>
            JSON.stringify({ ID: 'g', Service: 'ghost', State: 'running', Health: 'healthy' });
        h.daemon.https = ({ host, servername }) => {
            assert.equal(host, 'caddy-ghost-example-com');
            assert.equal(servername, 'example.com');
            return answer;
        };
        const checks = await verifyIngress(h.io(), siteFacts(h.dir, readSettings(h.dir)!));
        const by = Object.fromEntries(checks.map((check) => [check.label, check]));
        assert.equal(by['shared caddy']?.status, 'ok');
        assert.equal(by.routes?.status, 'ok');
        assert.match(by.routes!.detail, /\/srv\/caddy\/caddy\/sites\/ghost-example-com\.caddy/);
        assert.equal(by.https?.status, 'ok', by.https?.detail ?? '');
        assert.match(
            by['published ports']!.detail,
            /the shared Caddy on 0\.0\.0\.0:80, 0\.0\.0\.0:443/,
        );
    });

    test('routes that are gone, or a shared Caddy that is gone, are errors', async () => {
        memberEnv();
        ps = () =>
            JSON.stringify({ ID: 'g', Service: 'ghost', State: 'running', Health: 'healthy' });
        h.daemon.https = () => answer;
        let checks = await verifyIngress(h.io(), siteFacts(h.dir, readSettings(h.dir)!));
        assert.match(
            checks.find((check) => check.label === 'routes')!.detail,
            /ghost-example-com\.caddy does not exist/,
        );
        shared.exists = false;
        checks = await verifyIngress(h.io(), siteFacts(h.dir, readSettings(h.dir)!));
        const missing = checks.find((check) => check.label === 'shared caddy')!;
        assert.equal(missing.status, 'error');
        assert.match(missing.detail, /this server has none/);
    });
});

describe('list', () => {
    test('shows the shared Caddy and the sites behind it', async () => {
        h.daemon.containers = [
            CADDY,
            {
                Id: 'm',
                Names: ['/ghost-example-com-ghost-1'],
                Labels: {
                    'org.ghost.docker.managed': 'true',
                    'org.ghost.docker.mode': 'production',
                    'com.docker.compose.project': 'ghost-example-com',
                },
                Ports: [],
                NetworkSettings: {
                    Networks: { 'ghost-example-com_ghost_network': {}, 'ghost-ingress': {} },
                },
            },
            {
                Id: 's',
                Names: ['/ghost-solo-com-ghost-1'],
                Labels: {
                    'org.ghost.docker.managed': 'true',
                    'org.ghost.docker.mode': 'production',
                    'com.docker.compose.project': 'ghost-solo-com',
                },
                Ports: [],
                NetworkSettings: { Networks: { 'ghost-solo-com_ingress': {} } },
            },
        ];
        h.daemon.composeRun = (args) =>
            args[0] === 'ls'
                ? ok(
                      JSON.stringify(
                          ['ghost-infra', 'ghost-example-com', 'ghost-solo-com'].map((name) => ({
                              Name: name,
                              Status: 'running(1)',
                              ConfigFiles: `/srv/${name}/compose.yml`,
                          })),
                      ),
                  )
                : undefined;
        const result = await h.run('list');
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /^ghost-example-com +member /m);
        assert.match(result.stdout, /^ghost-infra +shared caddy /m);
        assert.match(result.stdout, /^ghost-solo-com +production /m);
        assert.match(result.stdout, /A member is a production site behind the shared Caddy/);
    });
});

describe('config validate', () => {
    test("the shared Caddy's .env needs no Ghost, but its network", async () => {
        writeFileSync(
            join(h.dir, '.env'),
            env.serializeAll([
                ['COMPOSE_PROFILES', 'infra'],
                ['SITE_MODE', 'infra'],
                ['COMPOSE_PROJECT_NAME', 'ghost-infra'],
                ['PROJECT_DIR', h.dir],
                ['INGRESS_NETWORK', 'ghost-ingress'],
                ['INGRESS_EXTERNAL', 'true'],
            ]),
            { mode: 0o600 },
        );
        const valid = await h.run('config', 'validate');
        assert.equal(valid.code, 0, valid.stdout + valid.stderr);
        assert.match(valid.stdout, /valid for the shared Caddy/);

        writeFileSync(
            join(h.dir, '.env'),
            env.serializeAll([
                ['COMPOSE_PROFILES', 'infra,activitypub'],
                ['SITE_MODE', 'infra'],
                ['COMPOSE_PROJECT_NAME', 'ghost-infra'],
                ['PROJECT_DIR', h.dir],
            ]),
            { mode: 0o600 },
        );
        const invalid = await h.run('config', 'validate');
        assert.equal(invalid.code, 1);
        assert.match(invalid.stdout + invalid.stderr, /runs Caddy alone: remove activitypub/);
        assert.match(
            invalid.stdout + invalid.stderr,
            /INGRESS_NETWORK is required for the shared Caddy/,
        );
        assert.match(invalid.stdout + invalid.stderr, /INGRESS_EXTERNAL must be true/);
    });

    test('a member is a production site, and must be on the shared network', async () => {
        memberEnv();
        const valid = await h.run('config', 'validate');
        assert.equal(valid.code, 0, valid.stdout + valid.stderr);
        assert.match(valid.stdout, /valid for a production site/);

        const values = settings();
        delete values.INGRESS_EXTERNAL;
        writeFileSync(join(h.dir, '.env'), env.serializeAll(Object.entries(values)), {
            mode: 0o600,
        });
        const invalid = await h.run('config', 'validate');
        assert.equal(invalid.code, 1);
        assert.match(invalid.stdout + invalid.stderr, /INGRESS_EXTERNAL must be true/);
    });

    test('a site needs its database passwords, which compose.yml no longer guards', async () => {
        memberEnv();
        const values = settings();
        delete values.DATABASE_ROOT_PASSWORD;
        writeFileSync(join(h.dir, '.env'), env.serializeAll(Object.entries(values)), {
            mode: 0o600,
        });
        const result = await h.run('config', 'validate');
        assert.equal(result.code, 1);
        assert.match(result.stdout + result.stderr, /DATABASE_ROOT_PASSWORD is required/);
    });
});

describe('the pieces', () => {
    test('member selects production; infra selects no site mode', () => {
        assert.equal(siteMode('member,activitypub'), 'production');
        assert.equal(siteMode('member,production'), null);
        assert.equal(siteMode('infra'), null);
        assert.equal(layoutOf('member,analytics'), 'member');
        assert.equal(layoutOf('infra'), 'infra');
        assert.equal(layoutOf('production'), 'production');
        assert.equal(layoutOf('local,mailpit'), 'local');
    });

    test("each layout's stack files", () => {
        const stack = h.env.GD_STACK_DIR!;
        const tops = (layout: Parameters<typeof payloadFiles>[1]) => [
            ...new Set(payloadFiles(stack, layout).map((file) => file.split('/')[0])),
        ];
        assert.deepEqual(tops('infra'), [
            '.env.example',
            'caddy',
            'compose.ipv6.yml',
            'compose.yml',
        ]);
        assert.ok(!tops('member').includes('caddy'));
        assert.ok(tops('member').includes('tinybird'));
        assert.ok(tops('production').includes('caddy'));
    });
});
