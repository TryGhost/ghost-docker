// Migration 0001-compose-profiles: what it makes of the released main
// layout's Caddyfile and `.env`. What Caddy and Compose make of the result is
// tests/e2e/migrate-main.sh.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
    translateCaddyfile,
    UntranslatableCaddyfile,
    type LegacyCaddyValues,
} from '../src/legacy/caddy.ts';
import { readLegacyEnv, refuseInterpolated, splitLegacyEnv } from '../src/legacy/config.ts';
import { REPO } from './site.ts';

const MAIN = join(REPO, 'tests', 'fixtures', 'released-main');
const EXAMPLE = readFileSync(join(MAIN, 'caddy', 'Caddyfile.example'), 'utf8');

const VALUES: LegacyCaddyValues = {
    project: 'ghost-docker',
    domain: 'example.com',
    adminDomain: '',
    activitypub: 'https://ap.ghost.org',
};
const translate = (text: string, values: Partial<LegacyCaddyValues> = {}) =>
    translateCaddyfile(text, { ...VALUES, ...values });

/** The lines that are not comments: what Caddy loads. */
const code = (text: string) =>
    text
        .split('\n')
        .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
        .join('\n');

/** Uncomment the example's block that starts with `first`. */
function uncomment(text: string, first: string): string {
    const lines = text.split('\n');
    let inside = false;
    return lines
        .map((line) => {
            if (line.startsWith(`# ${first}`)) {
                inside = true;
            }
            if (inside && /^#( |$)/.test(line)) {
                const uncommented = line.replace(/^# ?/, '');
                if (uncommented === '}') {
                    inside = false;
                }
                return uncommented;
            }
            return line;
        })
        .join('\n');
}

describe('the Caddyfile', () => {
    test('the example, as most sites have it, becomes routes with arguments and aliases', () => {
        const { site, global, changes } = translate(EXAMPLE);
        const loaded = code(site);
        assert.match(loaded, /^example\.com \{$/m);
        assert.match(loaded, /^\timport \/etc\/caddy\/snippets\/Logging$/m);
        assert.match(
            loaded,
            /^\timport \/etc\/caddy\/snippets\/TrafficAnalytics traffic-analytics-ghost-docker:3000$/m,
        );
        assert.match(
            loaded,
            /^\timport \/etc\/caddy\/snippets\/ActivityPub https:\/\/ap\.ghost\.org$/m,
        );
        assert.match(loaded, /^\timport \/etc\/caddy\/snippets\/SecurityHeaders ""$/m);
        assert.match(loaded, /^\t\treverse_proxy ghost-ghost-docker:2368$/m);
        assert.doesNotMatch(loaded, /\{\$|import snippets\/|ghost:2368/);
        assert.equal(global, null);
        assert.ok(changes.length > 0);
    });

    test("the admin domain's block is filled in, and may frame the site", () => {
        const { site } = translate(uncomment(EXAMPLE, '{$ADMIN_DOMAIN}'), {
            adminDomain: 'admin.example.com',
        });
        assert.match(code(site), /^admin\.example\.com \{$/m);
        assert.equal(code(site).match(/SecurityHeaders "admin\.example\.com"/g)?.length, 2);
    });

    test('an admin block with no ADMIN_DOMAIN is refused, not turned into global options', () => {
        assert.throws(
            () => translate(uncomment(EXAMPLE, '{$ADMIN_DOMAIN}')),
            (error) =>
                error instanceof UntranslatableCaddyfile && /empty address/.test(error.message),
        );
    });

    test('the www redirect keeps redirecting to the domain', () => {
        const { site } = translate(uncomment(EXAMPLE, 'www.{$DOMAIN}'));
        assert.match(code(site), /^www\.example\.com \{$/m);
        assert.match(code(site), /^\tredir https:\/\/example\.com\{uri\}$/m);
    });

    test("the site's own ActivityPub is addressed by its alias", () => {
        const { site } = translate(EXAMPLE, { activitypub: 'activitypub-ghost-docker:8080' });
        assert.match(code(site), /snippets\/ActivityPub activitypub-ghost-docker:8080$/m);
        // Written straight into a route, the bare name is rewritten too.
        const direct = translate('example.com {\n\treverse_proxy http://activitypub:8080\n}\n');
        assert.match(direct.site, /reverse_proxy http:\/\/activitypub-ghost-docker:8080/);
    });

    test('custom routes are kept as written', () => {
        const custom = EXAMPLE.replace(
            '\t# Default proxy everything else to Ghost',
            '\tredir /old /new 301\n\thandle /status {\n\t\trespond "ok"\n\t}\n\n\t# Default proxy everything else to Ghost',
        ).concat('\nstatus.example.com {\n\treverse_proxy 172.17.0.1:9000\n}\n');
        const { site } = translate(custom);
        assert.match(site, /^\tredir \/old \/new 301$/m);
        assert.match(site, /^\thandle \/status \{\n\t\trespond "ok"\n\t\}$/m);
        assert.match(site, /^status\.example\.com \{\n\treverse_proxy 172\.17\.0\.1:9000\n\}$/m);
    });

    test('a global options block moves to caddy/global, one level shallower', () => {
        const { site, global } = translate(`{\n\temail ops@example.com\n\tdebug\n}\n\n${EXAMPLE}`);
        assert.equal(
            global,
            '# Global options carried over from caddy/Caddyfile.\nemail ops@example.com\ndebug\n',
        );
        assert.doesNotMatch(code(site), /email ops/);
        assert.match(code(site), /^example\.com \{$/m);
    });

    test('named snippets stay named; other relative imports become absolute', () => {
        const { site } = translate(
            '(common) {\n\tencode gzip\n}\n\nexample.com {\n\timport common\n\timport extra/*.caddy\n\treverse_proxy ghost:2368\n}\n',
        );
        assert.match(site, /^\timport common$/m);
        assert.match(site, /^\timport \/etc\/caddy\/extra\/\*\.caddy$/m);
    });

    test('runtime placeholders and other variables are left alone', () => {
        const { site } = translate(
            'example.com {\n\theader X-Host {env.DOMAIN}\n\theader X-Other {$OTHER} {uri}\n}\n',
        );
        assert.match(site, /X-Host example\.com$/m);
        assert.match(site, /X-Other \{\$OTHER\} \{uri\}$/m);
    });

    test('a snippet imported with arguments it never took is refused', () => {
        assert.throws(
            () => translate('example.com {\n\timport snippets/Logging verbose\n}\n'),
            UntranslatableCaddyfile,
        );
    });

    test('unbalanced braces are refused', () => {
        assert.throws(() => translate('example.com {\n\trespond ok\n'), UntranslatableCaddyfile);
        assert.throws(() => translate('}\n'), UntranslatableCaddyfile);
    });

    test('comments are kept as they were', () => {
        const { site } = translate(EXAMPLE);
        assert.match(site, /^# \{\$ADMIN_DOMAIN\} \{$/m);
        assert.match(site, /^\t# Optional: Enable gzip compression$/m);
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
