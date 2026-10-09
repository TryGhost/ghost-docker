// Reaching a site in order to verify it (plan §2.8).
//
// Each service is judged by its own Compose health check, which `up --wait`
// already required, and nothing is described as more than it is:
//
//   ghost           its health check: the Admin API answers inside the container
//   caddy           its health check: its admin API answers, so it is up with
//                   its configuration loaded. Not that it routes each name
//   https           whether Caddy presents a certificate for the domain yet:
//                   serving, or pending until DNS reaches this host. The one
//                   question no health check answers, asked with a TLS
//                   handshake from the site's own network (network.ts), because
//                   127.0.0.1 in the manager is the manager, not the host
//   mailpit         with that profile: its health check. That Ghost's mail
//                   reaches it is tests/e2e/install.sh's to prove
//   published ports what Docker says it published, not verified from the host
import { ServiceUnreachable } from './clients.ts';
import { composePs, type ServiceState } from './compose.ts';
import type { Io } from './io.ts';
import { NetworkUnavailable, type SiteNetwork } from './network.ts';
import { CliError } from './errors.ts';
import { failed, heading, printChecks, type Check } from './report.ts';
import { hasProfile, readSettings, siteFacts, type SiteFacts } from './site.ts';

const describeState = (state: ServiceState | undefined): string =>
    state ? [state.State, state.Health].filter(Boolean).join(', ') : 'no container';

/** A service by its own health check; `what` says what that check proves. */
const healthy = (label: string, state: ServiceState | undefined, what: string): Check =>
    state?.Health === 'healthy'
        ? ok(label, `healthy: ${what}`)
        : error(label, `not healthy (${describeState(state)})`);

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
    const checks: Check[] = [
        healthy('ghost', state('ghost'), 'its Admin API answers inside the container'),
    ];
    if (production) {
        checks.push(
            healthy(
                'caddy',
                state('caddy'),
                'its admin API answers, with its configuration loaded',
            ),
        );
        try {
            checks.push(
                await io.siteNetwork(services ?? [], ['caddy'], (network) =>
                    https(io, network, site.domain),
                ),
            );
        } catch (failure) {
            if (!(failure instanceof NetworkUnavailable)) {
                throw failure;
            }
            checks.push(
                error('https', `could not be asked on the site network: ${failure.message}`),
            );
        }
    }
    if (withMailpit) {
        const alias = `mailpit-${site.settings.get('COMPOSE_PROJECT_NAME') || 'ghost'}`;
        checks.push(healthy('mailpit', state('mailpit'), `Ghost sends mail to ${alias}:1025`));
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

/** A site just started, verified and reported; a failure is a CliError. */
export async function verifySite(io: Io, dir: string): Promise<void> {
    heading(io, 'Verifying the site');
    const verified = await io.busy('Verifying the site', () =>
        verifyIngress(io, siteFacts(dir, readSettings(dir)!)),
    );
    printChecks(io, verified);
    if (failed(verified)) {
        throw new CliError('the site started, but it is not reachable through its own ingress');
    }
}
