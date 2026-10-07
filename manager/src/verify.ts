// Reaching a site in order to verify it (plan §2.8).
//
// 127.0.0.1 in the manager is the manager, not the host, so the site is asked
// from inside its own containers, and nothing is described as more than it
// is:
//
//   ghost           its health check, which `up --wait` already required: the
//                   Admin API answers inside the container
//   caddy           from the ghost container, over the site's network, Caddy
//                   redirects http://DOMAIN to HTTPS, which it does only for a
//                   name it serves
//   https           whether Caddy holds a certificate for the domain yet:
//                   serving, or pending until DNS reaches this host
//   published ports what Docker says it published, not verified from the host
import { compose, composeError, composePs, type ServiceState } from './compose.ts';
import type { Io } from './io.ts';
import type { Check } from './report.ts';
import type { SiteFacts } from './site.ts';

/**
 * Run in the ghost container, which has Node and is on the site's network:
 * one line per domain, `STATUS LOCATION`, for http://caddy/ with that Host.
 */
const REDIRECT_PROBE = `
const http = require('http');
const ask = (host) => new Promise((done) => {
  const request = http.get({ host: 'caddy', port: 80, path: '/', headers: { Host: host }, timeout: 10000 },
    (response) => { response.resume(); done(response.statusCode + ' ' + (response.headers.location || '')); });
  request.on('timeout', () => request.destroy(new Error('no answer within 10 seconds')));
  request.on('error', (error) => done('0 ' + error.message));
});
(async () => { for (const host of process.argv.slice(1)) console.log(await ask(host)); })();
`;

async function redirects(io: Io, site: SiteFacts, domains: readonly string[]): Promise<Check[]> {
    const result = await compose(
        io,
        site.dir,
        ['exec', '-T', 'ghost', 'node', '-e', REDIRECT_PROBE, ...domains],
        { timeoutMs: 60_000 },
    );
    if (result.exitCode !== 0) {
        return [
            {
                status: 'error',
                label: 'caddy',
                detail: `Caddy could not be asked from the site network: ${composeError(result, 2) || 'no answer'}`,
            },
        ];
    }
    const answers = result.stdout.trim().split('\n');
    return domains.map((domain, index) => {
        const [status = '0', ...rest] = (answers[index] ?? '').split(' ');
        const location = rest.join(' ');
        const code = Number(status);
        if (code >= 300 && code < 400 && location.startsWith(`https://${domain}`)) {
            return {
                status: 'ok',
                label: 'caddy',
                detail: `http://${domain} redirects to HTTPS through caddy:80 on the site network`,
            };
        }
        return {
            status: 'error',
            label: 'caddy',
            detail:
                code === 0
                    ? `Caddy did not answer for http://${domain}: ${location}`
                    : `Caddy answered ${code} for http://${domain}, not a redirect to https://${domain}; check caddy/sites/site.caddy`,
        };
    });
}

/**
 * HTTPS as an issuance state. Caddy obtains a certificate in the background
 * once the domain's DNS reaches this host and keeps it in its data volume;
 * until then there is none, and no probe could show more.
 */
async function https(io: Io, site: SiteFacts): Promise<Check> {
    const domain = site.domain;
    const result = await compose(
        io,
        site.dir,
        ['exec', '-T', 'caddy', 'sh', '-c', 'ls -d /data/caddy/certificates/*/"$1"', 'sh', domain],
        { timeoutMs: 60_000 },
    );
    const stored = result.exitCode === 0 ? result.stdout.trim().split('\n')[0] : undefined;
    if (stored) {
        // The directory above the domain's names the issuer.
        return {
            status: 'ok',
            label: 'https',
            detail: `serving: Caddy holds a certificate for ${domain} from ${stored.split('/').at(-2)}`,
        };
    }
    return {
        status: 'note',
        label: 'https',
        detail:
            `pending: there is no certificate for ${domain} yet. Caddy obtains one once the domain's DNS reaches this host;\n` +
            '`./ghost-docker check` reports the change, and `docker compose logs caddy` shows each attempt.',
    };
}

/** Ports Docker says a service publishes. */
const publishedPorts = (services: readonly ServiceState[] | null, service: string): string =>
    [
        ...new Set(
            (services ?? [])
                .filter((entry) => entry.Service === service)
                .flatMap((entry) => entry.Publishers ?? [])
                .filter((publisher) => publisher.PublishedPort > 0)
                .map((publisher) => `${publisher.URL || '0.0.0.0'}:${publisher.PublishedPort}`),
        ),
    ].join(', ') || 'nothing';

/** Everything that can be known about a site whose services are up. */
export async function verifyIngress(
    io: Io,
    site: SiteFacts,
    known?: readonly ServiceState[] | null,
): Promise<Check[]> {
    const production = site.mode === 'production';
    // `check` has the service states already.
    const services = known ?? (await composePs(io, site.dir));
    const ghost = services?.find((entry) => entry.Service === 'ghost');
    const checks: Check[] = [
        ghost?.Health === 'healthy'
            ? {
                  status: 'ok',
                  label: 'ghost',
                  detail: 'healthy: its Admin API answers inside the container',
              }
            : {
                  status: 'error',
                  label: 'ghost',
                  detail: `not healthy (${ghost ? [ghost.State, ghost.Health].filter(Boolean).join(', ') : 'no container'})`,
              },
    ];
    if (production) {
        const domains = [site.domain, site.adminDomain].filter((name) => name !== '');
        checks.push(...(await redirects(io, site, domains)), await https(io, site));
    }
    checks.push({
        status: 'note',
        label: 'published ports',
        detail:
            `Docker publishes Ghost on ${publishedPorts(services, 'ghost')}` +
            (production ? ` and Caddy on ${publishedPorts(services, 'caddy')}` : '') +
            '; a container cannot reach the host, so open the URL to see them from there',
    });
    return checks;
}
