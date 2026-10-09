// Verification: what each container's answer means.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ServiceUnreachable, type HttpsAnswer } from '../src/clients.ts';
import { readSettings, siteFacts } from '../src/site.ts';
import { verifyIngress } from '../src/verify.ts';
import { harness, ok, type Harness } from './helpers.ts';
import { LOCAL, makeSite, PRODUCTION } from './site.ts';

/** Ghost's answer for its site, as the Admin API gives it. */
const GHOST = JSON.stringify({ site: { title: 'A site', url: 'https://example.com/' } });

/** Ghost answering through Caddy, with a valid certificate; `changes` alter it. */
const serving = (
    changes: Partial<Omit<HttpsAnswer, 'certificate'>> & {
        certificate?: Partial<HttpsAnswer['certificate']>;
    } = {},
): HttpsAnswer => ({
    status: 200,
    body: GHOST,
    ...changes,
    location: changes.location ?? null,
    certificate: {
        issuer: "Let's Encrypt",
        covers: true,
        validTo: '2027-01-07T12:00:00.000Z',
        expired: false,
        untrusted: null,
        ...changes.certificate,
    },
});

let h: Harness;
let site: { ghost: string; caddy: string; mailpit: string };
/** What Caddy answers for each name; unset, it has no certificate for it. */
let caddy: Record<string, HttpsAnswer | Error>;
beforeEach(() => {
    h = harness();
    site = {
        ghost: 'healthy',
        caddy: 'healthy',
        mailpit: 'healthy',
    };
    caddy = {};
    // The one question asked directly, from the manager on the site network.
    h.daemon.https = ({ servername, path }) => {
        assert.equal(path, '/ghost/api/admin/site/');
        return caddy[servername] ?? new ServiceUnreachable('tls', 'tlsv1 alert internal error');
    };
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
            /^pending: Caddy has no certificate for example\.com yet \(the TLS handshake fails\), so Ghost could not be asked through it yet/,
        );
        assert.match(
            checks['published ports']!.detail,
            /Ghost on 127\.0\.0\.1:2368 and Caddy on 0\.0\.0\.0:80/,
        );
        assert.deepEqual(h.network.probes, ['https example.com caddy-ghost-example-com:443']);
    });

    test('serving only when Ghost answers through Caddy, naming the issuer and expiry', async () => {
        caddy['example.com'] = serving();
        const checks = await verify(PRODUCTION);
        assert.equal(checks.https!.status, 'ok');
        assert.match(
            checks.https!.detail,
            /^serving: Ghost for https:\/\/example\.com\/ answers through Caddy at https:\/\/example\.com, with a certificate from Let's Encrypt valid until 2027-01-07$/,
        );
    });

    test("another site's Ghost answering through Caddy is an error, naming both sites", async () => {
        caddy['example.com'] = serving({
            body: JSON.stringify({ site: { title: 'Another', url: 'https://wrong.example/' } }),
        });
        const checks = await verify(PRODUCTION);
        assert.equal(checks.https!.status, 'error');
        assert.match(
            checks.https!.detail,
            /^Caddy serves example\.com, but another site's Ghost answered through it: it reports https:\/\/wrong\.example\/, and this site is https:\/\/example\.com\/\.\nCheck that the routes in caddy\/sites\/ send example\.com to this site's Ghost$/,
        );
    });

    test('the site is told by its URL as Ghost writes it: a trailing slash and case aside, and its path', async () => {
        caddy['example.com'] = serving();
        assert.equal(
            (await verify({ ...PRODUCTION, URL: 'https://EXAMPLE.com/' })).https!.status,
            'ok',
        );
        const blog = await verify({ ...PRODUCTION, URL: 'https://example.com/blog' });
        assert.equal(blog.https!.status, 'error');
        assert.match(blog.https!.detail, /this site is https:\/\/example\.com\/blog\//);
    });

    test('a URL that is not one is an error, and nothing is asked', async () => {
        const checks = await verify({ ...PRODUCTION, URL: 'https://' });
        assert.equal(checks.https!.status, 'error');
        assert.match(checks.https!.detail, /URL in \.env \(https:\/\/\) is not a URL/);
        assert.deepEqual(h.network.probes, []);
    });

    test('a broken route from Caddy to Ghost is an error, whatever the certificate', async () => {
        caddy['example.com'] = serving({ status: 502, body: '' });
        const checks = await verify(PRODUCTION);
        assert.equal(checks.https!.status, 'error');
        assert.match(
            checks.https!.detail,
            /Caddy serves example\.com, but Ghost did not answer through it: \/ghost\/api\/admin\/site\/ gave HTTP 502/,
        );
    });

    test('a 200 that is not Ghost is an error, not serving', async () => {
        for (const body of ['alpha', '{"site":{"title":"no url"}}', 'null']) {
            caddy['example.com'] = serving({ body });
            const checks = await verify(PRODUCTION);
            assert.equal(checks.https!.status, 'error', body);
            assert.match(checks.https!.detail, /Ghost did not answer through it: .* gave HTTP 200/);
        }
    });

    test('a certificate browsers do not trust is serving, with a warning', async () => {
        caddy['example.com'] = serving({
            certificate: {
                issuer: "(STAGING) Let's Encrypt",
                untrusted: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
            },
        });
        const checks = await verify(PRODUCTION);
        assert.equal(checks.https!.status, 'warn');
        assert.match(
            checks.https!.detail,
            /^serving: .*not a CA browsers trust \(UNABLE_TO_GET_ISSUER_CERT_LOCALLY\)/,
        );
    });

    test('an out-of-date certificate is an error', async () => {
        caddy['example.com'] = serving({
            certificate: { expired: true, validTo: '2026-01-01T00:00:00.000Z' },
        });
        const checks = await verify(PRODUCTION);
        assert.equal(checks.https!.status, 'error');
        assert.match(checks.https!.detail, /out of date \(valid until 2026-01-01/);
    });

    test('a certificate for another name is still pending', async () => {
        caddy['example.com'] = serving({
            certificate: { covers: false, issuer: 'Caddy Local Authority' },
        });
        const checks = await verify(PRODUCTION);
        assert.equal(checks.https!.status, 'note');
        assert.match(
            checks.https!.detail,
            /^pending: Caddy presents a certificate from Caddy Local Authority that does not name example\.com/,
        );
    });

    test('Caddy not answering at all is an error', async () => {
        caddy['example.com'] = new ServiceUnreachable('connect', 'connect ECONNREFUSED');
        const checks = await verify(PRODUCTION);
        assert.equal(checks.https!.status, 'error');
        assert.match(checks.https!.detail, /Caddy did not answer for example\.com .*ECONNREFUSED/);
    });

    test("with an admin domain, the site's domain passes on Ghost's redirect of its Admin API there", async () => {
        caddy['example.com'] = serving({
            status: 301,
            location: 'https://admin.example.com/ghost/api/admin/site/',
            body: '',
        });
        caddy['admin.example.com'] = serving();
        const checks = await verify({ ...PRODUCTION, ADMIN_URL: 'https://admin.example.com' });
        assert.equal(checks.https!.status, 'ok', checks.https!.detail);
        assert.match(checks.https!.detail, /\(sending its Admin API to admin\.example\.com\)/);
        // Reached by the admin domain, Ghost still reports the site's own URL.
        assert.equal(checks['admin https']!.status, 'ok');
        assert.match(
            checks['admin https']!.detail,
            /^serving: Ghost for https:\/\/example\.com\/ answers through Caddy at https:\/\/admin\.example\.com,/,
        );
    });

    test('the admin domain answering as a site of its own, or as another, is an error', async () => {
        caddy['example.com'] = serving({
            status: 301,
            location: 'https://admin.example.com/ghost/api/admin/site/',
            body: '',
        });
        for (const url of ['https://admin.example.com/', 'https://wrong.example/']) {
            caddy['admin.example.com'] = serving({
                body: JSON.stringify({ site: { title: 'Another', url } }),
            });
            const checks = await verify({ ...PRODUCTION, ADMIN_URL: 'https://admin.example.com' });
            assert.equal(checks['admin https']!.status, 'error', url);
            assert.match(
                checks['admin https']!.detail,
                new RegExp(
                    `another site's Ghost answered through it: it reports ${url.replace(/\./g, '\\.')}, and this site is https://example\\.com/`,
                ),
            );
        }
    });

    test('a redirect anywhere else is not Ghost answering', async () => {
        caddy['example.com'] = serving({
            status: 308,
            location: 'https://example.com/ghost/api/admin/site/',
            body: '',
        });
        assert.equal((await verify(PRODUCTION)).https!.status, 'error');
        caddy['example.com'] = serving({
            status: 301,
            location: 'https://elsewhere.example/ghost/api/admin/site/',
            body: '',
        });
        const elsewhere = await verify({ ...PRODUCTION, ADMIN_URL: 'https://admin.example.com' });
        assert.equal(elsewhere.https!.status, 'error');
    });

    test('an admin domain of its own is asked for separately, by its own name', async () => {
        caddy['example.com'] = serving();
        caddy['admin.example.com'] = serving({ status: 404, body: 'Not Found' });
        const checks = await verify({ ...PRODUCTION, ADMIN_URL: 'https://admin.example.com' });
        assert.equal(checks.https!.status, 'ok');
        assert.equal(checks['admin https']!.status, 'error');
        assert.match(
            checks['admin https']!.detail,
            /Caddy serves admin\.example\.com, but Ghost did not answer/,
        );
        assert.deepEqual(h.network.probes, [
            'https example.com caddy-ghost-example-com:443',
            'https admin.example.com caddy-ghost-example-com:443',
        ]);
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
