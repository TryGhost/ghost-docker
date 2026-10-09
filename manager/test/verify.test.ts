// Verification: what each container's answer means.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ServiceUnreachable } from '../src/clients.ts';
import { readSettings, siteFacts } from '../src/site.ts';
import { verifyIngress } from '../src/verify.ts';
import { harness, ok, type Harness } from './helpers.ts';
import { LOCAL, makeSite, PRODUCTION } from './site.ts';

let h: Harness;
let site: { ghost: string; redirect: string; certificate: boolean; mailpit: string; smtp: string };
beforeEach(() => {
    h = harness();
    site = {
        ghost: 'healthy',
        redirect: '308 https://example.com/',
        certificate: false,
        mailpit: 'healthy',
        smtp: '220 a1b2c3 Mailpit ESMTP Service ready',
    };
    // Asked directly, from the manager on the site network.
    h.daemon.http = ({ port }) => {
        if (port === 2368) {
            return { status: 200, location: '' };
        }
        const [status = '0', location = ''] = site.redirect.split(' ');
        return { status: Number(status), location };
    };
    h.daemon.certificate = () =>
        site.certificate
            ? { issuer: "Let's Encrypt", covers: true }
            : new ServiceUnreachable('tls', 'tlsv1 alert internal error');
    h.daemon.greeting = () => (site.smtp.startsWith('220') ? site.smtp : new Error(site.smtp));
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
    test('before DNS: Ghost healthy, Caddy serving the name, HTTPS pending, ports reported', async () => {
        const checks = await verify(PRODUCTION);
        assert.equal(checks.ghost!.status, 'ok');
        assert.match(checks.caddy!.detail, /http:\/\/example\.com redirects to HTTPS/);
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

    test('a name Caddy does not serve, and an unhealthy Ghost, are errors', async () => {
        site.redirect = '200 ';
        site.ghost = 'unhealthy';
        const checks = await verify(PRODUCTION);
        assert.equal(checks.caddy!.status, 'error');
        assert.match(
            checks.caddy!.detail,
            /answered 200 .* not a redirect .* caddy\/sites\/site\.caddy/,
        );
        assert.match(checks.ghost!.detail, /not healthy \(running, unhealthy\)/);
    });
});

test('a local site has no Caddy to ask', async () => {
    const checks = await verify(LOCAL);
    assert.deepEqual(Object.keys(checks), ['ghost', 'published ports']);
});

describe('a local site with Mailpit', () => {
    const MAILPIT = { ...LOCAL, COMPOSE_PROFILES: 'local,mailpit' };

    test('healthy, it takes mail at its alias, and its inbox port is reported', async () => {
        const checks = await verify(MAILPIT);
        assert.equal(checks.mailpit!.status, 'ok');
        assert.match(checks.mailpit!.detail, /takes mail at mailpit-ghost-local-site:1025/);
        assert.match(
            checks['published ports']!.detail,
            /Ghost on 127\.0\.0\.1:2368, and Mailpit's inbox on 127\.0\.0\.1:8025/,
        );
    });

    test('unhealthy, or not answering SMTP, it is an error', async () => {
        site.mailpit = 'unhealthy';
        assert.match((await verify(MAILPIT)).mailpit!.detail, /not healthy \(running, unhealthy\)/);
        site.mailpit = 'healthy';
        site.smtp = 'connect ECONNREFUSED';
        const checks = await verify(MAILPIT);
        assert.equal(checks.mailpit!.status, 'error');
        assert.match(checks.mailpit!.detail, /did not answer SMTP .*ECONNREFUSED/);
    });
});

test('a site network the manager cannot join makes each check an error, never a pass', async () => {
    h.daemon.network = { refuse: 'the manager could not join the site network: permission denied' };
    const checks = await verify({ ...PRODUCTION, COMPOSE_PROFILES: 'production' });
    for (const label of ['ghost', 'caddy', 'https']) {
        assert.equal(checks[label]!.status, 'error', label);
        assert.match(
            checks[label]!.detail,
            /could not be asked on the site network: .*permission denied/,
        );
    }
    assert.deepEqual(h.network.probes, []);
});
