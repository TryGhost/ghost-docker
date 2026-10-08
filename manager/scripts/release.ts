// Cuts and describes releases of the stack, for the release workflows. Run by
// Node directly, which strips the types; the rules are manager/src/release.ts.
//
//   node manager/scripts/release.ts cut [--bump auto|patch|minor|major] [--stable] [--dry-run]
//       Tag the next release at HEAD and push the tag. Every release is a beta
//       unless --stable. Prints the tag, and writes `tag=` to $GITHUB_OUTPUT.
//   node manager/scripts/release.ts moving vX.Y.Z[-beta.N]
//       The moving image tags (stable, beta) the release takes: the channels
//       on which it is the newest release.
//   node manager/scripts/release.ts notes vX.Y.Z[-beta.N]
//       Its release notes, from the commits since the release before it.
//
// Like Ghost's and Ghost-CLI's release scripts, the bump is worked out from
// the commits since the last release: a ✨ feature makes it a minor, and
// anything else, a dependency update included, a patch.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
    BUMPS,
    compareReleases,
    isRelease,
    movingTags,
    newest,
    nextRelease,
    parseRelease,
    releaseNotes,
    resolveBump,
    type Bump,
} from '../src/release.ts';

/** git in the checkout the script is run from. */
const git = (...args: string[]): string =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const log = (message: string) => process.stderr.write(`  ${message}\n`);

const releaseTags = (): string[] => git('tag', '--list', 'v*').split('\n').filter(isRelease);

/** One line per commit on the mainline, `%s` or the given format. */
const commits = (range: string | null, format = '%s'): string[] =>
    git(
        'log',
        '--first-parent',
        '--no-merges',
        `--pretty=tformat:${format}`,
        ...(range ? [range] : ['HEAD']),
    )
        .split('\n')
        .filter(Boolean);

/** The release before `tag`: the newest older one, and for a release, the newest older release. */
function previousRelease(tag: string): string | null {
    const release = parseRelease(tag)!;
    const older = releaseTags().filter((other) => {
        const candidate = parseRelease(other)!;
        return (
            compareReleases(candidate, release) < 0 &&
            (release.beta !== null || candidate.beta === null)
        );
    });
    return newest(older, release.beta === null ? 'stable' : 'beta');
}

function cut(args: string[]): void {
    const { values } = parseArgs({
        args,
        options: {
            bump: { type: 'string', default: 'auto' },
            stable: { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
        },
        strict: true,
    });
    if (!(BUMPS as readonly string[]).includes(values.bump)) {
        throw new Error(`--bump must be one of ${BUMPS.join(', ')}: got ${values.bump}`);
    }
    if (git('status', '--porcelain') !== '') {
        throw new Error('the working tree is not clean');
    }
    const tags = releaseTags();
    const base = newest(tags, 'beta');
    log(`Last release: ${base ?? 'none'}`);
    const since = commits(base === null ? null : `${base}..HEAD`);
    if (since.length === 0) {
        throw new Error(`no commits since ${base}: nothing to release`);
    }
    const bump = resolveBump(since, values.bump as Bump);
    log(`${since.length} commit(s) since then: a ${bump} release`);
    const tag = nextRelease(tags, bump, !values.stable);
    log(`Next release: ${tag}`);
    if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`) !== '') {
        throw new Error(`${tag} already exists on the remote`);
    }
    git('tag', '--annotate', tag, '--message', tag);
    if (values['dry-run']) {
        log(`Dry run: ${tag} was tagged here and not pushed`);
    } else {
        git('push', 'origin', `refs/tags/${tag}`);
        log(`Pushed ${tag}`);
    }
    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
    }
    process.stdout.write(`${tag}\n`);
}

function main(): void {
    const [command = '', ...args] = process.argv.slice(2);
    const tag = args[0] ?? '';
    switch (command) {
        case 'cut':
            return cut(args);
        case 'moving':
            if (!isRelease(tag)) {
                throw new Error('usage: release.ts moving vX.Y.Z[-beta.N]');
            }
            for (const channel of movingTags(tag, releaseTags())) {
                process.stdout.write(`${channel}\n`);
            }
            return;
        case 'notes': {
            if (!isRelease(tag)) {
                throw new Error('usage: release.ts notes vX.Y.Z[-beta.N]');
            }
            const previous = previousRelease(tag);
            const lines = commits(previous === null ? tag : `${previous}..${tag}`, '* %s - %an');
            process.stdout.write(releaseNotes(lines, previous, tag));
            return;
        }
        default:
            throw new Error('usage: release.ts cut|moving|notes ...');
    }
}

try {
    main();
} catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    process.exit(1);
}
