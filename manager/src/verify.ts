// Reaching a site in order to verify it (plan §2.8).
//
// 127.0.0.1 in the manager is the manager, not the host, so the manager
// joins the site's own network (network.ts) and asks each service directly,
// with Node's own clients. Nothing is described as more than it is:
//
//   ghost           direct: its health check, which `up --wait` already
//                   required, and its Admin API answering on the site network
//   caddy           ingress: Caddy answers http://DOMAIN with a redirect to
//                   HTTPS. Caddy 2.10 redirects any name, served or not
//                   (tests/integration), so this shows Caddy is up and
//                   answering, not that it routes the name; https does that
//   https           ingress: whether Caddy presents a certificate for the
//                   domain yet: serving, or pending until DNS reaches this host
//   mailpit         direct, with that profile: its health check, and its SMTP
//                   greeting where Ghost sends mail
//   published ports what Docker says it published, not verified from the host
//
// A direct check proves the service answers on the site network; only the
// ingress checks say anything about how the site is reached, and even they
// ask Caddy from inside the network, not from the host.
import { ServiceUnreachable } from './clients.ts';
import { composePs, type ServiceState } from './compose.ts';
import type { Io } from './io.ts';
import { NetworkUnavailable, type SiteNetwork } from './network.ts';
import type { Check } from './report.ts';
import { hasProfile, type SiteFacts } from './site.ts';

/** The path Ghost's own health check asks. */
const ADMIN_API_PATH = '/ghost/api/admin/site/';

const describeState = (state: ServiceState | undefined): string =>
    state ? [state.State, state.Health].filter(Boolean).join(', ') : 'no container';

/** Healthy by its own health check, and its Admin API answering on the site network. */
async function ghost(io: Io, network: SiteNetwork, state: ServiceState | undefined) {
    if (state?.Health !== 'healthy') {
        return error('ghost', `not healthy (${describeState(state)})`);
    }
    const address = network.address('ghost');
    if (address === null) {
        return error('ghost', `healthy, but not on the site network ${network.name}`);
    }
    try {
        const answer = await io.clients.http({
            host: address.host,
            port: 2368,
            path: ADMIN_API_PATH,
        });
        return answer.status > 0 && answer.status < 400
            ? ok(
                  'ghost',
                  `healthy, and its Admin API answers at ${address.name}:2368 on the site network`,
              )
            : error(
                  'ghost',
                  `healthy, but its Admin API answered ${answer.status} at ${address.name}:2368 on the site network`,
              );
    } catch (failure) {
        return error(
            'ghost',
            `healthy, but its Admin API did not answer at ${address.name}:2368 on the site network: ${message(failure)}`,
        );
    }
}

/** For each domain, http://DOMAIN asked of Caddy with that Host. */
async function redirects(
    io: Io,
    network: SiteNetwork,
    domains: readonly string[],
): Promise<Check[]> {
    const address = network.address('caddy');
    if (address === null) {
        return [error('caddy', `no running caddy container on the site network ${network.name}`)];
    }
    const checks: Check[] = [];
    for (const domain of domains) {
        try {
            const { status, location } = await io.clients.http({
                host: address.host,
                port: 80,
                path: '/',
                headers: { Host: domain },
            });
            checks.push(
                status >= 300 && status < 400 && location.startsWith(`https://${domain}`)
                    ? ok(
                          'caddy',
                          `http://${domain} redirects to HTTPS through ${address.name}:80 on the site network`,
                      )
                    : error(
                          'caddy',
                          `Caddy answered ${status} for http://${domain}, not a redirect to https://${domain}; check caddy/sites/site.caddy`,
                      ),
            );
        } catch (failure) {
            checks.push(
                error('caddy', `Caddy did not answer for http://${domain}: ${message(failure)}`),
            );
        }
    }
    return checks;
}

/**
 * HTTPS as an issuance state: the certificate Caddy presents for the domain.
 * Caddy obtains one in the background once the domain's DNS reaches this
 * host; until then the handshake fails, and no probe could show more.
 */
async function https(io: Io, network: SiteNetwork, domain: string): Promise<Check> {
    const address = network.address('caddy');
    const pending = (reason: string): Check => ({
        status: 'note',
        label: 'https',
        detail:
            `pending: there is no certificate for ${domain} yet (${reason}). Caddy obtains one once the domain's DNS reaches this host;\n` +
            '`./ghost-docker check` reports the change, and `docker compose logs caddy` shows each attempt.',
    });
    if (address === null) {
        return error('https', `no running caddy container on the site network ${network.name}`);
    }
    try {
        const presented = await io.clients.certificate({
            host: address.host,
            port: 443,
            servername: domain,
        });
        return presented.covers
            ? ok(
                  'https',
                  `serving: Caddy presents a certificate for ${domain} from ${presented.issuer}`,
              )
            : pending(`Caddy presents one from ${presented.issuer} that does not name it`);
    } catch (failure) {
        // Something answered and would not set up a session: Caddy has no
        // certificate to offer for the name.
        if (failure instanceof ServiceUnreachable && failure.stage === 'tls') {
            return pending('the TLS handshake fails');
        }
        return error(
            'https',
            `Caddy did not answer on ${address.name}:443 on the site network: ${message(failure)}`,
        );
    }
}

/** Mailpit, healthy, and taking mail where Ghost sends it: its alias on the site network. */
async function mailpit(
    io: Io,
    network: SiteNetwork,
    state: ServiceState | undefined,
): Promise<Check> {
    if (state?.Health !== 'healthy') {
        return error('mailpit', `not healthy (${describeState(state)})`);
    }
    const address = network.address('mailpit');
    if (address === null) {
        return error('mailpit', `healthy, but not on the site network ${network.name}`);
    }
    let greeting: string;
    try {
        greeting = await io.clients.greeting({ host: address.host, port: 1025 });
    } catch (failure) {
        greeting = message(failure);
    }
    return greeting.startsWith('220')
        ? ok('mailpit', `healthy, and takes mail at ${address.name}:1025 on the site network`)
        : error(
              'mailpit',
              `did not answer SMTP at ${address.name}:1025 on the site network: ${greeting || 'no answer'}`,
          );
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

const ok = (label: string, detail: string): Check => ({ status: 'ok', label, detail });
const error = (label: string, detail: string): Check => ({ status: 'error', label, detail });
const message = (failure: unknown): string =>
    failure instanceof Error ? failure.message : String(failure);

/** Everything that can be known about a site whose services are up. */
export async function verifyIngress(
    io: Io,
    site: SiteFacts,
    known?: readonly ServiceState[] | null,
): Promise<Check[]> {
    const production = site.mode === 'production';
    const withMailpit = hasProfile(site.settings.get('COMPOSE_PROFILES') ?? '', 'mailpit');
    // `check` has the service states already.
    const services = known ?? (await composePs(io, site.dir));
    const state = (service: string) => services?.find((entry) => entry.Service === service);
    const wanted = ['ghost', ...(production ? ['caddy'] : []), ...(withMailpit ? ['mailpit'] : [])];
    const labels = [
        'ghost',
        ...(production ? ['caddy', 'https'] : []),
        ...(withMailpit ? ['mailpit'] : []),
    ];

    let checks: Check[];
    try {
        checks = await io.siteNetwork(services ?? [], wanted, async (network) => {
            const found: Check[] = [await ghost(io, network, state('ghost'))];
            if (production) {
                const domains = [site.domain, site.adminDomain].filter((name) => name !== '');
                found.push(
                    ...(await redirects(io, network, domains)),
                    await https(io, network, site.domain),
                );
            }
            if (withMailpit) {
                found.push(await mailpit(io, network, state('mailpit')));
            }
            return found;
        });
    } catch (failure) {
        if (!(failure instanceof NetworkUnavailable)) {
            throw failure;
        }
        // Nothing could be asked: each check says why, rather than passing.
        checks = labels.map((label) =>
            label === 'ghost' && state('ghost')?.Health !== 'healthy'
                ? error('ghost', `not healthy (${describeState(state('ghost'))})`)
                : error(label, `could not be asked on the site network: ${failure.message}`),
        );
    }
    checks.push({
        status: 'note',
        label: 'published ports',
        detail:
            `Docker publishes Ghost on ${publishedPorts(services, 'ghost')}` +
            (production ? ` and Caddy on ${publishedPorts(services, 'caddy')}` : '') +
            (withMailpit ? `, and Mailpit's inbox on ${publishedPorts(services, 'mailpit')}` : '') +
            '; a container cannot reach the host, so open the URL to see them from there',
    });
    return checks;
}
