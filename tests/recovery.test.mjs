import { test } from 'node:test';
import { run as runProcess } from '../manager/process.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  durableJSON,
  inventory,
  copyTree,
  privateDirectory,
  verifyCheckpoint,
  checkSpace,
  retainCompleted,
} from '../manager/storage.ts';
import { tempDir, cleanup, sh, shOk, q } from './helpers.mjs';

test('checkpoint copies preserve directory permissions under the manager umask', () => {
  const dir = tempDir();
  const source = path.join(dir, 'mysql-init');
  const checkpoint = path.join(dir, 'checkpoint');
  const restored = path.join(dir, 'restored');
  const previousMask = process.umask(0o077);
  try {
    fs.mkdirSync(source);
    fs.chmodSync(source, 0o755);
    fs.mkdirSync(path.join(source, 'nested'));
    fs.chmodSync(path.join(source, 'nested'), 0o750);
    fs.writeFileSync(path.join(source, 'init.sh'), '#!/bin/sh\n');
    fs.chmodSync(path.join(source, 'init.sh'), 0o755);
    privateDirectory(checkpoint);
    copyTree(source, path.join(checkpoint, 'mysql-init'));
    copyTree(path.join(checkpoint, 'mysql-init'), restored);
    for (const copied of [path.join(checkpoint, 'mysql-init'), restored]) {
      assert.equal(fs.statSync(copied).mode & 0o777, 0o755);
      assert.equal(fs.statSync(path.join(copied, 'nested')).mode & 0o777, 0o750);
      assert.equal(fs.statSync(path.join(copied, 'init.sh')).mode & 0o777, 0o755);
    }
    assert.equal(fs.statSync(checkpoint).mode & 0o777, 0o700);
  } finally {
    process.umask(previousMask);
    cleanup(dir);
  }
});

test('operation lock excludes another live process and recover cannot steal it', async () => {
  const dir = tempDir();
  const child = spawn(
    process.env.GD_TEST_BASH || 'bash',
    ['-c', `. scripts/lib/operation.sh; operation_acquire ${q(dir)}; echo ready; read -r done`],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  try {
    await once(child.stdout, 'data');
    assert.notEqual(sh(`operation_acquire ${q(dir)}`).status, 0);
    assert.notEqual(sh(`operation_acquire ${q(dir)} true`).status, 0);
    const ended = once(child, 'exit');
    child.stdin.end('\n');
    await ended;
    assert.notEqual(sh(`operation_acquire ${q(dir)}`).status, 0);
    shOk(`operation_acquire ${q(dir)} true; operation_release`);
    assert.equal(fs.existsSync(path.join(dir, '.ghost-operation-lock')), false);
  } finally {
    child.kill();
    cleanup(dir);
  }
});

test('unfinished journals block configuration writes and normal operations', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, '.ghost-operation.json'), '{}');
    assert.notEqual(sh(`operation_acquire ${q(dir)}`).status, 0);
    assert.equal(sh(`operation_acquire ${q(dir)} true; operation_release`).status, 0);
  } finally {
    cleanup(dir);
  }
});

test('checkpoint validation detects corruption, missing files and forbidden links', () => {
  const dir = tempDir();
  try {
    const payload = path.join(dir, 'payload');
    fs.mkdirSync(payload);
    fs.writeFileSync(path.join(payload, '.hidden'), 'asset');
    fs.mkdirSync(path.join(payload, 'empty'));
    durableJSON(path.join(dir, 'manifest.json'), {
      format: 'ghost-docker-recovery',
      version: 1,
      files: inventory(payload),
    });
    verifyCheckpoint(dir);
    fs.writeFileSync(path.join(payload, '.hidden'), 'corrupt');
    assert.throws(() => verifyCheckpoint(dir), /checksum/);
    fs.symlinkSync('/etc/passwd', path.join(payload, 'escape'));
    assert.throws(() => inventory(payload), /link/);
    assert.throws(() => copyTree(payload, path.join(dir, 'copy')), /link/);
  } finally {
    cleanup(dir);
  }
});

test('disk exhaustion leaves the previous durable journal readable', () => {
  const dir = tempDir();
  const file = path.join(dir, 'journal.json');
  const original = fs.writeFileSync;
  try {
    durableJSON(file, { phase: 'before' });
    fs.writeFileSync = () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    };
    assert.throws(() => durableJSON(file, { phase: 'after' }), /disk full/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { phase: 'before' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => checkSpace(dir, Number.MAX_SAFE_INTEGER), /free space/);
  } finally {
    fs.writeFileSync = original;
    cleanup(dir);
  }
});

test('retention preserves incomplete and corrupt checkpoints', () => {
  const dir = tempDir();
  try {
    const ids = [
      '2025-a-00000000-0000-0000-0000-000000000000',
      '2026-a-00000000-0000-0000-0000-000000000000',
    ];
    for (const id of ids) {
      fs.mkdirSync(path.join(dir, id, 'payload'), { recursive: true });
      durableJSON(path.join(dir, id, 'manifest.json'), {
        format: 'ghost-docker-recovery',
        version: 1,
        files: [],
      });
    }
    fs.mkdirSync(path.join(dir, '.partial-interrupted'));
    retainCompleted(dir, 1, ids[1]);
    assert.equal(fs.existsSync(path.join(dir, ids[0])), false);
    assert.equal(fs.existsSync(path.join(dir, ids[1])), true);
    assert.equal(fs.existsSync(path.join(dir, '.partial-interrupted')), true);
  } finally {
    cleanup(dir);
  }
});

test('SQL streaming propagates a producer or consumer failure despite partial output', async () => {
  const dir = tempDir();
  try {
    const dump = path.join(dir, 'database.sql');
    await assert.rejects(
      runProcess('sh', ['-c', 'printf "partial SQL"; exit 17'], { output: dump }),
      /exit 17/,
    );
    assert.equal(fs.readFileSync(dump, 'utf8'), 'partial SQL');
    await assert.rejects(
      runProcess('sh', ['-c', 'cat >/dev/null; exit 19'], { input: dump }),
      /exit 19/,
    );
    assert.equal(fs.existsSync(path.join(dir, 'manifest.json')), false);
  } finally {
    cleanup(dir);
  }
});

test('a manager lock cannot be reclaimed through a different Docker daemon', () => {
  const dir = tempDir();
  try {
    const lock = path.join(dir, '.ghost-operation-lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), '2147483647');
    fs.writeFileSync(path.join(lock, 'manager'), 'still-working');
    fs.writeFileSync(path.join(lock, 'daemon'), 'daemon-a');
    const result = sh(`docker() { printf daemon-b; }; operation_acquire ${q(dir)} true`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /daemon that owns/);
    assert.equal(fs.readFileSync(path.join(lock, 'manager'), 'utf8'), 'still-working');
  } finally {
    cleanup(dir);
  }
});

test('journal publication racing with lock acquisition still blocks mutation', () => {
  const dir = tempDir();
  try {
    const result = sh(
      `mkdir() { command mkdir "$@" && printf '{}' >${q(path.join(dir, '.ghost-operation.json'))}; }; operation_acquire ${q(dir)}`,
    );
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(dir, '.ghost-operation-lock')), false);
  } finally {
    cleanup(dir);
  }
});
