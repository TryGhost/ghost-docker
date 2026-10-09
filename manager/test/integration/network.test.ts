// The manager on a site's network, against the real daemon and services.
//
// Three sites: `alpha` on the network Compose names for it, with Caddy;
// `bravo` and `charlie` on one external network an override names,
// charlie without its per-site alias. Ghost itself is never started: its own
// checks are tests/e2e/install.sh's, through a real installation.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { run } from '../../src/cli.ts';
import { ServiceUnreachable } from '../../src/clients.ts';
import { connectNetwork, disconnectNetwork } from '../../src/docker/client.ts';
import { CliError } from '../../src/errors.ts';
import { rowCounts, tableCount, withSiteDatabase } from '../../src/import/database.ts';
import { NetworkUnavailable, onSiteNetwork } from '../../src/network.ts';
import { verifyIngress } from '../../src/verify.ts';
import {
    containerOf,
    makeSite,
    managerNetworks,
    named,
    NO_HOST_PORTS,
    realIo,
    type TestSite,
} from './site.ts';

const io = realIo();
const SHARED = named('shared');

/** On the shared network an override names, as two sites' operators might. */
const sharedNetwork = (extra = '') => `${NO_HOST_PORTS}${extra}
networks:
  ghost_network:
    name: ${SHARED}
    external: true
`;

/** Charlie's db answers on the network only as `db` and by its address. */
const WITHOUT_ALIAS = `  db:
    networks:
      ghost_network:
        aliases: !reset []
`;

let alpha: TestSite;
let bravo: TestSite;
let charlie: TestSite;

before(
    async () => {
        const created = await io.docker({
            method: 'POST',
            path: '/networks/create',
            body: { Name: SHARED },
        });
        assert.equal(created.status, 201, created.body.toString());
        alpha = makeSite(io, 'alpha', {
            profiles: 'production',
            url: 'https://example.test',
            // Certificates from Caddy's own CA at once, rather than ACME's
            // once DNS points here: the test CA, which no browser trusts.
            // Ghost is never started, so Caddy itself stands in for it on a
            // port of its own; broken.test routes to nothing.
            caddy: [
                'example.test {',
                '\ttls internal',
                '\treverse_proxy 127.0.0.1:2368',
                '}',
                'http://:2368 {',
                '\trespond `{"site":{"title":"alpha","url":"https://example.test/"}}` 200',
                '}',
                'broken.test {',
                '\ttls internal',
                '\treverse_proxy 127.0.0.1:9',
                '}',
                '',
            ].join('\n'),
        });
        bravo = makeSite(io, 'bravo', { profiles: 'local', override: sharedNetwork() });
        charlie = makeSite(io, 'charlie', {
            profiles: 'local',
            override: sharedNetwork(WITHOUT_ALIAS),
        });
        await Promise.all([alpha.up('db', 'caddy'), bravo.up('db'), charlie.up('db')]);
    },
    { timeout: 1_200_000 },
);

after(async () => {
    // Whatever the tests left: the teardown test below is what asserts it.
    for (const site of [alpha, bravo, charlie]) {
        await site?.down();
    }
    await io.docker({ method: 'DELETE', path: `/networks/${SHARED}` }).catch(() => undefined);
});

/** The db container's hostname, as MySQL itself reports it through the connection. */
const mysqlHostname = (site: TestSite) =>
    withSiteDatabase(io, site.dir, { failure: 'the database could not be asked' }, (sql) =>
        sql.query('SELECT @@hostname').then((rows) => String(rows[0]![0])),
    );

test('a fresh site: the network Compose named, the per-site alias, and the site user signed in', async () => {
    const network = `${alpha.project}_ghost_network`;
    const seen = await onSiteNetwork(io, await alpha.services(), ['db'], async (site) => ({
        name: site.name,
        db: site.address('db'),
        joined: await managerNetworks(io),
    }));
    assert.equal(seen.name, network);
    assert.deepEqual(seen.db, { host: `db-${alpha.project}`, name: `db-${alpha.project}` });
    assert.ok(seen.joined.includes(network), `the manager was on ${seen.joined.join(', ')}`);
    assert.ok(!(await managerNetworks(io)).includes(network), 'the manager stayed on the network');

    // mysql2 against the stack's MySQL, as the site's user over plain TCP.
    const counted = await withSiteDatabase(
        io,
        alpha.dir,
        { failure: 'the database could not be used' },
        async (sql) => {
            await sql.query('CREATE TABLE posts (id INT)');
            await sql.query('INSERT INTO posts VALUES (1), (2), (3)');
            return { tables: await tableCount(sql), rows: await rowCounts(sql, ['posts']) };
        },
    );
    assert.equal(counted.tables, 1);
    assert.deepEqual([...counted.rows], [['posts', 3]]);
    assert.equal(
        (await mysqlHostname(alpha)).slice(0, 12),
        (await containerOf(alpha, 'db')).slice(0, 12),
    );
});

test('verification asks the real Caddy for Ghost, and leaves the network', async () => {
    const facts = alpha.facts();
    // Caddy issues its internal certificates in the background once it starts.
    let checks = await verifyIngress(io, facts);
    for (
        let tries = 0;
        tries < 20 && checks.find((c) => c.label === 'https')?.status === 'note';
        tries += 1
    ) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        checks = await verifyIngress(io, facts);
    }
    const by = (label: string) => checks.filter((check) => check.label === label);

    assert.equal(by('ghost')[0]?.status, 'error', 'Ghost was never started');
    assert.match(by('ghost')[0]!.detail, /not healthy \(no container\)/);
    // compose.yml's own health check: `up --wait` in before() waited for it.
    assert.equal(by('caddy')[0]?.status, 'ok', by('caddy')[0]?.detail ?? '');
    assert.match(by('caddy')[0]!.detail, /^healthy: its admin API answers/);
    // Through Caddy over TLS to what answers as Ghost; Caddy's CA is not one
    // browsers trust, which is a warning, not a pass.
    assert.equal(by('https')[0]?.status, 'warn', by('https')[0]?.detail ?? '');
    assert.match(
        by('https')[0]!.detail,
        /^serving: Ghost answers through Caddy at https:\/\/example\.test, with a certificate from Caddy Local Authority[^,]* valid until \d{4}-\d\d-\d\d\. Its issuer is not a CA browsers trust/,
    );
    assert.ok(!(await managerNetworks(io)).includes(`${alpha.project}_ghost_network`));

    // A route to nothing is an error, though Caddy has a certificate for it.
    let broken = await verifyIngress(io, { ...facts, domain: 'broken.test' });
    for (
        let tries = 0;
        tries < 20 && broken.find((c) => c.label === 'https')?.status === 'note';
        tries += 1
    ) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        broken = await verifyIngress(io, { ...facts, domain: 'broken.test' });
    }
    const brokenHttps = broken.find((check) => check.label === 'https')!;
    assert.equal(brokenHttps.status, 'error', brokenHttps.detail);
    assert.match(
        brokenHttps.detail,
        /Caddy serves broken\.test, but Ghost did not answer through it: \/ghost\/api\/admin\/site\/ gave HTTP 502/,
    );

    // A name Caddy has no site for fails the handshake, which is
    // what verification reports as pending.
    await onSiteNetwork(io, await alpha.services(), ['caddy'], async (site) => {
        await assert.rejects(
            io.clients.https({
                host: site.address('caddy')!.host,
                port: 443,
                servername: 'pending.test',
                path: '/',
            }),
            (error) => error instanceof ServiceUnreachable && error.stage === 'tls',
        );
    });
});

test('two sites on one network an override names: each reaches its own database', async () => {
    const address = async (site: TestSite) =>
        onSiteNetwork(io, await site.services(), ['db'], async (network) => ({
            name: network.name,
            db: network.address('db'),
        }));
    const b = await address(bravo);
    const c = await address(charlie);
    assert.equal(b.name, SHARED);
    assert.equal(c.name, SHARED);
    // `db` alone would answer with either site's container here.
    assert.deepEqual(b.db, { host: `db-${bravo.project}`, name: `db-${bravo.project}` });
    assert.equal(c.db?.name, 'db');
    assert.match(c.db!.host, /^\d+\.\d+\.\d+\.\d+$/, 'without its alias, by its address');

    const hosts = await Promise.all([bravo, charlie, alpha].map(mysqlHostname));
    const ids = await Promise.all([bravo, charlie, alpha].map((site) => containerOf(site, 'db')));
    assert.deepEqual(
        hosts,
        ids.map((id) => id.slice(0, 12)),
    );
    assert.ok(!(await managerNetworks(io)).includes(SHARED));
});

test('phases repeated and run at once leave no attachment and no connection', async () => {
    for (let round = 0; round < 5; round += 1) {
        await mysqlHostname(alpha);
    }
    await Promise.all(
        [1, 2, 3].map(() =>
            withSiteDatabase(io, alpha.dir, { failure: 'the database could not be asked' }, (sql) =>
                sql.query('SELECT SLEEP(0.5)'),
            ),
        ),
    );
    await Promise.all([verifyIngress(io, alpha.facts()), mysqlHostname(alpha)]);
    assert.ok(!(await managerNetworks(io)).includes(`${alpha.project}_ghost_network`));

    // Only the connection asking is left of all of them. MySQL's own health
    // check signs in as the site's user too, from inside its container.
    const open = await withSiteDatabase(
        io,
        alpha.dir,
        { failure: 'the database could not be asked' },
        (sql) =>
            sql.query(
                "SELECT COUNT(*) FROM information_schema.processlist WHERE user = 'ghost' " +
                    "AND host NOT LIKE '127.0.0.1:%' AND host NOT LIKE 'localhost%'",
            ),
    );
    assert.equal(String(open[0]![0]), '1');
});

test('a query MySQL does not answer in time is closed at once, and the network left', async () => {
    const network = `${alpha.project}_ghost_network`;
    for (let round = 0; round < 3; round += 1) {
        const start = performance.now();
        await assert.rejects(
            withSiteDatabase(io, alpha.dir, { failure: 'the database could not be asked' }, (sql) =>
                sql.query('SELECT SLEEP(5)', 200),
            ),
            (error) =>
                error instanceof CliError &&
                /the database could not be asked: db-\S+:3306: no answer to a query within/.test(
                    error.message,
                ),
        );
        // The query's 200 ms, joining and leaving: not the 5 seconds MySQL
        // takes to answer, which a graceful close would wait for.
        const took = performance.now() - start;
        assert.ok(took < 4_000, `the failure took ${Math.round(took)} ms`);
        assert.ok(!(await managerNetworks(io)).includes(network));
    }

    // MySQL lets go of the connections once their sleeps end; then only
    // the connection asking is left.
    const others = () =>
        withSiteDatabase(io, alpha.dir, { failure: 'the database could not be asked' }, (sql) =>
            sql.query(
                "SELECT COUNT(*) FROM information_schema.processlist WHERE user = 'ghost' " +
                    "AND host NOT LIKE '127.0.0.1:%' AND host NOT LIKE 'localhost%'",
            ),
        );
    let open = await others();
    for (let tries = 0; tries < 20 && String(open[0]![0]) !== '1'; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        open = await others();
    }
    assert.equal(String(open[0]![0]), '1');
    assert.ok(!(await managerNetworks(io)).includes(network));
});

test('a phase that fails, or a connection refused, still leaves the network', async () => {
    const network = `${alpha.project}_ghost_network`;
    await assert.rejects(
        onSiteNetwork(io, await alpha.services(), ['db'], async () => {
            throw new Error('the work failed');
        }),
        /the work failed/,
    );
    assert.ok(!(await managerNetworks(io)).includes(network));

    await assert.rejects(
        withSiteDatabase(
            io,
            alpha.dir,
            { database: 'not_the_sites', failure: 'the database could not be used' },
            (sql) => sql.query('SELECT 1'),
        ),
        (error) =>
            error instanceof CliError &&
            /the database could not be used: .*access denied/i.test(error.message),
    );
    assert.ok(!(await managerNetworks(io)).includes(network));
});

test('a manager that cannot join is an error naming why, and joins nothing', async () => {
    const services = await alpha.services();
    await assert.rejects(
        onSiteNetwork(realIo({ containerId: () => null }), services, ['db'], async () => undefined),
        (error) =>
            error instanceof NetworkUnavailable &&
            /cannot tell which container/.test(error.message),
    );
    // The real daemon, except that it refuses the join.
    const refusing = realIo({
        docker: (request) =>
            request.path.endsWith('/connect')
                ? Promise.resolve({
                      status: 403,
                      body: Buffer.from('{"message":"refused by the test"}'),
                  })
                : io.docker(request),
    });
    await assert.rejects(
        onSiteNetwork(refusing, services, ['db'], async () => undefined),
        (error) =>
            error instanceof NetworkUnavailable &&
            /could not join the site's network .*: refused by the test/.test(error.message),
    );
    await assert.rejects(
        onSiteNetwork(io, services, ['ghost'], async () => undefined),
        (error) =>
            error instanceof NetworkUnavailable &&
            /no ghost container is running/.test(error.message),
    );
    assert.ok(!(await managerNetworks(io)).includes(`${alpha.project}_ghost_network`));
});

test('a network the manager was already on is not taken from it', async () => {
    const network = `${alpha.project}_ghost_network`;
    await connectNetwork(io.docker, network, io.containerId()!);
    try {
        await mysqlHostname(alpha);
        assert.ok((await managerNetworks(io)).includes(network));
    } finally {
        await disconnectNetwork(io.docker, network, io.containerId()!);
    }
});

test('list finds each running site, its mode and its directory, through Compose', async () => {
    const out: string[] = [];
    assert.equal(await run(['list'], realIo({ stdout: (text) => void out.push(text) })), 0);
    const rows = out
        .join('')
        .split('\n')
        .map((line) => line.split(/\s+/).filter(Boolean));
    for (const [site, mode] of [
        [alpha, 'production'],
        [bravo, 'local'],
        [charlie, 'local'],
    ] as const) {
        const row = rows.find((cells) => cells[0] === site.project);
        assert.deepEqual(
            [row?.[1], row?.[2]?.replace(/\(.*/, ''), row?.[3]],
            [mode, 'running', site.dir],
        );
    }
});

test('each site comes down with its network, and nothing of the manager is left on it', async () => {
    for (const site of [alpha, bravo, charlie]) {
        const down = await site.down();
        assert.ok(down.ok, `${site.project}: ${down.error}`);
    }
    const gone = await io.docker({
        method: 'GET',
        path: `/networks/${alpha.project}_ghost_network`,
    });
    assert.equal(gone.status, 404);
    // The shared network is external: Compose leaves it, and nothing is on it.
    const shared = await io.docker({ method: 'GET', path: `/networks/${SHARED}` });
    assert.deepEqual(JSON.parse(shared.body.toString()).Containers, {});
    const left = await managerNetworks(io);
    assert.ok(
        !left.includes(SHARED) && !left.some((name) => name.startsWith(named(''))),
        left.join(', '),
    );
});
