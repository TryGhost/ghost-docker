// The dotenv serializer and parser in scripts/lib/env.sh.
//
// These values are exactly the ones Compose gets wrong if the encoding is
// naive: interpolation markers, quotes, backslashes and newlines.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, cleanup, sh, shOk, shSucceeds, shValue, q } from './helpers.mjs';

const VALUES = {
  plain: 'plain',
  padded: '  leading and trailing  ',
  dollar: 'dollar $VAR and ${VAR} and $$ and $',
  doubleQuote: 'double"quote',
  singleQuote: "single'quote",
  backslash: 'back\\slash',
  backslashBeforeQuote: "backslash before quote: \\'",
  backslashBeforeDouble: 'backslash before double: \\"',
  empty: '',
  jsonArray: '["a", "b", 1, null]',
  jsonObject: '{"nested": {"k": "v"}}',
  hash: 'hash # not a comment',
  multiline: 'line1\nline2\nline3',
  tab: 'tab\tseparated',
  unicode: 'unicode: héllo — ✓',
  trailingBackslash: 'trailing backslash \\',
  pem: '-----BEGIN KEY-----\nabc/def+gh==\n-----END KEY-----',
};

describe('env.sh', () => {
  let dir;
  let file;

  before(() => {
    dir = tempDir('env');
    file = join(dir, 'round.env');
    writeFileSync(file, '');
    for (const [key, value] of Object.entries(VALUES)) {
      shOk(`env_set ${q(file)} ${q(key)} ${q(value)}`);
    }
  });
  after(() => cleanup(dir));

  for (const [key, value] of Object.entries(VALUES)) {
    test(`round trips ${key}`, () => {
      assert.equal(shValue(`env_get ${q(file)} ${q(key)}`).replace(/\n$/, ''), value);
    });
  }

  test('writes one line per key', () => {
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, Object.keys(VALUES).length);
    assert.ok(lines.every((l) => /^[A-Za-z_][A-Za-z0-9_]*="/.test(l)));
  });

  test('lists every key once, in order', () => {
    const keys = shOk(`env_keys ${q(file)}`).trim().split('\n');
    assert.deepEqual(keys, Object.keys(VALUES));
  });

  test('overwrites in place without duplicating', () => {
    shOk(`env_set ${q(file)} plain replaced`);
    assert.equal(shValue(`env_get ${q(file)} plain`).trim(), 'replaced');
    assert.equal(shOk(`env_keys ${q(file)}`).trim().split('\n').length, Object.keys(VALUES).length);
    assert.equal(shOk(`env_keys ${q(file)}`).trim().split('\n')[0], 'plain');
  });

  test('preserves comments and blank lines around an edit', () => {
    const commented = join(dir, 'comments.env');
    writeFileSync(commented, '# a leading comment\nA="one"\n\n# a comment about B\nB="two"\n');
    shOk(`env_set ${q(commented)} B changed`);
    const text = readFileSync(commented, 'utf8');
    assert.match(text, /# a comment about B/);
    assert.equal(shValue(`env_get ${q(commented)} B`).trim(), 'changed');

    shOk(`env_unset ${q(commented)} A`);
    assert.ok(!shSucceeds(`env_get ${q(commented)} A`));
    assert.match(readFileSync(commented, 'utf8'), /B="changed"/);
  });

  describe('reading formats it did not write', () => {
    let foreign;
    before(() => {
      foreign = join(dir, 'foreign.env');
      writeFileSync(
        foreign,
        [
          'UNQUOTED=hello world',
          'UNQUOTED_COMMENT=value # trailing comment',
          "SINGLE='literal $NOPE'",
          "SINGLE_ESC='it\\'s here'",
          'DOUBLE="escaped \\$LITERAL"',
          'export EXPORTED="yes"',
          'MULTILINE="first\nsecond"',
          'DUP="one"',
          'DUP="two"',
        ].join('\n') + '\n',
      );
    });

    const cases = {
      UNQUOTED: 'hello world',
      UNQUOTED_COMMENT: 'value',
      // Single quotes are literal: no interpolation, only \' is an escape.
      SINGLE: 'literal $NOPE',
      SINGLE_ESC: "it's here",
      // Double quotes interpolate, so \$ and $$ both mean a literal dollar.
      DOUBLE: 'escaped $LITERAL',
      EXPORTED: 'yes',
      // The last assignment wins, matching Compose.
      DUP: 'two',
    };

    for (const [key, expected] of Object.entries(cases)) {
      test(key, () => {
        assert.equal(shValue(`env_get ${q(foreign)} ${key}`).replace(/\n$/, ''), expected);
      });
    }
  });

  describe('values spanning several lines', () => {
    // Valid dotenv, never written by these helpers, and not editable through
    // them. What matters is that such a file still parses cleanly around the
    // multi-line value rather than being corrupted or mis-read.
    let pemFile;
    before(() => {
      pemFile = join(dir, 'pem.env');
      writeFileSync(
        pemFile,
        [
          'mail__transport="SMTP"',
          'TLS_KEY="-----BEGIN KEY-----',
          'MIIEvQIBADANBg==',
          '-----END KEY-----"',
          'labs__publicAPI="true"',
          '',
        ].join('\n'),
      );
    });

    test('keys around it are still listed, and its body is not mistaken for one', () => {
      assert.deepEqual(shOk(`env_keys ${q(pemFile)}`).trim().split('\n'), [
        'mail__transport',
        'TLS_KEY',
        'labs__publicAPI',
      ]);
    });

    test('reading it fails with an actionable message', () => {
      const result = sh(`env_get ${q(pemFile)} TLS_KEY`);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr.toString(), /spans several lines; edit it by hand/);
    });

    test('writing it is refused rather than corrupting the file', () => {
      const before = readFileSync(pemFile, 'utf8');
      const result = sh(`env_set ${q(pemFile)} TLS_KEY replaced`);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr.toString(), /spans several lines/);
      assert.equal(readFileSync(pemFile, 'utf8'), before, 'the file was modified');
    });

    test('other keys in the same file are still editable', () => {
      shOk(`env_set ${q(pemFile)} mail__transport Direct`);
      assert.equal(shValue(`env_get ${q(pemFile)} mail__transport`).trim(), 'Direct');
      assert.match(readFileSync(pemFile, 'utf8'), /MIIEvQIBADANBg==/);
    });

    test('it does not trip the interpolation lint', () => {
      assert.ok(shSucceeds(`env_lint ${q(pemFile)}`));
    });
  });

  test('distinguishes a missing key from an empty value', () => {
    shOk(`env_set ${q(file)} PRESENT_BUT_EMPTY ''`);
    assert.ok(!shSucceeds(`env_get ${q(file)} NOPE`), 'a missing key must fail');
    assert.ok(shSucceeds(`env_get ${q(file)} PRESENT_BUT_EMPTY`), 'an empty value must succeed');
    assert.equal(shValue(`env_get ${q(file)} PRESENT_BUT_EMPTY`), '\n');
    shOk(`env_unset ${q(file)} PRESENT_BUT_EMPTY`);
  });

  test('rejects an invalid key', () => {
    // Through the public API: the serializer is internal until S2 needs it.
    assert.ok(!shSucceeds(`env_set ${q(file)} 'bad-key' value`));
    assert.ok(!shSucceeds(`env_get ${q(file)} 'bad-key'`));
  });

  test('never evaluates an env file', () => {
    const evil = join(dir, 'evil.env');
    const marker = join(dir, 'pwned');
    writeFileSync(evil, `EVIL="$(touch ${marker})"\nBACKTICK=\`touch ${marker}\`\n`);
    sh(`env_get ${q(evil)} EVIL; env_keys ${q(evil)}; env_set ${q(evil)} OTHER value`);
    assert.ok(!existsSync(marker), 'command substitution in an env file was executed');
  });

  describe('env_lint', () => {
    let lintFile;
    before(() => {
      lintFile = join(dir, 'lint.env');
      writeFileSync(
        lintFile,
        ['GOOD="$$literal"', "ALSO_GOOD='$literal'", 'BAD="costs $5"', 'BAD_UNQUOTED=costs $5'].join('\n') + '\n',
      );
    });

    test('flags values Compose would interpolate', () => {
      const result = sh(`env_lint ${q(lintFile)}`);
      assert.notEqual(result.status, 0);
      const out = result.stdout.toString();
      assert.match(out, /^BAD:/m);
      assert.match(out, /^BAD_UNQUOTED:/m);
      assert.doesNotMatch(out, /^GOOD:/m);
      assert.doesNotMatch(out, /^ALSO_GOOD:/m);
    });

    test('passes on generated files', () => {
      assert.ok(shSucceeds(`env_lint ${q(file)}`));
    });
  });
});
