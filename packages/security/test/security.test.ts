import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ForbiddenError, TimeoutError } from '@brownstone/errors';
import {
  assertWithin,
  safeResolve,
  assertLocalhostBinding,
  assertActionApproved,
  assertExternalActionApproved,
  withTimeout,
} from '../src/index.ts';

// ---- Path safety -------------------------------------------------------

test('assertWithin allows paths under root', () => {
  const root = '/tmp/sandbox';
  assert.doesNotThrow(() => assertWithin(root, '/tmp/sandbox/file.txt'));
  assert.doesNotThrow(() => assertWithin(root, '/tmp/sandbox/nested/file.txt'));
});

test('assertWithin rejects ../ escape', () => {
  const root = '/tmp/sandbox';
  assert.throws(() => assertWithin(root, '/tmp/elsewhere'), ForbiddenError);
});

test('assertWithin rejects sibling with shared prefix', () => {
  // The classic startsWith bug: /tmp/sandbox vs /tmp/sandbox-secret.
  const root = '/tmp/sandbox';
  assert.throws(() => assertWithin(root, '/tmp/sandbox-secret/file'), ForbiddenError);
});

test('assertWithin allows the root itself', () => {
  const root = '/tmp/sandbox';
  assert.doesNotThrow(() => assertWithin(root, '/tmp/sandbox'));
});

test('safeResolve resolves relative path inside root', () => {
  const root = '/tmp/sandbox';
  const result = safeResolve(root, 'sub/file.txt');
  assert.equal(result, path.resolve(root, 'sub/file.txt'));
});

test('safeResolve rejects ../ escape', () => {
  const root = '/tmp/sandbox';
  assert.throws(() => safeResolve(root, '../other'), ForbiddenError);
});

test('safeResolve rejects absolute paths outside root', () => {
  const root = '/tmp/sandbox';
  assert.throws(() => safeResolve(root, '/etc/passwd'), ForbiddenError);
});

// ---- Localhost binding -------------------------------------------------

test('assertLocalhostBinding allows loopback addresses', () => {
  assert.doesNotThrow(() => assertLocalhostBinding('127.0.0.1'));
  assert.doesNotThrow(() => assertLocalhostBinding('::1'));
  assert.doesNotThrow(() => assertLocalhostBinding('localhost'));
  assert.doesNotThrow(() => assertLocalhostBinding('0.0.0.0'));
});

test('assertLocalhostBinding rejects non-loopback', () => {
  // Save and restore the env var so we don't leak state.
  const old = process.env.BROWNSTONE_ALLOW_PUBLIC_BIND;
  delete process.env.BROWNSTONE_ALLOW_PUBLIC_BIND;
  try {
    assert.throws(() => assertLocalhostBinding('192.168.1.5'), ForbiddenError);
    assert.throws(() => assertLocalhostBinding('example.com'), ForbiddenError);
  } finally {
    if (old !== undefined) process.env.BROWNSTONE_ALLOW_PUBLIC_BIND = old;
  }
});

test('assertLocalhostBinding can be overridden with env var', () => {
  const old = process.env.BROWNSTONE_ALLOW_PUBLIC_BIND;
  process.env.BROWNSTONE_ALLOW_PUBLIC_BIND = 'true';
  try {
    assert.doesNotThrow(() => assertLocalhostBinding('192.168.1.5'));
  } finally {
    if (old === undefined) delete process.env.BROWNSTONE_ALLOW_PUBLIC_BIND;
    else process.env.BROWNSTONE_ALLOW_PUBLIC_BIND = old;
  }
});

// ---- Approval gates ----------------------------------------------------

function baseConfig(overrides) {
  return {
    requireApprovalForWrites: false,
    requireApprovalForExternalActions: false,
    approvalToken: undefined,
    ...overrides,
  };
}

test('assertActionApproved no-ops when not required', () => {
  assert.doesNotThrow(() => assertActionApproved('test', undefined, baseConfig({})));
});

test('assertActionApproved throws when required but no token configured', () => {
  assert.throws(
    () => assertActionApproved('write', undefined, baseConfig({ requireApprovalForWrites: true })),
    /no approval token is configured/,
  );
});

test('assertActionApproved throws when token mismatched', () => {
  assert.throws(
    () => assertActionApproved('write', 'wrong', baseConfig({
      requireApprovalForWrites: true,
      approvalToken: 'expected',
    })),
    /valid approval token/,
  );
});

test('assertActionApproved succeeds with matching token', () => {
  assert.doesNotThrow(() => assertActionApproved('write', 'secret', baseConfig({
    requireApprovalForWrites: true,
    approvalToken: 'secret',
  })));
});

test('assertExternalActionApproved is independent of write approval', () => {
  // Even if write approval is off, external can be on.
  assert.throws(() => assertExternalActionApproved('submit', undefined, baseConfig({
    requireApprovalForExternalActions: true,
    approvalToken: 'secret',
  })), /valid approval token/);
});

// ---- withTimeout -------------------------------------------------------

test('withTimeout resolves before timeout', async () => {
  const result = await withTimeout(Promise.resolve('done'), 1000, 'test');
  assert.equal(result, 'done');
});

test('withTimeout rejects with TimeoutError after limit', async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 200));
  await assert.rejects(withTimeout(slow, 50, 'slow op'), TimeoutError);
});

test('withTimeout error message includes the label', async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 200));
  try {
    await withTimeout(slow, 50, 'browser capture');
    assert.fail('should have thrown');
  } catch (error) {
    assert.match(error.message, /browser capture/);
  }
});
