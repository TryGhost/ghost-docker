// Release tags as the manager reads them: which are releases, their order,
// and the channel a version is on. Cutting releases is tested in scripts/.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { channelOf, compareReleases, isRelease } from '../src/release.ts';

describe('release tags', () => {
    test('only vX.Y.Z and vX.Y.Z-beta.N are releases', () => {
        for (const tag of ['v0.1.0', 'v1.2.3', 'v0.1.0-beta.1', 'v10.20.30-beta.40']) {
            assert.ok(isRelease(tag), tag);
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
            assert.ok(!isRelease(tag), tag);
        }
    });

    test('they are ordered by number, not lexically', () => {
        assert.ok(compareReleases('v1.10.0', 'v1.9.0') > 0);
        assert.ok(compareReleases('v1.0.0-beta.10', 'v1.0.0-beta.2') > 0);
        assert.ok(compareReleases('v1.0.0', 'v1.0.0-beta.10') > 0);
        assert.ok(compareReleases('v1.0.1-beta.1', 'v1.0.0') > 0);
        assert.ok(compareReleases('v2.0.0-beta.1', 'v1.99.99') > 0);
        assert.equal(compareReleases('v1.2.3', 'v1.2.3'), 0);
        assert.deepEqual(
            ['v1.0.0', 'v1.0.0-beta.10', 'v0.9.0', 'v1.0.0-beta.2', 'v1.10.0', 'v1.9.0'].sort(
                compareReleases,
            ),
            ['v0.9.0', 'v1.0.0-beta.2', 'v1.0.0-beta.10', 'v1.0.0', 'v1.9.0', 'v1.10.0'],
        );
    });

    test('the channel comes from the version the image carries', () => {
        assert.equal(channelOf('v1.2.3'), 'stable');
        assert.equal(channelOf('v1.2.3-beta.4'), 'beta');
        assert.equal(channelOf('edge-abc1234'), 'edge');
        assert.equal(channelOf('dev'), null);
        assert.equal(channelOf('checkout'), null);
    });
});
