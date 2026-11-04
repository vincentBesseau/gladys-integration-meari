import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writableDir } from '../src/history.js';

test('writableDir returns the directory when it is writable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meari-'));
  try {
    assert.equal(writableDir(dir), dir);
    assert.ok(existsSync(join(dir, 'images')), 'the images subdir is created');
    assert.ok(!readdirSync(dir).includes('.write-test'), 'the probe file is cleaned up');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writableDir returns null when the directory is not writable', () => {
  const base = mkdtempSync(join(tmpdir(), 'meari-'));
  const asFile = join(base, 'afile');
  writeFileSync(asFile, 'x');
  try {
    // A path under a regular file cannot be created (ENOTDIR): the same
    // outcome as a root-owned /data — history falls back to memory.
    assert.equal(writableDir(join(asFile, 'data')), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('writableDir(null) is null (memory-only, used by tests)', () => {
  assert.equal(writableDir(null), null);
});
