// Migration 0001-compose-profiles: what it makes of the released main
// layout's Caddyfile and `.env`. What Caddy and Compose make of the result is
// tests/e2e/migrate-main.sh.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { carryCaddyfile, fillEnvironment, type LegacyCaddyValues } from '../src/legacy/caddy.ts';
import { readLegacyEnv, refuseInterpolated, splitLegacyEnv } from '../src/legacy/config.ts';
import { releasedMain } from './site.ts';

const MAIN = releasedMain();
const EXAMPLE = readFileSync(join(MAIN, 'caddy', 'Caddyfile.example'), 'utf8');

const VALUES: LegacyCaddyValues = {
    domain: 'example.com',
    adminDomain: '',
    activitypub: 'https://ap.ghost.org',
};
const carry = (text: string, values: Partial<LegacyCaddyValues> = {}) =>
    carryCaddyfile(text, { ...VALUES, ...values });

/** The lines that are not comments: what Caddy loads. */
const code = (text: string) =>
    text
        .split('\n')
        .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
        .join('\n');

describe('the Caddyfile', () => {
    test('the example is carried as written, with its variables filled in and its snippets kept', () => {
        const { site, global } = carry(EXAMPLE);
        const loaded = code(site);
        assert.match(loaded, /^example\.com \{$/m);
        for (const name of ['Logging', 'TrafficAnalytics', 'ActivityPub', 'SecurityHeaders']) {
            assert.match(
                loaded,
                new RegExp(`^\\timport /etc/caddy/sites/legacy-snippets/${name}$`, 'm'),
            );
        }
        // Bare upstreams resolve on the site's own network.
        assert.match(loaded, /^\t\treverse_proxy ghost:2368$/m);
        assert.doesNotMatch(loaded, /\{\$|import snippets\//);
        assert.equal(global, null);
        // Everything else, comments included, as it was.
        assert.equal(
            code(site),
            code(
                EXAMPLE.replaceAll('{$DOMAIN}', 'example.com').replace(
                    /import snippets\//g,
                    'import /etc/caddy/sites/legacy-snippets/',
                ),
            ),
        );
    });

    test("main's snippets get the same variables", () => {
        const headers = readFileSync(join(MAIN, 'caddy', 'snippets', 'SecurityHeaders'), 'utf8');
        assert.match(
            fillEnvironment(headers, { ...VALUES, adminDomain: 'admin.example.com' }),
            /frame-ancestors 'self' admin\.example\.com/,
        );
        assert.match(fillEnvironment(headers, VALUES), /frame-ancestors 'self' "/);
        const activitypub = readFileSync(join(MAIN, 'caddy', 'snippets', 'ActivityPub'), 'utf8');
        assert.match(
            fillEnvironment(activitypub, { ...VALUES, activitypub: 'activitypub:8080' }),
            /reverse_proxy activitypub:8080/,
        );
    });

    test('custom routes are kept as written', () => {
        const custom = `${EXAMPLE}\nstatus.example.com {\n\theader X-Host {env.DOMAIN}\n\theader X-Other {$OTHER}\n\treverse_proxy 172.17.0.1:9000\n}\n`;
        const { site } = carry(custom);
        assert.match(
            site,
            /^status\.example\.com \{\n\theader X-Host example\.com\n\theader X-Other \{\$OTHER\}\n\treverse_proxy 172\.17\.0\.1:9000\n\}$/m,
        );
    });

    test('a leading global options block moves to caddy/global, one level shallower', () => {
        const { site, global } = carry(
            `# mine\n{\n\temail ops@example.com\n\tdebug\n}\n\n${EXAMPLE}`,
        );
        assert.equal(
            global,
            '# Global options carried over from caddy/Caddyfile.\nemail ops@example.com\ndebug\n',
        );
        assert.doesNotMatch(code(site), /email ops/);
        assert.match(code(site), /^example\.com \{$/m);
    });
});

describe('the .env', () => {
    const OLD = [
        'COMPOSE_PROFILES=analytics',
        'DOMAIN=example.com',
        'ADMIN_DOMAIN=',
        'HTTP_PORT=80',
        'DATABASE_ROOT_PASSWORD=root',
        'DATABASE_PASSWORD=app',
        'TINYBIRD_ADMIN_TOKEN=p.token',
        'TINYBIRD_SYNC_AUTH=shared',
        'mail__transport=SMTP',
        'mail__options__auth__pass="p$$ss"',
        'mail__from="\'Acme\' <support@example.com>"',
        'url=https://ignored.example.com',
        'database__connection__host=elsewhere',
        'TZ=Europe/London',
        'GHOST_VERSION=6-alpine',
        '',
    ].join('\n');
    const OPERATOR = new Set([
        'DOMAIN',
        'ADMIN_DOMAIN',
        'HTTP_PORT',
        'DATABASE_ROOT_PASSWORD',
        'DATABASE_PASSWORD',
        'TINYBIRD_ADMIN_TOKEN',
        'TINYBIRD_SYNC_AUTH',
        'GHOST_VERSION',
    ]);
    const split = (interpolated: string[] = []) =>
        splitLegacyEnv({
            legacy: readLegacyEnv(OLD),
            generated: new Set([
                'COMPOSE_PROFILES',
                'HTTP_PORT',
                'DATABASE_ROOT_PASSWORD',
                'DATABASE_PASSWORD',
                'GHOST_VERSION',
            ]),
            isOperatorKey: (key) => key.startsWith('COMPOSE_') || OPERATOR.has(key),
            isInterpolated: (key) => interpolated.includes(key),
            container: new Set(['url', 'admin__url', 'NODE_ENV']),
            received: { mail__options__auth__pass: 'p$ss', mail__transport: 'SMTP' },
        });

    test("Ghost's configuration moves to ghost.env, operator settings stay", () => {
        const { operator, ghost, dropped } = split();
        assert.deepEqual(operator, [
            ['TINYBIRD_ADMIN_TOKEN', 'p.token'],
            ['TINYBIRD_SYNC_AUTH', 'shared'],
        ]);
        assert.deepEqual(ghost, [
            ['mail__transport', 'SMTP'],
            ['mail__options__auth__pass', 'p$ss'],
            ['mail__from', "'Acme' <support@example.com>"],
            // Everything in .env reached Ghost on main, so a setting of the
            // container's own goes with it.
            ['TZ', 'Europe/London'],
        ]);
        assert.deepEqual(
            dropped.map(({ key }) => key),
            ['DOMAIN', 'ADMIN_DOMAIN', 'url', 'database__connection__host'],
        );
    });

    test('DOMAIN stays when an override still uses it', () => {
        const { operator, dropped } = split(['DOMAIN']);
        assert.deepEqual(operator[0], ['DOMAIN', 'example.com']);
        assert.ok(!dropped.some(({ key }) => key === 'DOMAIN'));
    });

    test('ghost.env gets what Ghost received, which Compose interpolated', () => {
        const { ghost } = split();
        assert.deepEqual(
            ghost.find(([key]) => key === 'mail__options__auth__pass'),
            ['mail__options__auth__pass', 'p$ss'],
        );
    });

    test('an operator value Compose would interpolate is refused', () => {
        assert.throws(
            () => refuseInterpolated('DATABASE_PASSWORD=pa$word\n', new Set(['DATABASE_PASSWORD'])),
            /unescaped \$ \(DATABASE_PASSWORD\)/,
        );
        // Ghost's own are carried as Ghost received them.
        refuseInterpolated('mail__options__auth__pass=pa$word\n', new Set());
    });

    test('a value spanning lines is refused rather than dropped', () => {
        assert.throws(() => readLegacyEnv('KEY="one\ntwo"\n'), /KEY/);
    });
});
