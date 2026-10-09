// `self-update` in an installation of the released main layout: migration
// 0001-compose-profiles, against a scripted daemon, Compose and git. What it
// does on a real host is tests/e2e/migrate-main.sh; this is what it decides.
import assert from 'node:assert/strict';
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import * as env from '../src/env.ts';
import { failed, harness, json, ok, type Harness, type ProgramResult } from './helpers.ts';
import {
    imageApi,
    imageStack,
    REFERENCE,
    releasedMain,
    REPO,
    resolvedProject,
    scriptSite,
    writeSiteData,
    type ScriptedSite,
} from './site.ts';

const MAIN = releasedMain();
/** The Ghost-CLI-layout image main's site runs. */
const OLD_GHOST = `sha256:${'5'.repeat(64)}`;
const CADDY = `caddy:2.10.2-alpine@sha256:${'6'.repeat(64)}`;
const DB = `mysql:8.0.44@sha256:${'4'.repeat(64)}`;

const OLD_ENV = [
    '# Use the below flags to enable the Analytics or ActivityPub containers as well',
    'COMPOSE_PROFILES=activitypub',
    'DOMAIN=example.com',
    'HTTP_PORT=80',
    'HTTPS_PORT=443',
    'DATABASE_ROOT_PASSWORD=reallysecurerootpassword',
    'DATABASE_PASSWORD=ghostpassword',
    'ACTIVITYPUB_TARGET=activitypub:8080',
    'mail__transport=SMTP',
    'mail__options__host=smtp.example.com',
    'mail__options__auth__pass="pa$$word"',
    'mail__from="\'Acme Support\' <support@example.com>"',
    'labs__publicAPI=true',
    'UPLOAD_LOCATION=./data/ghost',
    'MYSQL_DATA_LOCATION=./data/mysql',
    '',
].join('\n');

let h: Harness;
let site: ScriptedSite;
let project: string;
/** Files git says the operator changed, and files only local commits changed. */
let edited: string[];
let committed: string[];
/** What `caddy validate` answers. */
let caddyValidates: { status: number; stderr?: string };
const validated: string[] = [];

const readSite = (file: string) => readFileSync(join(h.dir, file), 'utf8');
const envOf = (file: string) => env.toRecord(readSite(file));
const migrate = (...args: string[]) => h.run('self-update', ...args);

/** Every file outside the data, to compare before and after. */
function files(dir = h.dir, prefix = ''): Record<string, string> {
    const found: Record<string, string> = {};
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (prefix === '' && ['data', 'backups'].includes(entry.name)) {
            continue;
        }
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            Object.assign(found, files(path, `${prefix}${entry.name}/`));
        } else {
            found[`${prefix}${entry.name}`] = readFileSync(path, 'utf8');
        }
    }
    return found;
}

/** `docker compose config`: main's layout with the site's `.env`, or this one's with a staged one. */
function config(_args: string[], envFile?: string): ProgramResult {
    const values = env.toRecord(readFileSync(envFile ?? join(h.dir, '.env'), 'utf8'));
    const legacy = values.URL === undefined;
    const environment: Record<string, string> = legacy
        ? // main's env_file is the whole of .env.
          { ...values, url: `https://${values.DOMAIN}`, NODE_ENV: 'production' }
        : {
              ...env.toRecord(existsSync(join(h.dir, 'ghost.env')) ? readSite('ghost.env') : ''),
              NODE_ENV: 'production',
              url: values.URL!,
              admin__url: values.ADMIN_URL ?? '',
              server__host: '0.0.0.0',
              server__port: '2368',
              paths__contentPath: values.GHOST_CONTENT_PATH ?? '',
              database__client: 'mysql',
          };
    const resolved = JSON.parse(
        resolvedProject(
            h.dir,
            { ghost: legacy ? 'ghost:6-alpine' : values.GHOST_IMAGE_REF!, db: DB, caddy: CADDY },
            {},
            envFile,
        ),
    );
    resolved.services.ghost.environment = Object.fromEntries(
        Object.entries(environment).map(([key, value]) => [key, value.replaceAll('$', '$$')]),
    );
    if (legacy) {
        resolved.services.ghost.volumes[0].target = '/var/lib/ghost/content';
    }
    return ok(JSON.stringify(resolved));
}

beforeEach(() => {
    h = harness();
    imageStack(h);
    h.env.GD_VERSION_FILE = join(h.dir, '..', `${basename(h.dir)}-version.json`);
    writeFileSync(
        h.env.GD_VERSION_FILE,
        JSON.stringify({ version: 'v0.2.0', commit: 'c'.repeat(40) }),
    );
    h.env.GD_CHANNEL = 'stable';

    // A clone of main, set up as its README said.
    cpSync(MAIN, h.dir, { recursive: true });
    writeFileSync(join(h.dir, '.env'), OLD_ENV);
    cpSync(join(MAIN, 'caddy', 'Caddyfile.example'), join(h.dir, 'caddy', 'Caddyfile'));
    writeSiteData(h.dir);
    project = basename(h.dir);
    edited = [];
    committed = [];
    caddyValidates = { status: 0 };
    validated.length = 0;

    const images = imageApi({ ghost: { '6.67.0-next-alpine': '6.67.0' } });
    h.daemon.api = (request) => {
        if (
            request.method === 'GET' &&
            decodeURIComponent(request.path) === `/images/${OLD_GHOST}/json`
        ) {
            return json(200, {
                Id: OLD_GHOST,
                RepoDigests: [`ghost@sha256:${'7'.repeat(64)}`],
                Config: {
                    Env: [
                        'GHOST_VERSION=6.67.0',
                        'GHOST_INSTALL=/var/lib/ghost',
                        'GHOST_CONTENT=/var/lib/ghost/content',
                        'GHOST_CLI_INSTALL=/usr/local/lib/ghost-cli',
                    ],
                },
            });
        }
        return images(request);
    };
    const container = (service: string, image: string, imageId: string) => ({
        Id: `${service}-id`,
        Names: [`/${project}-${service}-1`],
        Image: image,
        ImageID: imageId,
        State: 'running',
        Status: 'Up',
        Labels: {
            'com.docker.compose.project': project,
            'com.docker.compose.project.working_dir': h.dir,
            'com.docker.compose.service': service,
        },
    });
    h.daemon.containers = [
        container('ghost', 'ghost:6-alpine', OLD_GHOST),
        container('db', DB, `sha256:${'4'.repeat(64)}`),
        container('caddy', CADDY, `sha256:${'6'.repeat(64)}`),
    ];
    h.daemon.gitRun = (args) => {
        const command = args[args.indexOf(h.dir) + 1];
        const paths = args.slice(args.indexOf('--') + 1);
        switch (command) {
            case 'rev-parse':
                return ok(`${h.dir}\n`);
            case 'ls-files':
                return ok(paths.filter((path) => existsSync(join(MAIN, path))).join('\n'));
            case 'status':
                return ok(edited.map((file) => ` M ${file}\n`).join(''));
            case 'for-each-ref':
                return ok('refs/remotes/origin/main\n');
            case 'log':
                return ok(committed.join('\n'));
            default:
                return failed(1, `unexpected: git ${args.join(' ')}`);
        }
    };

    site = scriptSite(h, config, { ghost: REFERENCE, db: DB, caddy: CADDY });
    site.running.add('ghost').add('db').add('caddy');
    site.onUp = () => site.running.add('caddy');
    const scripted = h.daemon.run!;
    h.daemon.run = (spec) => {
        if (spec.entrypoint[0] === 'caddy') {
            const caddy = spec.binds[0]!.split(':')[0]!;
            validated.push(readFileSync(join(caddy, 'sites', 'site.caddy'), 'utf8'));
            return caddyValidates;
        }
        return scripted(spec);
    };
});
afterEach(() => h.cleanup());

describe('migrating the released main layout', () => {
    test('moves the site onto this layout, keeping its project, credentials and Ghost', async () => {
        const result = await migrate();
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /migration 0001-compose-profiles/);

        const settings = envOf('.env');
        assert.equal(settings.COMPOSE_PROFILES, 'production,activitypub');
        assert.equal(settings.SITE_MODE, 'production');
        assert.equal(settings.COMPOSE_PROJECT_NAME, project);
        assert.equal(settings.PROJECT_DIR, h.dir);
        assert.equal(settings.URL, 'https://example.com');
        assert.equal(settings.GHOST_IMAGE_REF, REFERENCE);
        assert.equal(settings.GHOST_VERSION, '6.67.0-next-alpine');
        assert.equal(settings.DATABASE_PASSWORD, 'ghostpassword');
        assert.equal(settings.DATABASE_ROOT_PASSWORD, 'reallysecurerootpassword');
        for (const key of ['DOMAIN', 'ACTIVITYPUB_TARGET', 'mail__transport']) {
            assert.equal(settings[key], undefined, key);
        }

        const ghost = envOf('ghost.env');
        assert.equal(ghost.mail__transport, 'SMTP');
        assert.equal(ghost.mail__options__auth__pass, 'pa$word');
        assert.equal(ghost.labs__publicAPI, 'true');
        assert.equal(ghost.DATABASE_PASSWORD, undefined);

        const routes = readSite('caddy/sites/site.caddy');
        assert.match(routes, /^example\.com \{$/m);
        assert.match(routes, /^\timport \/etc\/caddy\/sites\/legacy-snippets\/ActivityPub$/m);
        assert.match(routes, /reverse_proxy ghost:2368$/m);
        assert.match(
            readSite('caddy/sites/legacy-snippets/ActivityPub'),
            /reverse_proxy activitypub:8080$/m,
        );
        assert.equal(
            readSite('caddy/Caddyfile.local'),
            readFileSync(join(MAIN, 'caddy', 'Caddyfile.example'), 'utf8'),
        );
        assert.equal(
            readSite('caddy/Caddyfile'),
            readFileSync(join(REPO, 'caddy', 'Caddyfile'), 'utf8'),
        );
        assert.equal(readSite('compose.yml'), readFileSync(join(REPO, 'compose.yml'), 'utf8'));
        assert.equal(validated.length, 1);

        const metadata = JSON.parse(readSite('.ghost-docker.json'));
        assert.equal(metadata.source, 'image');
        assert.equal(metadata.stack.version, 'v0.2.0');
        assert.equal(metadata.site.project, project);
        assert.equal(metadata.ghost.version, '6.67.0');
        assert.deepEqual(metadata.profiles, ['production', 'activitypub']);
        assert.ok('compose.yml' in metadata.payload && 'ghost-docker' in metadata.payload);
        assert.match(readSite('ghost-docker'), /^readonly GD_PINNED_IMAGE=".+"$/m);

        assert.equal(readdirSync(join(h.dir, 'backups')).length, 1);
        assert.ok(!existsSync(join(h.dir, '.ghost-docker-update')));
        assert.ok(!existsSync(join(h.dir, '.ghost-docker.lock')));
        assert.deepEqual([...site.running].sort(), ['caddy', 'db', 'ghost']);
    });

    test('ActivityPub stays where main sent it: the hosted service unless the target said otherwise', async () => {
        writeFileSync(
            join(h.dir, '.env'),
            OLD_ENV.replace('ACTIVITYPUB_TARGET=activitypub:8080\n', ''),
        );
        const result = await migrate();
        assert.equal(result.code, 0, result.stderr);
        assert.match(
            readSite('caddy/sites/legacy-snippets/ActivityPub'),
            /reverse_proxy https:\/\/ap\.ghost\.org$/m,
        );
        assert.equal(envOf('.env').COMPOSE_PROFILES, 'production,activitypub');
    });

    test('a second run is an ordinary self-update, and finds nothing to do', async () => {
        assert.equal((await migrate()).code, 0);
        const after = files();
        const again = await migrate();
        assert.equal(again.code, 0, again.stderr);
        assert.match(again.stdout, /already runs v0\.2\.0/);
        assert.deepEqual(files(), after);
    });

    test('--check says what it would do and changes nothing', async () => {
        const before = files();
        const result = await migrate('--check');
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /would move this site onto v0\.2\.0/);
        assert.match(result.stdout, /DOMAIN not carried/);
        assert.deepEqual(files(), before);
        assert.equal(site.compose.filter((args) => args[0] === 'stop').length, 0);
    });

    test('an edited stack file stops it before anything changes', async () => {
        edited = ['compose.yml'];
        committed = ['caddy/snippets/Logging'];
        const before = files();
        const result = await migrate();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /caddy\/snippets\/Logging\n\s+compose\.yml/);
        assert.match(result.stderr, /Nothing has been changed/);
        assert.deepEqual(files(), before);
    });

    test('Ghost below the first next image stops it, saying to upgrade Ghost first', async () => {
        const api = h.daemon.api!;
        h.daemon.api = (request) =>
            decodeURIComponent(request.path) === `/images/${OLD_GHOST}/json`
                ? json(200, {
                      Id: OLD_GHOST,
                      RepoDigests: [`ghost@sha256:${'7'.repeat(64)}`],
                      Config: { Env: ['GHOST_VERSION=6.40.0'] },
                  })
                : api(request);
        const before = files();
        const result = await migrate();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /runs Ghost 6\.40\.0.*start at Ghost 6\.61\.0/s);
        assert.deepEqual(files(), before);
    });

    test('routes Caddy will not load stop it before anything changes', async () => {
        caddyValidates = {
            status: 1,
            stderr: 'Error: adapting config: unknown directive: frobnicate',
        };
        const before = files();
        const result = await migrate();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /unknown directive: frobnicate/);
        assert.deepEqual(files(), before);
    });

    test('a failure before startup puts the files back and starts Ghost again', async () => {
        const before = files();
        // The checked backup fails: its dump does not load.
        const scripted = h.daemon.run!;
        h.daemon.run = (spec) =>
            spec.entrypoint[0] === 'sh'
                ? { status: 4, stderr: 'the dump of ghost does not load' }
                : scripted(spec);
        const result = await migrate();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /Restored: the site is on the released main layout again/);
        assert.deepEqual(files(), before);
        assert.ok(site.running.has('ghost'));
        assert.equal(
            site.compose.filter((args) => args[0] === 'up' && !args.includes('--no-recreate'))
                .length,
            0,
        );
    });

    test('a failure at startup stops the site, puts the files back and leaves the data', async () => {
        const before = files();
        site.ups.push(failed(1, 'container ghost is unhealthy'));
        const result = await migrate();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /The site needs you/);
        assert.match(result.stderr, /Nothing was loaded over them/);
        assert.match(result.stderr, /docker compose up -d/);
        assert.match(result.stderr, /restore --yes backups\//);
        // The snapshot stays for the operator; everything else is main's again.
        const after = files();
        assert.deepEqual(
            Object.fromEntries(
                Object.entries(after).filter(([path]) => !path.startsWith('.ghost-docker-update/')),
            ),
            before,
        );
        assert.equal(
            readFileSync(join(h.dir, 'data', 'ghost', 'images', 'photo.jpg'), 'utf8'),
            'jpeg',
        );
    });

    test('a site that is not running is refused: its Ghost version is unknown', async () => {
        h.daemon.containers = [];
        const result = await migrate();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /must be running/);
    });
});
