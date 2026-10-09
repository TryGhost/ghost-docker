// Verification: what each container's answer means.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ServiceUnreachable } from '../src/clients.ts';
import { readSettings, siteFacts } from '../src/site.ts';
import { verifyIngress } from '../src/verify.ts';
import { harness, ok, type Harness } from './helpers.ts';
import { LOCAL, makeSite, PRODUCTION } from './site.ts';

let h: Harness;
let site: { ghost: string; caddy: string; certificate: boolean; mailpit: string };
beforeEach(() => {
    h = harness();
    site = {
        ghost: 'healthy',
        caddy: 'healthy',
        certificate: false,
        mailpit: 'healthy',
    };
    // The one question asked directly, from the manager on the site network.
    h.daemon.certificate = () =>
        site.certificate
            ? { issuer: "Let's Encrypt", covers: true }
            : new ServiceUnreachable('tls', 'tlsv1 alert internal error');
    h.daemon.composeRun = (args) => {
        if (args[0] === 'ps') {
            return ok(
                [
                    {
                        Service: 'ghost',
                        State: 'running',
                        Health: site.ghost,
                        Publishers: [{ URL: '127.0.0.1', PublishedPort: 2368 }],
                    },
                    {
                        Service: 'caddy',
                        State: 'running',
                        Health: site.caddy,
                        Publishers: [{ URL: '0.0.0.0', PublishedPort: 80 }],
                    },
                    {
                        Service: 'mailpit',
                        State: 'running',
                        Health: site.mailpit,
                        Publishers: [{ URL: '127.0.0.1', PublishedPort: 8025 }],
                    },
                ]
                    .map((entry) => JSON.stringify(entry))
                    .join('\n'),
            );
        }
        return undefined;
    };
});
afterEach(() => h.cleanup());

const verify = async (values: Record<string, string>) => {
    makeSite(h, values);
    const checks = await verifyIngress(h.io(), siteFacts(h.dir, readSettings(h.dir)!));
    return Object.fromEntries(checks.map((check) => [check.label, check]));
};

describe('a production site', () => {
    test('before DNS: Ghost and Caddy healthy, HTTPS pending, ports reported', async () => {
        const checks = await verify(PRODUCTION);
        assert.match(checks.ghost!.detail, /^healthy: its Admin API answers inside the container/);
        assert.match(checks.caddy!.detail, /^healthy: its admin API answers/);
        assert.equal(checks.https!.status, 'note');
        assert.match(
            checks.https!.detail,
            /^pending: there is no certificate for example\.com yet/,
        );
        assert.match(
            checks['published ports']!.detail,
            /Ghost on 127\.0\.0\.1:2368 and Caddy on 0\.0\.0\.0:80/,
        );
    });

    test('with a certificate, HTTPS is serving and names the issuer', async () => {
        site.certificate = true;
        const checks = await verify(PRODUCTION);
        assert.equal(checks.https!.status, 'ok');
        assert.match(
            checks.https!.detail,
            /presents a certificate for example\.com from Let's Encrypt/,
        );
    });

    test('an unhealthy Ghost or Caddy is an error', async () => {
        site.caddy = 'starting';
        site.ghost = 'unhealthy';
        const checks = await verify(PRODUCTION);
        assert.equal(checks.caddy!.status, 'error');
        assert.match(checks.caddy!.detail, /not healthy \(running, starting\)/);
        assert.match(checks.ghost!.detail, /not healthy \(running, unhealthy\)/);
    });
});

test('a local site has no Caddy, and nothing to ask on its network', async () => {
    const checks = await verify(LOCAL);
    assert.deepEqual(Object.keys(checks), ['ghost', 'published ports']);
    assert.deepEqual(h.network.probes, []);
});

describe('a local site with Mailpit', () => {
    const MAILPIT = { ...LOCAL, COMPOSE_PROFILES: 'local,mailpit' };

    test('healthy by its own check, it names where Ghost sends mail, and its inbox port is reported', async () => {
        const checks = await verify(MAILPIT);
        assert.equal(checks.mailpit!.status, 'ok');
        assert.match(
            checks.mailpit!.detail,
            /^healthy: Ghost sends mail to mailpit-ghost-local-site:1025/,
        );
        assert.match(
            checks['published ports']!.detail,
            /Ghost on 127\.0\.0\.1:2368, and Mailpit's inbox on 127\.0\.0\.1:8025/,
        );
    });

    test('unhealthy, it is an error', async () => {
        site.mailpit = 'unhealthy';
        const checks = await verify(MAILPIT);
        assert.equal(checks.mailpit!.status, 'error');
        assert.match(checks.mailpit!.detail, /not healthy \(running, unhealthy\)/);
        assert.ok(!h.network.probes.some((probe) => probe.includes('mailpit')));
    });
});

test('a site network the manager cannot join makes HTTPS an error, never a pass', async () => {
    h.daemon.network = { refuse: 'the manager could not join the site network: permission denied' };
    const checks = await verify(PRODUCTION);
    assert.equal(checks.https!.status, 'error');
    assert.match(
        checks.https!.detail,
        /could not be asked on the site network: .*permission denied/,
    );
    assert.equal(checks.ghost!.status, 'ok');
    assert.equal(checks.caddy!.status, 'ok');
    assert.deepEqual(h.network.probes, []);
});
