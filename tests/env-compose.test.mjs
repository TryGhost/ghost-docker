// Round trips edge-case values through Docker Compose into a real container.
//
// Comparing serializer output against expected strings is not enough: Compose
// interpolates env_file values, so the only proof is what the container sees.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, cleanup, writeEnv, compose, dockerAvailable } from './helpers.mjs';

const PROBE_IMAGE = process.env.GD_TEST_PROBE_IMAGE ?? 'alpine:3.20';

const VALUES = [
  'plain',
  'with spaces  ',
  'dollar $VAR',
  'braced ${VAR}',
  'double dollar $$',
  'lone dollar $',
  'double"quote',
  "single'quote",
  'back\\slash',
  "backslash quote \\'",
  '',
  '["a", "b"]',
  '{"k": "v", "n": [1, 2]}',
  'hash # not a comment',
  'line1\nline2',
  'tab\there',
  'trailing backslash \\',
  '-----BEGIN KEY-----\nabc/def+gh==\n-----END KEY-----',
];

describe('Compose round trip', { skip: dockerAvailable() ? false : 'docker is not available' }, () => {
  let dir;
  let seen;

  before(() => {
    dir = tempDir('env-compose');

    // A variable that must NOT leak into any value through interpolation.
    process.env.VAR = 'INTERPOLATED';

    const appEnv = join(dir, 'app.env');
    writeEnv(appEnv, Object.fromEntries(VALUES.map((v, i) => [`V${i}`, v])));

    // The probe script is mounted rather than inlined, so Compose never
    // interpolates the shell syntax that reads the values back.
    writeFileSync(
      join(dir, 'probe.sh'),
      ['#!/bin/sh', 'i=0', 'while [ "$i" -lt "$COUNT" ]; do',
        '    eval "v=\\${V$i}"',
        "    printf '%s' \"$v\" | base64 | tr -d '\\n'",
        "    printf '\\n'",
        '    i=$((i + 1))', 'done', ''].join('\n'),
      { mode: 0o755 },
    );

    writeFileSync(
      join(dir, 'compose.yml'),
      [
        'services:',
        '  probe:',
        '    image: ${GD_PROBE_IMAGE}',
        '    env_file:',
        '      - path: app.env',
        '        required: true',
        '    environment:',
        '      COUNT: ${COUNT}',
        '    volumes:',
        '      - ./probe.sh:/probe.sh:ro',
        '    command: ["sh", "/probe.sh"]',
        '',
      ].join('\n'),
    );

    // COUNT and the image come through Compose interpolation of `.env`, which
    // exercises the `.env` side of the same contract.
    writeEnv(join(dir, '.env'), { COUNT: String(VALUES.length), GD_PROBE_IMAGE: PROBE_IMAGE });

    const result = compose(dir, ['run', '--rm', '--no-deps', '-T', 'probe']);
    assert.equal(result.status, 0, result.stderr);
    seen = result.stdout.trim().split('\n').map((line) => Buffer.from(line.trim(), 'base64').toString());
  });

  after(() => {
    compose(dir, ['down', '-v', '--remove-orphans']);
    cleanup(dir);
  });

  VALUES.forEach((value, index) => {
    test(`the container sees value ${index} verbatim: ${JSON.stringify(value)}`, () => {
      assert.equal(seen[index], value);
    });
  });

  test('a .env value survives Compose interpolation into a service', () => {
    const tricky = `tricky $VAR \${VAR} "quoted" 'single' back\\slash # hash`;
    writeFileSync(
      join(dir, 'interp.yml'),
      [
        'services:',
        '  probe:',
        '    image: ${GD_PROBE_IMAGE}',
        '    environment:',
        '      ECHOED: ${TRICKY}',
        '    command: ["sh", "-c", "printf \'%s\' \\"$$ECHOED\\" | base64 | tr -d \'\\\\n\'"]',
        '',
      ].join('\n'),
    );
    writeEnv(join(dir, '.env'), {
      COUNT: String(VALUES.length),
      GD_PROBE_IMAGE: PROBE_IMAGE,
      TRICKY: tricky,
    });
    const result = compose(dir, ['-f', join(dir, 'interp.yml'), 'run', '--rm', '--no-deps', '-T', 'probe']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Buffer.from(result.stdout.trim(), 'base64').toString(), tricky);
  });
});
