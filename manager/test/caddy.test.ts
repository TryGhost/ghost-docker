// Caddy routes, as install writes them. Caddy itself loads them in
// tests/e2e/install.sh.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fill, renderRoutes, type RouteOptions } from '../src/caddy.ts';
import { harness } from './helpers.ts';

const SITE: RouteOptions = {
    project: 'ghost-example-com',
    domain: 'example.com',
    adminDomain: '',
    email: '',
    activitypub: false,
};
const render = (overrides: Partial<RouteOptions> = {}) => renderRoutes({ ...SITE, ...overrides });

describe('rendering', () => {
    test('a plain production site', () => {
        const routes = render();
        assert.match(routes, /^example\.com \{$/m);
        assert.match(routes, /reverse_proxy ghost-ghost-example-com:2368/);
        // The bare service name is never used for addressing.
        assert.doesNotMatch(routes, /reverse_proxy ghost:2368/);
        assert.match(routes, /import \/etc\/caddy\/snippets\/SecurityHeaders ""/);
        assert.match(routes, /import \/etc\/caddy\/snippets\/ActivityPub https:\/\/ap\.ghost\.org/);
        assert.match(routes, /^\t# tls you@example\.com$/m);
        assert.doesNotMatch(routes, /^\ttls /m);
        assert.doesNotMatch(routes, /\{\{|\$\{|\{args\[/);
        assert.match(routes, /This file is\n# yours: edit it, then reload Caddy/);
    });

    test("ActivityPub points at this site's own service when it has one", () => {
        assert.match(
            render({ activitypub: true }),
            /import \/etc\/caddy\/snippets\/ActivityPub activitypub-ghost-example-com:8080/,
        );
    });

    test('an admin domain is served by the same block, and may frame the site', () => {
        const routes = render({ adminDomain: 'admin.example.com' });
        assert.match(routes, /^example\.com, admin\.example\.com \{$/m);
        assert.match(routes, /SecurityHeaders "admin\.example\.com"/);
    });

    test('--email is the ACME account, and only when given', () => {
        assert.match(render({ email: 'ops@example.com' }), /^\ttls ops@example\.com$/m);
    });

    test('a placeholder with no value is an error, not an empty string', () => {
        assert.equal(fill('{{a}} {{b}}', { a: '1', b: '' }), '1 ');
        assert.throws(() => fill('{{missing}}', {}), /\{\{missing\}\}/);
    });
});

test('there is no caddy command: the routes are the operator’s after install', async () => {
    const h = harness();
    try {
        assert.equal((await h.run('caddy', 'apply')).code, 2);
        assert.equal((await h.run('config', 'unset', 'ghost.env', 'a')).code, 2);
    } finally {
        h.cleanup();
    }
});
