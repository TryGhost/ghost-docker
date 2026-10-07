// The dotenv encoder and parser. These values are exactly the ones Compose
// gets wrong if the encoding is naive; tests/e2e/install.sh sends the same
// ones through real containers.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as env from '../src/env.ts';

const TRICKY: Record<string, string> = {
    plain: 'plain',
    padded: '  leading and trailing  ',
    dollar: 'dollar $VAR and ${VAR} and $$ and $',
    doubleQuote: 'double"quote',
    singleQuote: "single'quote",
    backslash: 'back\\slash',
    backslashBeforeQuote: "backslash before quote: \\'",
    backslashBeforeDouble: 'backslash before double: \\"',
    backslashN: 'not a newline: \\n',
    empty: '',
    jsonArray: '["a", "b", 1, null]',
    jsonObject: '{"nested": {"k": "v"}}',
    hash: 'hash # not a comment',
    multiline: 'line1\nline2\nline3',
    tab: 'tab\tseparated',
    carriage: 'carriage\rreturn',
    unicode: 'unicode: héllo — ✓',
    trailingBackslash: 'trailing backslash \\',
    pem: '-----BEGIN KEY-----\nabc/def+gh==\n-----END KEY-----',
};

describe('round trip', () => {
    let text = '';
    for (const [key, value] of Object.entries(TRICKY)) {
        text = env.set(text, key, value);
    }

    for (const [key, value] of Object.entries(TRICKY)) {
        test(`${key} reads back exactly`, () => {
            assert.equal(env.get(text, key), value);
        });
    }

    test('one double-quoted line per key, in order, with nothing Compose would interpolate', () => {
        const lines = text.trimEnd().split('\n');
        assert.equal(lines.length, Object.keys(TRICKY).length);
        assert.ok(lines.every((line) => /^[A-Za-z_][A-Za-z0-9_]*="/.test(line)));
        assert.deepEqual(env.keys(text), Object.keys(TRICKY));
        assert.deepEqual(env.lint(text), []);
    });

    test('a dollar is doubled, which is what Compose reads as one', () => {
        assert.equal(env.serialize('A', 'Pa$$w0rd!'), 'A="Pa$$$$w0rd!"');
        assert.equal(env.serialize('A', 's3cr$t!'), 'A="s3cr$$t!"');
    });
});

describe('editing', () => {
    test('a value is replaced in place, keeping comments and blank lines around it', () => {
        const before = '# a leading comment\nA="one"\n\n# a comment about B\nB="two"\n';
        const after = env.set(before, 'B', 'changed');
        assert.equal(after, '# a leading comment\nA="one"\n\n# a comment about B\nB="changed"\n');
        assert.equal(env.set(after, 'C', 'new'), `${after}C="new"\n`);
    });

    test('a missing key is distinguished from an empty value', () => {
        assert.equal(env.get('A=""\n', 'A'), '');
        assert.equal(env.get('A=""\n', 'B'), undefined);
    });

    test('an invalid key is refused', () => {
        assert.throws(() => env.set('', 'not-valid', 'x'), /not a valid variable name/);
        assert.throws(() => env.set('', '1X', 'x'), /not a valid variable name/);
    });
});

describe('formats it did not write', () => {
    const foreign = [
        'UNQUOTED=hello world',
        'UNQUOTED_COMMENT=value # trailing comment',
        "SINGLE='literal $NOPE'",
        "SINGLE_ESC='it\\'s here'",
        'DOUBLE="escaped \\$LITERAL"',
        'DOUBLED="doubled $$LITERAL"',
        'export EXPORTED="yes"',
        '  INDENTED="ok"',
        'SPACED= "after the equals"',
        'DUP="one"',
        'DUP="two"',
        'not an assignment',
        '# COMMENTED="no"',
    ].join('\n');

    const cases: Record<string, string> = {
        UNQUOTED: 'hello world',
        UNQUOTED_COMMENT: 'value',
        SINGLE: 'literal $NOPE',
        SINGLE_ESC: "it's here",
        DOUBLE: 'escaped $LITERAL',
        DOUBLED: 'doubled $LITERAL',
        EXPORTED: 'yes',
        INDENTED: 'ok',
        SPACED: 'after the equals',
        DUP: 'two',
    };
    for (const [key, expected] of Object.entries(cases)) {
        test(key, () => assert.equal(env.get(foreign, key), expected));
    }

    test('comments and other lines are not keys', () => {
        assert.equal(env.get(foreign, 'COMMENTED'), undefined);
        assert.ok(!env.keys(foreign).includes('not'));
    });
});

describe('a value whose quotes span several lines', () => {
    const text = [
        'BEFORE="a"',
        'PEM="-----BEGIN',
        'INSIDE="not a key"',
        '-----END"',
        'AFTER="b"',
        '',
    ].join('\n');

    test('the keys around it are read, and its body is not mistaken for one', () => {
        assert.deepEqual(env.keys(text), ['BEFORE', 'AFTER']);
        assert.equal(env.get(text, 'AFTER'), 'b');
        assert.equal(env.get(text, 'INSIDE'), undefined);
    });

    test('reading or writing it fails with a message to edit it by hand', () => {
        assert.throws(() => env.get(text, 'PEM'), /spans several lines; edit it by hand/);
        assert.throws(() => env.set(text, 'PEM', 'x'), /spans several lines/);
    });

    test('other keys in the file are still editable, and it is left as it was', () => {
        const after = env.set(text, 'AFTER', 'changed');
        assert.match(after, /PEM="-----BEGIN\nINSIDE="not a key"\n-----END"/);
        assert.equal(env.get(after, 'AFTER'), 'changed');
    });

    test('it does not trip the interpolation lint', () => {
        assert.deepEqual(env.lint(text), []);
    });
});

describe('lint', () => {
    test('flags values Compose would interpolate, and nothing else', () => {
        const text = [
            'BARE="s3cr$t"',
            'BRACED=${HOME}',
            'DOUBLED="Pa$$w0rd"',
            'ESCAPED="a\\$b"',
            "SINGLE='a$b'",
            'NONE="plain"',
        ].join('\n');
        assert.deepEqual(env.lint(text), ['BARE', 'BRACED']);
    });
});

test('an env file is data: nothing in it is ever run', () => {
    const text = 'CMD="$(touch /tmp/ghost-docker-env-test-pwned)"\nTICK=`id`\n';
    assert.equal(env.get(text, 'CMD'), '$(touch /tmp/ghost-docker-env-test-pwned)');
    assert.equal(env.get(text, 'TICK'), '`id`');
});
