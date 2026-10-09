// The site as the real Compose resolves it and the real daemon runs it, and
// two directories that name one project.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { refuseMovedData } from '../../src/backup.ts';
import { CliError } from '../../src/errors.ts';
import { foreignProject } from '../../src/project.ts';
import { imageDrift, observeSite, resolveSite } from '../../src/resolved.ts';
import { makeSite, realIo, type TestSite } from './site.ts';

const io = realIo();
let owner: TestSite;
let other: TestSite;

before(
    async () => {
        owner = makeSite(io, 'owner', { profiles: 'local' });
        // Another directory, whose .env names the owner's project.
        other = makeSite(io, 'other', { profiles: 'local' });
        const path = join(other.dir, '.env');
        writeFileSync(path, readFileSync(path, 'utf8').replace(other.project, owner.project), {
            mode: 0o600,
        });
        for (const site of [owner, other]) {
            mkdirSync(join(site.dir, 'data', 'mysql'), { recursive: true });
            mkdirSync(join(site.dir, 'data', 'ghost'), { recursive: true });
        }
        await owner.up('db');
    },
    { timeout: 1_200_000 },
);

after(async () => {
    await owner?.down();
});

test('Compose resolves the data mounts, the network and the images', async () => {
    const resolved = await resolveSite(io, owner.dir);
    assert.equal(resolved.project, owner.project);
    assert.ok(
        resolved.services.db!.mounts.some(
            (mount) =>
                mount.type === 'bind' &&
                mount.source === join(owner.dir, 'data', 'mysql') &&
                mount.target === '/var/lib/mysql',
        ),
    );
    assert.deepEqual(resolved.services.db!.networks, [`${owner.project}_ghost_network`]);
    assert.match(resolved.services.db!.image ?? '', /^mysql:[^@]+@sha256:[0-9a-f]{64}$/);
    refuseMovedData(owner.facts(), resolved);
});

test('the daemon says what runs, and that it is what Compose resolves', async () => {
    const resolved = await resolveSite(io, owner.dir);
    const running = await observeSite(io, resolved);
    const db = running.find((each) => each.service === 'db');
    assert.equal(db?.state, 'running');
    assert.equal(db?.image, resolved.services.db!.image);
    assert.match(db?.imageId ?? '', /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(await imageDrift(io, resolved, running), []);
});

test('an override that mounts inside the content is seen, and refused', async () => {
    const site = makeSite(io, 'nested', {
        profiles: 'local',
        override:
            'services:\n  ghost:\n    ports: !reset []\n    volumes:\n      - /tmp:/home/ghost/content/images\n  caddy:\n    ports: !reset []\n',
    });
    const resolved = await resolveSite(io, site.dir);
    assert.throws(
        () => refuseMovedData(site.facts(), resolved),
        /mounts \/tmp at \/home\/ghost\/content\/images, inside \/home\/ghost\/content/,
    );
});

test("a directory naming another's project is refused, by the label Compose puts on its containers", async () => {
    assert.equal(await foreignProject(io, owner.project, owner.dir), null);
    assert.match(
        (await foreignProject(io, owner.project, other.dir)) ?? '',
        new RegExp(`belongs to ${owner.dir}`),
    );
    await assert.rejects(resolveSite(io, other.dir), (error) => error instanceof CliError);
});
