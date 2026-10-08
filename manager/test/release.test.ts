// Release tags, their order, and the moving tags a new release takes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
    channelOf,
    compareReleases,
    movingTags,
    newest,
    nextRelease,
    NO_NOTES,
    parseRelease,
    releaseNotes,
    resolveBump,
} from '../src/release.ts';
import { REPO } from './site.ts';

const TAGS = ['v1.9.0', 'v1.10.0', 'v1.11.0-beta.2', 'v1.11.0-beta.10', 'v0.1.0', 'not-a-release'];

describe('release tags', () => {
    test('only vX.Y.Z and vX.Y.Z-beta.N are releases', () => {
        for (const tag of ['v0.1.0', 'v1.2.3', 'v0.1.0-beta.1', 'v10.20.30-beta.40']) {
            assert.ok(parseRelease(tag), tag);
        }
        for (const tag of [
            '1.2.3',
            'v1.2',
            'v1.2.3-rc.1',
            'v1.2.3-beta',
            'v1.2.3-beta.1.2',
            'v01.2.3',
            'v1.2.3-beta.01',
            'v1.2.3+build',
            'edge',
            'stable',
            ' v1.2.3',
        ]) {
            assert.equal(parseRelease(tag), null, tag);
        }
    });

    test('they are ordered by number, not lexically', () => {
        const order = (a: string, b: string) => compareReleases(parseRelease(a)!, parseRelease(b)!);
        assert.ok(order('v1.10.0', 'v1.9.0') > 0);
        assert.ok(order('v1.0.0-beta.10', 'v1.0.0-beta.2') > 0);
        assert.ok(order('v1.0.0', 'v1.0.0-beta.10') > 0);
        assert.ok(order('v1.0.1-beta.1', 'v1.0.0') > 0);
        assert.ok(order('v2.0.0-beta.1', 'v1.99.99') > 0);
        assert.equal(order('v1.2.3', 'v1.2.3'), 0);
        assert.deepEqual(
            ['v1.0.0', 'v1.0.0-beta.10', 'v0.9.0', 'v1.0.0-beta.2', 'v1.10.0', 'v1.9.0']
                .map((tag) => parseRelease(tag)!)
                .sort(compareReleases)
                .map((release) => release.tag),
            ['v0.9.0', 'v1.0.0-beta.2', 'v1.0.0-beta.10', 'v1.0.0', 'v1.9.0', 'v1.10.0'],
        );
    });

    test('stable selects the newest release and ignores betas', () => {
        assert.equal(newest(TAGS, 'stable'), 'v1.10.0');
    });

    test('beta also considers betas, in numeric order', () => {
        assert.equal(newest(TAGS, 'beta'), 'v1.11.0-beta.10');
    });

    test('a release outranks its own betas on the beta channel', () => {
        assert.equal(newest([...TAGS, 'v1.11.0'], 'beta'), 'v1.11.0');
    });

    test('no releases is no answer, not a guess', () => {
        assert.equal(newest(['edge', 'not-a-release'], 'beta'), null);
        assert.equal(newest(['v1.0.0-beta.1'], 'stable'), null);
    });

    test('the channel comes from the version the image carries', () => {
        assert.equal(channelOf('v1.2.3'), 'stable');
        assert.equal(channelOf('v1.2.3-beta.4'), 'beta');
        assert.equal(channelOf('edge-abc1234'), 'edge');
        assert.equal(channelOf('dev'), null);
        assert.equal(channelOf('checkout'), null);
    });
});

describe('moving tags', () => {
    test('a new beta newer than everything moves beta only', () => {
        assert.deepEqual(movingTags('v1.11.0-beta.11', TAGS), ['beta']);
    });

    test('a new release newer than everything moves both', () => {
        assert.deepEqual(movingTags('v1.11.0', TAGS), ['stable', 'beta']);
    });

    test('a patch to an older line moves stable, but not past a newer beta', () => {
        assert.deepEqual(movingTags('v1.10.1', TAGS), ['stable']);
    });

    test('a release older than the newest on each channel moves nothing', () => {
        assert.deepEqual(movingTags('v1.9.1', TAGS), []);
        assert.deepEqual(movingTags('v1.11.0-beta.3', TAGS), []);
    });

    test('the first release of all moves its channels', () => {
        assert.deepEqual(movingTags('v0.1.0-beta.1', []), ['beta']);
    });

    test('a tag that is not a release moves nothing', () => {
        assert.deepEqual(movingTags('edge', TAGS), []);
    });
});

describe('the next release', () => {
    test('a ✨ feature is a minor; anything else, dependency updates included, a patch', () => {
        assert.equal(
            resolveBump(['Fixed a thing', 'Updated ghost/traffic-analytics to v1.0.456'], 'auto'),
            'patch',
        );
        assert.equal(
            resolveBump(['chore(deps): update mysql docker tag to v8.0.44'], 'auto'),
            'patch',
        );
        assert.equal(
            resolveBump(['Fixed a thing', '✨ Added ghost-docker update'], 'auto'),
            'minor',
        );
        assert.equal(resolveBump(['✨ Added ghost-docker update'], 'patch'), 'patch');
        assert.equal(resolveBump([], 'major'), 'major');
    });

    test('the first release of all is v0.1.0-beta.1', () => {
        assert.equal(nextRelease([], 'patch', true), 'v0.1.0-beta.1');
        assert.equal(nextRelease(['edge', 'not-a-release'], 'minor', true), 'v0.1.0-beta.1');
        assert.equal(nextRelease([], 'patch', false), 'v0.1.0');
    });

    test('betas count up toward the version they lead to', () => {
        assert.equal(nextRelease(['v0.1.0-beta.1'], 'patch', true), 'v0.1.0-beta.2');
        assert.equal(nextRelease(['v0.1.0-beta.1'], 'minor', true), 'v0.1.0-beta.2');
        assert.equal(
            nextRelease(['v0.1.0-beta.9', 'v0.1.0-beta.10'], 'patch', true),
            'v0.1.0-beta.11',
        );
        assert.equal(nextRelease(['v0.1.0-beta.4'], 'major', true), 'v1.0.0-beta.1');
    });

    test('a release promotes the betas before it', () => {
        assert.equal(nextRelease(['v0.1.0-beta.4'], 'patch', false), 'v0.1.0');
        assert.equal(nextRelease(['v0.1.0-beta.4'], 'major', false), 'v1.0.0');
    });

    test('after a release, the bump is from it', () => {
        const tags = ['v0.1.0-beta.4', 'v0.1.0'];
        assert.equal(nextRelease(tags, 'patch', true), 'v0.1.1-beta.1');
        assert.equal(nextRelease(tags, 'minor', true), 'v0.2.0-beta.1');
        assert.equal(nextRelease(tags, 'patch', false), 'v0.1.1');
        assert.equal(nextRelease([...tags, 'v0.2.0-beta.1'], 'patch', true), 'v0.2.0-beta.2');
        assert.equal(nextRelease([...tags, 'v0.2.0-beta.1'], 'patch', false), 'v0.2.0');
        assert.equal(nextRelease(['v1.9.0', 'v1.10.0'], 'patch', false), 'v1.10.1');
    });
});

describe('release notes', () => {
    test('only commits with a release-note emoji, most significant first', () => {
        const notes = releaseNotes(
            [
                '* 🐛 Fixed update keeping a stale lock - Ada',
                '* Refactored the manager - Ada',
                '* ✨ Added ghost-docker update - Grace',
                '* chore(deps): update mysql - renovate[bot]',
                '* 🔒 Kept credentials out of logs - Ada',
                '* ✨ Added ghost-docker update - Grace',
            ],
            'v0.1.0-beta.1',
            'v0.1.0-beta.2',
        );
        assert.equal(
            notes,
            [
                '* 🔒 Kept credentials out of logs - Ada',
                '* ✨ Added ghost-docker update - Grace',
                '* 🐛 Fixed update keeping a stale lock - Ada',
                '',
                '---',
                '',
                'View the changelog for full details: https://github.com/TryGhost/ghost-docker/compare/v0.1.0-beta.1...v0.1.0-beta.2',
                '',
            ].join('\n'),
        );
    });

    test('with none, the standard sentence', () => {
        assert.match(
            releaseNotes(['* Fixed a typo - Ada'], null, 'v0.1.0-beta.1'),
            new RegExp(`^${NO_NOTES}`),
        );
        assert.match(releaseNotes([], null, 'v0.1.0-beta.1'), /commits\/v0\.1\.0-beta\.1\n$/);
    });
});

describe('scripts/release.ts', () => {
    const script = join(REPO, 'manager', 'scripts', 'release.ts');
    let work: string;
    let checkout: string;
    const git = (...args: string[]) =>
        execFileSync(
            'git',
            ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
            {
                cwd: checkout,
                encoding: 'utf8',
            },
        ).trim();
    const commit = (message: string) => {
        writeFileSync(join(checkout, 'file'), message);
        git('add', 'file');
        git('commit', '--quiet', '--message', message);
    };
    const release = (...args: string[]) =>
        execFileSync(process.execPath, [script, ...args], {
            cwd: checkout,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            // The tag is annotated, so it needs an identity, which a CI
            // runner has none of; the Release workflow sets its own.
            env: {
                ...process.env,
                GITHUB_OUTPUT: '',
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_AUTHOR_NAME: 'Test',
                GIT_AUTHOR_EMAIL: 'test@example.com',
                GIT_COMMITTER_NAME: 'Test',
                GIT_COMMITTER_EMAIL: 'test@example.com',
            },
        });

    // A checkout with its own origin, so that tags can be pushed.
    test.beforeEach(() => {
        work = realpathSync(mkdtempSync(join(tmpdir(), 'gd-release-')));
        checkout = join(work, 'checkout');
        execFileSync('git', ['init', '--quiet', '--bare', join(work, 'origin.git')]);
        execFileSync('git', ['init', '--quiet', checkout]);
        git('remote', 'add', 'origin', join(work, 'origin.git'));
    });
    test.afterEach(() => rmSync(work, { recursive: true, force: true }));

    test('cuts the first beta, then a minor for a feature, and pushes the tags', () => {
        commit('Added the foundation');
        assert.equal(release('cut'), 'v0.1.0-beta.1\n');
        commit('Updated mysql to v8.0.44');
        assert.equal(release('cut'), 'v0.1.0-beta.2\n');
        assert.throws(() => release('cut'), /nothing to release/);
        commit('✨ Added ghost-docker update');
        assert.equal(release('cut', '--stable'), 'v0.1.0\n');
        commit('✨ Added backups');
        assert.equal(release('cut'), 'v0.2.0-beta.1\n');
        assert.deepEqual(
            execFileSync('git', ['ls-remote', '--tags', '--refs', join(work, 'origin.git')], {
                encoding: 'utf8',
            })
                .trim()
                .split('\n')
                .map((line) => line.split('refs/tags/')[1])
                .sort(),
            ['v0.1.0', 'v0.1.0-beta.1', 'v0.1.0-beta.2', 'v0.2.0-beta.1'],
        );
        assert.equal(release('moving', 'v0.2.0-beta.1'), 'beta\n');
        assert.equal(release('moving', 'v0.1.0'), 'stable\n');
        assert.match(release('notes', 'v0.2.0-beta.1'), /^\* ✨ Added backups - Test\n\n---/);
        assert.match(release('notes', 'v0.1.0'), /^\* ✨ Added ghost-docker update - Test\n/);
    });

    test('a dry run tags locally and pushes nothing', () => {
        commit('Added the foundation');
        assert.equal(release('cut', '--dry-run'), 'v0.1.0-beta.1\n');
        assert.equal(git('tag', '--list'), 'v0.1.0-beta.1');
        assert.equal(
            execFileSync('git', ['ls-remote', '--tags', join(work, 'origin.git')], {
                encoding: 'utf8',
            }),
            '',
        );
    });
});
