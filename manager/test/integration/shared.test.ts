// The shared Caddy, against the real daemon and a real Caddy: a member's
// routes written, validated and loaded through the running container, its
// Ghost reached by its unique alias on the shared network, a taken domain or
// project refused, routes Caddy refuses taken out again, and removal.
//
// The shared Caddy here is the stack's own compose.yml with the `infra`
// profile, on a network of this run's rather than the real one. The member's
// Ghost is a stand-in that answers as a Ghost of its URL would: the real one
// is tests/e2e/shared-caddy.sh's.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { renderRoutes } from '../../src/caddy.ts';
import { listContainers } from '../../src/docker/client.ts';
import { CliError } from '../../src/errors.ts';
import { PROJECT_LABEL } from '../../src/project.ts';
import {
    addRoutes,
    refuseTaken,
    removeRoutes,
    routeFiles,
    servedHosts,
    SERVICE_LABEL,
    type SharedCaddy,
} from '../../src/shared.ts';
import { makeSite, named, realIo, type TestSite } from './site.ts';

const io = realIo();
const INGRESS = named('ingress');
const CADDY_IMAGE = /image: (caddy:\S+)/.exec(
    readFileSync(join(import.meta.dirname, '..', '..', '..', 'compose.yml'), 'utf8'),
)![1]!;

const ingress: [string, string][] = [
    ['INGRESS_NETWORK', INGRESS],
    ['INGRESS_EXTERNAL', 'true'],
];

let infra: TestSite;
let delta: TestSite;
let shared: SharedCaddy;

/** Delta's Ghost: Caddy answering every request as Ghost's site endpoint does. */
const STAND_IN = `services:
  ghost:
    image: ${CADDY_IMAGE}
    command: ["caddy", "respond", "--listen", ":2368", "--body", '{"site":{"url":"https://delta.test/"}}']
    healthcheck:
      test: [CMD, wget, -q, -O, /dev/null, "http://127.0.0.1:2368/"]
      interval: 1s
      start_period: 0s
    ports: !reset []
`;

const routes = (project: string, domain: string) =>
    renderRoutes({ project, domain, adminDomain: '', email: '', activitypub: false });

before(
    async () => {
        const created = await io.docker({
            method: 'POST',
            path: '/networks/create',
            body: { Name: INGRESS },
        });
        assert.equal(created.status, 201, created.body.toString());
        infra = makeSite(io, 'shared-caddy', { profiles: 'infra', env: ingress });
        // Certificates from Caddy's own CA at once, rather than ACME's.
        mkdirSync(join(infra.dir, 'caddy', 'global'), { recursive: true });
        writeFileSync(join(infra.dir, 'caddy', 'global', 'test.caddy'), 'local_certs\n');
        delta = makeSite(io, 'member-delta', {
            profiles: 'member',
            url: 'https://delta.test',
            env: ingress,
            override: STAND_IN,
        });
        await Promise.all([infra.up('caddy'), delta.up('ghost')]);
        const [container] = await listContainers(io.docker, {
            labels: [`${PROJECT_LABEL}=${infra.project}`, `${SERVICE_LABEL}=caddy`],
        });
        shared = {
            network: INGRESS,
            dir: infra.dir,
            project: infra.project,
            container: container!,
        };
    },
    { timeout: 1_200_000 },
);

after(async () => {
    for (const site of [delta, infra]) {
        await site?.down();
    }
    await io.docker({ method: 'DELETE', path: `/networks/${INGRESS}` }).catch(() => undefined);
});

const sitesFile = (name: string) => join(infra.dir, 'caddy', 'sites', name);

test("a member's routes are written as the directory's owner, validated and loaded", async () => {
    await addRoutes(io, shared, delta.project, routes(delta.project, 'delta.test'));
    const file = sitesFile(`${delta.project}.caddy`);
    assert.ok(existsSync(file));
    const owner = statSync(join(infra.dir, 'caddy', 'sites'));
    assert.equal(statSync(file).uid, owner.uid);
    assert.ok(!existsSync(`${file}.new`));
    assert.ok((await servedHosts(io, shared.container!)).has('delta.test'));
});

test("the member's Ghost answers through the shared Caddy, by its alias on the shared network", async () => {
    const answer = await io.siteNetwork(
        [
            {
                ID: shared.container!.id,
                Service: 'caddy',
                State: 'running',
                Health: 'healthy',
                ExitCode: 0,
                Publishers: [],
            },
        ],
        ['caddy'],
        async (network) => {
            assert.equal(network.name, INGRESS);
            // Caddy issues its internal certificate in the background.
            for (let attempt = 0; ; attempt += 1) {
                try {
                    return await io.clients.https({
                        host: network.address('caddy')!.host,
                        port: 443,
                        servername: 'delta.test',
                        path: '/ghost/api/admin/site/',
                    });
                } catch (error) {
                    if (attempt === 30) {
                        throw error;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }
        },
    );
    assert.equal(answer.status, 200);
    assert.match(answer.body, /"url":"https:\/\/delta\.test\/"/);
});

test('a taken project or domain is refused before anything is written', async () => {
    const before = await routeFiles(io, shared.container!);
    await assert.rejects(
        refuseTaken(io, shared, delta.project, ['other.test']),
        (error: unknown) => error instanceof CliError && /already has routes/.test(error.message),
    );
    await assert.rejects(
        refuseTaken(io, shared, named('echo'), ['other.test', 'DELTA.test']),
        (error: unknown) =>
            error instanceof CliError && /already serves delta\.test/.test(error.message),
    );
    await refuseTaken(io, shared, named('echo'), ['echo.test']);
    assert.deepEqual(await routeFiles(io, shared.container!), before);
});

test('routes Caddy refuses are taken out again, and Caddy keeps serving', async () => {
    const project = named('broken');
    await assert.rejects(
        addRoutes(io, shared, project, 'broken.test {\n\treverse_proxy {\n'),
        (error: unknown) => error instanceof CliError && /does not accept/.test(error.message),
    );
    assert.ok(!existsSync(sitesFile(`${project}.caddy`)));
    assert.ok((await servedHosts(io, shared.container!)).has('delta.test'));
});

test('removing a member removes its routes, and Caddy reloads without them', async () => {
    await removeRoutes(io, shared, delta.project);
    assert.ok(!existsSync(sitesFile(`${delta.project}.caddy`)));
    assert.ok(!(await servedHosts(io, shared.container!)).has('delta.test'));
    // Already gone is not an error.
    await removeRoutes(io, shared, delta.project);
});
