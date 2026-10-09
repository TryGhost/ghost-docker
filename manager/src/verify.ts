// Reaching a site in order to verify it (plan §2.8).
//
// Each service is judged by its own Compose health check, which `up --wait`
// already required, and nothing is described as more than it is:
//
//   ghost           its health check: the Admin API answers inside the container
//   caddy           its health check: its admin API answers, so it is up with
//                   its configuration loaded. Not that it routes each name
//   https           Ghost's answer through Caddy, for the domain and the admin
//                   domain: an HTTPS request to Caddy, with that name as its
//                   SNI and Host, for Ghost's Admin API site endpoint. Serving
//                   only when Ghost answers it, and the certificate is judged
//                   (its name, its dates, its issuer). Pending while Caddy has
//                   no certificate for the name, which it obtains once DNS
//                   reaches this host: until then the route cannot be tried.
//                   Asked from the site's own network (network.ts), because
//                   127.0.0.1 in the manager is the manager, not the host
//   mailpit         with that profile: its health check. That Ghost's mail
//                   reaches it is tests/e2e/install.sh's to prove
//   published ports what Docker says it published, not verified from the host:
//                   the HTTPS request above goes to Caddy's container, not to
//                   the host's ports 80 and 443
import { ServiceUnreachable, type HttpsAnswer } from './clients.ts';
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

/** Ghost's Admin API site endpoint, which answers without signing in. */
const SITE_PATH = '/ghost/api/admin/site/';

/**
 * Whether Ghost answered SITE_PATH: its site, with its URL. A site with an
 * admin domain of its own serves its Admin API only there, and Ghost answers
 * the path on the site's domain with a redirect to it, which no route of
 * Caddy's would make.
 */
function ghostAnswered(answer: HttpsAnswer, adminElsewhere: string | null): boolean {
    if (adminElsewhere !== null && answer.status >= 300 && answer.status < 400) {
        return (answer.location ?? '').startsWith(`https://${adminElsewhere}${SITE_PATH}`);
    }
    if (answer.status !== 200) {
        return false;
    }
    try {
        const body = JSON.parse(answer.body) as { site?: { url?: unknown } };
        return typeof body.site?.url === 'string';
    } catch {
        return false;
    }
}

/** What answered instead of Ghost, in a few words. */
const instead = (answer: HttpsAnswer): string => {
    const start = answer.body.replace(/\s+/g, ' ').trim().slice(0, 80);
    return `HTTP ${answer.status}${start ? `: ${start}` : ''}`;
};

/**
 * One name through Caddy: Ghost's answer, over TLS with that name as SNI and
 * Host, and the certificate Caddy presented for it. Caddy obtains a
 * certificate in the background once the name's DNS reaches this host; until
 * then the handshake fails, and the route to Ghost cannot be tried.
 */
async function https(
    io: Io,
    network: SiteNetwork,
    label: string,
    name: string,
    adminElsewhere: string | null,
): Promise<Check> {
    const address = network.address('caddy');
    const pending = (reason: string): Check => ({
        status: 'note',
        label,
        detail:
            `pending: ${reason}, so Ghost could not be asked through it yet. Caddy obtains a certificate for ${name} once its DNS reaches this host;\n` +
            '`./ghost-docker check` reports the change, and `docker compose logs caddy` shows each attempt.',
    });
    if (address === null) {
        return error(label, `no running caddy container on the site network ${network.name}`);
    }
    let answer: HttpsAnswer;
    try {
        answer = await io.clients.https({
            host: address.host,
            port: 443,
            servername: name,
            path: SITE_PATH,
        });
    } catch (failure) {
        // Something answered and would not set up a session: Caddy has no
        // certificate to offer for the name.
        if (failure instanceof ServiceUnreachable && failure.stage === 'tls') {
            return pending(`Caddy has no certificate for ${name} yet (the TLS handshake fails)`);
        }
        return error(
            label,
            `Caddy did not answer for ${name} on ${address.name}:443 on the site network: ${message(failure)}`,
        );
    }
    const { certificate } = answer;
    if (!certificate.covers) {
        return pending(
            `Caddy presents a certificate from ${certificate.issuer} that does not name ${name}`,
        );
    }
    if (certificate.expired) {
        return error(
            label,
            `Caddy presents a certificate for ${name} from ${certificate.issuer} that is out of date (valid until ${certificate.validTo}); docker compose logs caddy says why it was not renewed`,
        );
    }
    if (!ghostAnswered(answer, adminElsewhere)) {
        return error(
            label,
            `Caddy serves ${name}, but Ghost did not answer through it: ${SITE_PATH} gave ${instead(answer)}. Check the routes in caddy/sites/`,
        );
    }
    const serving =
        `serving: Ghost answers through Caddy at https://${name}` +
        (adminElsewhere === null ? '' : ` (sending its Admin API to ${adminElsewhere})`) +
        `, with a certificate from ${certificate.issuer} valid until ${certificate.validTo.slice(0, 10)}`;
    return certificate.untrusted === null
        ? ok(label, serving)
        : {
              status: 'warn',
              label,
              detail: `${serving}. Its issuer is not a CA browsers trust (${certificate.untrusted}), as a staging or internal CA is not`,
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
        // The domain, and the admin domain when it has one of its own.
        const adminElsewhere =
            site.adminDomain !== '' && site.adminDomain !== site.domain ? site.adminDomain : null;
        const names: [string, string, string | null][] = [['https', site.domain, adminElsewhere]];
        if (adminElsewhere !== null) {
            names.push(['admin https', adminElsewhere, null]);
        }
        try {
            checks.push(
                ...(await io.siteNetwork(services ?? [], ['caddy'], async (network) => {
                    const answers: Check[] = [];
                    for (const [label, name, elsewhere] of names) {
                        answers.push(await https(io, network, label, name, elsewhere));
                    }
                    return answers;
                })),
            );
        } catch (failure) {
            if (!(failure instanceof NetworkUnavailable)) {
                throw failure;
            }
            for (const [label] of names) {
                checks.push(
                    error(label, `could not be asked on the site network: ${failure.message}`),
                );
            }
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
