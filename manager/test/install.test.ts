// install, against a scripted daemon and Compose. What a real installation
// does on a real host is tests/e2e/install.sh; this is what it decides.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { channelOf, choosePort, projectName, secret, slug } from '../src/commands/install.ts';
import * as env from '../src/env.ts';
import { ghostTag } from '../src/ghost.ts';
import { failed, harness, json, ok, type Harness } from './helpers.ts';
import { REPO } from './site.ts';

const INDEX = `sha256:${'1'.repeat(64)}`;
const REFERENCE = `ghost@${INDEX}`;

let h: Harness;
let stack: string;
let compose: string[][];
let up: () => ReturnType<typeof ok>;
beforeEach(() => {
    h = harness();
    stack = join(h.dir, '..', `${h.dir.split('/').pop()}-stack`);
    // The payload as the image carries it.
    mkdirSync(stack, { recursive: true });
    for (const file of ['compose.yml', 'compose.ipv6.yml', '.env.example', 'ghost.env.example']) {
        cpSync(join(REPO, file), join(stack, file));
    }
    for (const directory of ['caddy', 'mysql-init']) {
        cpSync(join(REPO, directory), join(stack, directory), { recursive: true });
    }
    h.env.GD_STACK_DIR = stack;
    h.env.GD_LAUNCHER_SOURCE = join(REPO, 'ghost-docker');
    h.env.GD_SOURCE = 'image';

    compose = [];
    up = () => ok('');
    h.daemon.api = ({ method, path }) => {
        if (method === 'POST' && path === '/images/create') {
            return { status: 200, body: Buffer.from('{"status":"Pulled"}\n') };
        }
        if (method === 'GET' && path === '/images/ghost:6-next-alpine/json') {
            return json(200, {
                Id: INDEX,
                RepoDigests: [REFERENCE],
                Config: {
                    Env: [
                        'GHOST_VERSION=6.67.0',
                        'GHOST_CONTENT=/home/ghost/content',
                        'GHOST_INSTALL=/home/ghost',
                    ],
                },
            });
        }
        if (method === 'GET' && path === '/images/ghost-docker:checkout/json') {
            return json(200, {
                Id: `sha256:${'2'.repeat(64)}`,
                RepoDigests: [],
                Config: { Env: [] },
            });
        }
        return undefined;
    };
    h.daemon.run = ({ entrypoint }) => {
        if (entrypoint[0] === 'rm') {
            return { status: 0 };
        }
        return undefined;
    };
    h.daemon.composeRun = (args) => {
        compose.push(args);
        switch (args[0]) {
            case 'config':
                return ok(JSON.stringify({ services: { ghost: { environment: {} } } }));
            case 'up':
                return up();
            default:
                return ok('');
        }
    };
});
afterEach(() => h.cleanup());

const install = (...args: string[]) => h.run('install', ...args);
const siteFiles = () =>
    readdirSync(h.dir)
        .filter((name) => name !== '.ghost-docker-probe')
        .sort();

describe('refusals that change nothing', () => {
    test('usage errors exit 2', async () => {
        for (const [args, message] of [
            [[], /choose a site mode: --local, or --domain example.com/],
            [['--local', '--domain', 'example.com'], /not both/],
            [['--local', '--with', 'analytics'], /set up after installation.*\n.*TINYBIRD\.md/],
            [['--local', '--without', 'redis'], /without/],
            [
                ['--local', '--admin-domain', 'admin.example.com'],
                /--admin-domain applies to production sites only/,
            ],
            [['--local', '--email', 'ops@example.com'], /--email applies to production sites only/],
            [['--domain', 'https://example.com'], /--domain must be a hostname, not a URL/],
            [['--domain', 'example.com', '--email', 'nobody'], /--email must be an email address/],
            [['--domain', 'example.com', '--admin-domain', 'example.com'], /must differ/],
            [['--local', '--with', 'redis'], /unknown optional service: redis/],
            [['--domain', 'example.com', '--with', 'mailpit'], /mailpit is for local sites only/],
            [['--local', '--with', 'production'], /--with selects optional services/],
            [['--local', '--port', '70000'], /port number/],
            [['--local', '--frobnicate'], /frobnicate/],
            // Options whose step has not landed do not exist yet.
            [['--migrate'], /Unknown option '--migrate'/],
            [['--local', '--channel', 'beta'], /Unknown option '--channel'/],
            [['--local', '--with', 'supervisor'], /unknown optional service: supervisor/],
        ] as const) {
            const result = await install(...args);
            assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`);
            assert.match(result.stderr, message);
        }
        assert.deepEqual(siteFiles(), []);
    });

    test('at a terminal, the mode and the domain are asked for', async () => {
        h.answers = ['production', 'example.com'];
        assert.equal((await install('--no-start')).code, 0);
        assert.deepEqual(h.asked, ['What kind of site?', 'Its domain (example.com):']);
        assert.equal(
            env.get(readFileSync(join(h.dir, '.env'), 'utf8'), 'URL'),
            'https://example.com',
        );
    });

    test('--no-prompt never asks, even at a terminal', async () => {
        h.answers = ['local'];
        const result = await install('--no-prompt');
        assert.equal(result.code, 2);
        assert.match(result.stderr, /choose a site mode/);
        assert.deepEqual(h.asked, []);
    });

    test('nothing is asked before the directory is known to be free', async () => {
        h.answers = ['local'];
        writeFileSync(join(h.dir, '.env'), 'A="b"\n');
        assert.equal((await install()).code, 1);
        assert.deepEqual(h.asked, []);
    });

    test('an existing site is never installed over', async () => {
        writeFileSync(join(h.dir, '.env'), 'A="b"\n');
        const result = await install('--local');
        assert.equal(result.code, 1);
        assert.match(result.stderr, /already holds a site.*\n.*Nothing has been changed/);
    });

    test('files the payload would write over are refused, by name', async () => {
        writeFileSync(join(h.dir, 'compose.yml'), 'mine\n');
        const result = await install('--local');
        assert.equal(result.code, 1);
        assert.match(result.stderr, /already has compose\.yml, which installation would write/);
        assert.equal(readFileSync(join(h.dir, 'compose.yml'), 'utf8'), 'mine\n');
    });

    test('existing data is never installed over', async () => {
        mkdirSync(join(h.dir, 'data', 'mysql'), { recursive: true });
        writeFileSync(join(h.dir, 'data', 'mysql', 'ibdata1'), '');
        const result = await install('--local');
        assert.match(result.stderr, /data\/mysql is not empty/);
    });

    test('a port a container publishes is refused before anything is written, naming the container', async () => {
        h.daemon.containers = [
            {
                Id: 'p',
                Names: ['/operators-proxy'],
                Ports: [
                    { PrivatePort: 80, PublicPort: 80, Type: 'tcp' },
                    { PrivatePort: 443, PublicPort: 443, Type: 'tcp' },
                ],
            },
        ];
        const result = await install('--domain', 'example.com');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /port 80 is already in use by the Docker container operators-proxy/,
        );
        assert.match(result.stderr, /port 443/);
        assert.match(result.stderr, /Nothing was stopped\. Nothing has been changed\./);
        assert.deepEqual(siteFiles(), []);
        assert.ok(
            !compose.some((args) => args[0] === 'up' || args[0] === 'down'),
            'Compose was asked to change something',
        );
    });

    test('an explicit --port a container publishes is refused, not moved', async () => {
        h.daemon.containers = [
            {
                Id: 'o',
                Names: ['/other-site-ghost-1'],
                Ports: [{ PrivatePort: 2368, PublicPort: 2400, Type: 'tcp' }],
            },
        ];
        const result = await install('--local', '--port', '2400');
        assert.match(
            result.stderr,
            /port 2400 is already in use by the Docker container other-site-ghost-1\n.*--port/,
        );
    });

    const stoppedSite = () => {
        h.daemon.containers = [
            {
                Id: 'a',
                Names: ['/ghost-local-a-ghost-1'],
                State: 'exited',
                Labels: { 'org.ghost.docker.managed': 'true' },
                Ports: [],
                HostConfig: {
                    PortBindings: { '2368/tcp': [{ HostIp: '127.0.0.1', HostPort: '2368' }] },
                },
            },
            // Anything else that is stopped is not looked into.
            { Id: 'x', Names: ['/something-else'], State: 'exited', Labels: {}, Ports: [] },
        ];
    };

    test('a chosen port skips the port of a stopped site', async () => {
        stoppedSite();
        const result = await install('--local', '--no-start');
        assert.equal(result.code, 0, result.stderr);
        assert.equal(env.get(readFileSync(join(h.dir, '.env'), 'utf8'), 'GHOST_PORT'), '2369');
    });

    test('an explicit --port a stopped site takes is refused, saying it is stopped', async () => {
        stoppedSite();
        const result = await install('--local', '--port', '2368');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /port 2368 is already taken by the Docker container ghost-local-a-ghost-1, which is stopped and publishes it when it starts/,
        );
        assert.deepEqual(siteFiles(), []);
    });

    test('an explicit --port a host process holds is refused where Docker would publish over it', async () => {
        h.daemon.hostPorts = [2368];
        const result = await install('--local', '--port', '2368', '--no-start');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /port 2368 is already in use on this host by something outside Docker.*\n.*ghost ls[\s\S]*--port/,
        );
        assert.deepEqual(siteFiles(), []);
    });

    test('a chosen port skips those a host process holds', async () => {
        h.daemon.hostPorts = [2368, 2369];
        assert.equal((await install('--local', '--no-start')).code, 0);
        assert.equal(env.get(readFileSync(join(h.dir, '.env'), 'utf8'), 'GHOST_PORT'), '2370');
    });

    test('where the host cannot be asked (a Linux engine), the default port is taken as free', async () => {
        h.daemon.hostPorts = null;
        assert.equal((await install('--local', '--no-start')).code, 0);
        assert.equal(env.get(readFileSync(join(h.dir, '.env'), 'utf8'), 'GHOST_PORT'), '2368');
    });

    test('existing Mailpit data is never installed over either', async () => {
        mkdirSync(join(h.dir, 'data', 'mailpit'), { recursive: true });
        writeFileSync(join(h.dir, 'data', 'mailpit', 'mailpit.db'), '');
        const result = await install('--local', '--with', 'mailpit');
        assert.match(result.stderr, /data\/mailpit is not empty/);
    });

    test("Mailpit's port skips those a container publishes, a host process holds, and Ghost's", async () => {
        h.daemon.containers = [
            {
                Id: 'o',
                Names: ['/other-mailpit-1'],
                Ports: [{ PrivatePort: 8025, PublicPort: 8025, Type: 'tcp' }],
            },
        ];
        h.daemon.hostPorts = [8026];
        const result = await install(
            '--local',
            '--port',
            '8027',
            '--with',
            'mailpit',
            '--no-start',
        );
        assert.equal(result.code, 0, result.stderr);
        const values = env.toRecord(readFileSync(join(h.dir, '.env'), 'utf8'));
        assert.equal(values.GHOST_PORT, '8027');
        assert.equal(values.MAILPIT_PORT, '8028');
    });

    test('a failed preflight changes nothing', async () => {
        h.daemon.info = { ServerVersion: '24.0.0', OSType: 'linux', Architecture: 'x86_64' };
        const result = await install('--local');
        assert.equal(result.code, 1);
        assert.match(result.stderr, /preflight failed\. Nothing has been changed/);
        assert.deepEqual(siteFiles(), []);
    });

    test('a Ghost version that cannot be resolved changes nothing', async () => {
        const api = h.daemon.api!;
        h.daemon.api = (request) =>
            request.path === '/images/create'
                ? json(404, { message: 'manifest unknown' })
                : api(request);
        const result = await install('--local', '--version', '0.0.1');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /ghost:0\.0\.1-next-alpine could not be pulled: manifest unknown/,
        );
        assert.deepEqual(siteFiles(), []);
    });
});

describe('a local site, not started', () => {
    beforeEach(async () => {
        h.daemon.containers = [
            {
                Id: 'o',
                Names: ['/other'],
                Ports: [{ PrivatePort: 2368, PublicPort: 2368, Type: 'tcp' }],
            },
        ];
        const result = await install('--local', '--no-start');
        assert.equal(result.code, 0, result.stderr);
    });

    test('the default port skips one a container publishes', () => {
        assert.equal(env.get(readFileSync(join(h.dir, '.env'), 'utf8'), 'GHOST_PORT'), '2369');
    });

    test('.env holds the exact pin, the image layout and generated credentials, privately', () => {
        const values = env.toRecord(readFileSync(join(h.dir, '.env'), 'utf8'));
        assert.equal(values.GHOST_IMAGE_REF, REFERENCE);
        assert.equal(values.GHOST_VERSION, '6-next-alpine');
        assert.equal(values.GHOST_TINYBIRD_PATH, '/home/ghost/core/server/data/tinybird');
        assert.equal(values.COMPOSE_PROFILES, 'local');
        assert.equal(values.PROJECT_DIR, h.dir);
        assert.equal(values.RESTART_POLICY, 'no');
        assert.match(values.DATABASE_PASSWORD!, /^[0-9a-f]{48}$/);
        assert.notEqual(values.DATABASE_PASSWORD, values.DATABASE_ROOT_PASSWORD);
        for (const file of ['.env', 'ghost.env', '.ghost-docker.json']) {
            assert.equal(statSync(join(h.dir, file)).mode & 0o777, 0o600, file);
        }
    });

    test('the payload is written with its checksums, and the launcher pinned', () => {
        const metadata = JSON.parse(readFileSync(join(h.dir, '.ghost-docker.json'), 'utf8'));
        assert.equal(metadata.source, 'image');
        assert.equal(metadata.ghost.digest, INDEX);
        assert.ok(
            metadata.payload['compose.yml'] &&
                metadata.payload['caddy/Caddyfile'] &&
                metadata.payload['ghost-docker'],
        );
        assert.equal(
            readFileSync(join(h.dir, 'compose.yml'), 'utf8'),
            readFileSync(join(REPO, 'compose.yml'), 'utf8'),
        );
        const launcher = readFileSync(join(h.dir, 'ghost-docker'), 'utf8');
        assert.match(
            launcher,
            new RegExp(`^readonly GD_PINNED_IMAGE="sha256:${'2'.repeat(64)}"$`, 'm'),
        );
        assert.equal(statSync(join(h.dir, 'ghost-docker')).mode & 0o777, 0o755);
        assert.equal(
            statSync(join(h.dir, 'mysql-init', 'create-multiple-databases.sh')).mode & 0o111,
            statSync(join(REPO, 'mysql-init', 'create-multiple-databases.sh')).mode & 0o111,
        );
    });

    test('each silent wait had a spinner, and nothing was started behind one', () => {
        assert.deepEqual(h.spun, [
            'Checking Docker and the site directory',
            'Resolving the Ghost image',
            'Resolving the manager image',
            'Validating the configuration',
        ]);
    });

    test('nothing was started', () => {
        assert.ok(!compose.some((args) => args[0] === 'up' || args[0] === 'run'));
    });
});

describe('a local site with Mailpit, not started', () => {
    let result: Awaited<ReturnType<typeof install>>;
    beforeEach(async () => {
        result = await install('--local', '--with', 'mailpit', '--no-start');
        assert.equal(result.code, 0, result.stderr);
    });

    test('.env selects it and publishes its inbox on a port of its own', () => {
        const values = env.toRecord(readFileSync(join(h.dir, '.env'), 'utf8'));
        assert.equal(values.COMPOSE_PROFILES, 'local,mailpit');
        assert.equal(values.GHOST_PORT, '2368');
        assert.equal(values.MAILPIT_PORT, '8025');
    });

    test('ghost.env sends mail to it by its unique alias, and nothing else is added', () => {
        const values = env.toRecord(readFileSync(join(h.dir, 'ghost.env'), 'utf8'));
        const project = env.get(readFileSync(join(h.dir, '.env'), 'utf8'), 'COMPOSE_PROJECT_NAME');
        assert.deepEqual(values, {
            mail__transport: 'SMTP',
            mail__options__host: `mailpit-${project}`,
            mail__options__port: '1025',
            mail__options__secure: 'false',
        });
    });

    test('its inbox has a data directory, and the summary says where it is', () => {
        assert.ok(statSync(join(h.dir, 'data', 'mailpit')).isDirectory());
        assert.match(result.stdout, /data\/ghost, data\/mysql and data\/mailpit/);
        assert.match(result.stdout, /Mailpit +http:\/\/127\.0\.0\.1:8025/);
        const metadata = JSON.parse(readFileSync(join(h.dir, '.ghost-docker.json'), 'utf8'));
        assert.deepEqual(metadata.profiles, ['local', 'mailpit']);
    });
});

describe('a production site, not started', () => {
    test('its routes are written once, with the ACME account, and nothing is run to do it', async () => {
        const result = await install(
            '--domain',
            'example.com',
            '--email',
            'ops@example.com',
            '--no-start',
        );
        assert.equal(result.code, 0, result.stderr);
        const routes = readFileSync(join(h.dir, 'caddy', 'sites', 'site.caddy'), 'utf8');
        assert.match(routes, /^example\.com \{$/m);
        assert.match(routes, /^\ttls ops@example\.com$/m);
        assert.match(routes, /reverse_proxy ghost-ghost-example-com:2368/);
        // The email lives in the routes, where changing it takes effect.
        assert.equal(env.get(readFileSync(join(h.dir, '.env'), 'utf8'), 'ACME_EMAIL'), undefined);
        assert.ok(!compose.some((args) => args[0] === 'run' || args[0] === 'up'));
    });
});

describe('a failed start', () => {
    test('a busy port names itself and --port, and everything created is removed', async () => {
        up = () =>
            failed(
                1,
                ' Container ghost-local-x-ghost-1  Starting\nError response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint ghost-local-x-ghost-1: Bind for 127.0.0.1:2368 failed: port is already allocated',
            );
        const result = await install('--local');
        assert.equal(result.code, 1);
        // Docker's own words, which name the port, and what to do about it.
        assert.match(result.stderr, /Bind for 127\.0\.0\.1:2368 failed: port is already allocated/);
        assert.match(result.stderr, /choose another for Ghost with --port/);
        assert.match(result.stderr, /Nothing that was already running was stopped/);
        assert.match(result.stderr, /is as it was before/);
        assert.deepEqual(siteFiles(), []);
        assert.ok(
            compose.some((args) => args[0] === 'down' && args.includes('--volumes')),
            'the project was not taken down',
        );
        // The start, then the clean-up after it, each behind its own spinner.
        assert.deepEqual(h.spun.slice(-3), [
            'Pulling images, starting the services and waiting for them to be healthy',
            "Reading the services' logs",
            'Removing what the installation created',
        ]);
    });

    test('a service that never becomes healthy is removed the same way', async () => {
        up = () => failed(1, 'container ghost-local-x-ghost-1 is unhealthy');
        const result = await install('--local');
        assert.equal(result.code, 1);
        assert.match(result.stderr, /did not start and become healthy[\s\S]*is unhealthy/);
        assert.deepEqual(siteFiles(), []);
    });
});

describe('the pieces', () => {
    test('a production identity comes from the domain, a local one from the directory', () => {
        assert.equal(projectName('production', 'Example.COM', '/x'), 'ghost-example-com');
        assert.equal(
            projectName('production', 'blog.my-site.co.uk', '/x'),
            'ghost-blog-my-site-co-uk',
        );
        assert.equal(projectName('local', '', '/home/me/My Site'), 'ghost-local-my-site');
        assert.equal(projectName('local', '', '/home/me/---'), 'ghost-local-site');
        assert.notEqual(
            projectName('local', '', '/a/site-a'),
            projectName('local', '', '/a/site-b'),
        );
        assert.equal(slug('  A__b--C  '), 'a-b-c');
    });

    test('secrets are long, random and free of dotenv metacharacters', () => {
        const values = new Set(Array.from({ length: 20 }, secret));
        assert.equal(values.size, 20);
        for (const value of values) {
            assert.match(value, /^[0-9a-f]{48}$/);
        }
    });

    test('ports are chosen above the default, skipping taken ones', () => {
        assert.equal(choosePort(new Set()), 2368);
        assert.equal(choosePort(new Set([2368, 2369, 2371])), 2370);
    });

    test('a bare version selects the default variant; a tag is taken as given', () => {
        assert.equal(ghostTag(undefined), '6-next-alpine');
        assert.equal(ghostTag('6.3.1'), '6.3.1-next-alpine');
        assert.equal(ghostTag('v6'), '6-next-alpine');
        assert.equal(ghostTag('6-alpine'), '6-alpine');
    });

    test('the channel comes from the version the image carries', () => {
        assert.equal(channelOf('v1.2.3'), 'stable');
        assert.equal(channelOf('v1.2.3-beta.4'), 'beta');
        assert.equal(channelOf('edge-abc1234'), 'edge');
        assert.equal(channelOf('dev'), null);
    });
});
