import type { Owner, FileEntry, ContentMetadata, Checkpoint } from './types.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function durableJSON(file: string, value: unknown, owner?: Owner) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    if (owner) {
      fs.fchownSync(fd, ...owner);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  syncDirectory(path.dirname(file));
}

export function syncDirectory(dir: string) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function privateDirectory(dir: string, owner?: Owner) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error('Symlink directories are unsupported');
  }
  fs.chmodSync(dir, 0o700);
  if (owner) {
    fs.chownSync(dir, ...owner);
  }
}
// Deliberately no archive extraction: checkpoints are private directory trees.
// Refuse symlinks and special files, including dangling links, before copying.
export function inventory(root: string, prefix = ''): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const name of fs.readdirSync(path.join(root, prefix)).sort()) {
    const relative = path.join(prefix, name);
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      entries.push(...inventory(root, relative));
    } else if (stat.isFile() && stat.nlink === 1) {
      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(1024 * 1024);
      try {
        let bytes;
        while ((bytes = fs.readSync(fd, buf, 0, buf.length, null))) {
          hash.update(buf.subarray(0, bytes));
        }
      } finally {
        fs.closeSync(fd);
      }
      entries.push({ path: relative, bytes: stat.size, sha256: hash.digest('hex') });
    } else {
      throw new Error(`Unsupported link or special file: ${relative}`);
    }
  }
  return entries;
}

export function copyTree(source: string, target: string, owner: Owner | null = null) {
  const stat = fs.lstatSync(source);
  if (
    stat.isSymbolicLink() ||
    (!stat.isFile() && !stat.isDirectory()) ||
    (stat.isFile() && stat.nlink !== 1)
  ) {
    throw new Error('Checkpoint trees cannot contain links or special files');
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true, mode: stat.mode & 0o777 });
    for (const name of fs.readdirSync(source)) {
      copyTree(path.join(source, name), path.join(target, name), owner);
    }
  } else {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, stat.mode & 0o777);
    const fd = fs.openSync(target, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  fs.chownSync(target, ...(owner || ([stat.uid, stat.gid] as Owner)));
  if (stat.isDirectory()) {
    // mkdir's mode is filtered by the manager's private umask. Restore the
    // source permissions so service users can traverse their mounted config.
    fs.chmodSync(target, stat.mode & 0o777);
    syncDirectory(target);
  }
}

export function verifyCheckpoint(root: string): Checkpoint {
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.lstatSync(manifestPath).isFile()) {
    throw new Error('Missing checkpoint manifest');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Checkpoint;
  if (manifest.format !== 'ghost-docker-recovery' || manifest.version !== 1) {
    throw new Error('Unsupported checkpoint format');
  }
  const actual = inventory(path.join(root, 'payload'));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error('Checkpoint checksum mismatch');
  }
  return manifest;
}

export function checkSpace(dir: string, bytes: number) {
  const stat = fs.statfsSync(dir);
  if (stat.bavail * stat.bsize < bytes + 256 * 1024 * 1024) {
    throw new Error('Insufficient free space (including 256 MiB reserve)');
  }
}

export function retainCompleted(root: string, keep: number, protectedId: string) {
  if (!Number.isSafeInteger(keep) || keep < 1) {
    throw new Error('--keep must be a positive integer');
  }
  const complete = fs
    .readdirSync(root)
    .filter((name) => /^\d{4}-.*-[0-9a-f-]{36}$/.test(name))
    .filter((name) => {
      try {
        verifyCheckpoint(path.join(root, name));
        return true;
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
  for (const name of complete.slice(keep)) {
    if (name !== protectedId) {
      fs.rmSync(path.join(root, name), { recursive: true });
    }
  }
  syncDirectory(root);
}

export function treeMetadata(root: string, prefix = ''): ContentMetadata[] {
  const stat = fs.lstatSync(path.join(root, prefix));
  const result = [{ path: prefix, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 }];
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(path.join(root, prefix)).sort()) {
      result.push(...treeMetadata(root, path.join(prefix, name)));
    }
  }
  return result;
}

export function restoreMetadata(root: string, entries: ContentMetadata[]) {
  const paths = treeMetadata(root).map((e) => e.path);
  if (JSON.stringify(paths) !== JSON.stringify(entries.map((e) => e.path))) {
    throw new Error('Content metadata does not match the checkpoint tree');
  }
  for (const e of entries) {
    if (![e.uid, e.gid, e.mode].every((n) => Number.isInteger(n) && n >= 0) || e.mode > 0o777) {
      throw new Error('Invalid content ownership/mode');
    }
    fs.chownSync(path.join(root, e.path), e.uid, e.gid);
    fs.chmodSync(path.join(root, e.path), e.mode);
  }
}
