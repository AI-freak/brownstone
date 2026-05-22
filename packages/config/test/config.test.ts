import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resolvePermissionMode } from '../src/index.ts';

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('loadConfig produces sensible defaults', () => {
  withEnv({
    BROWNSTONE_MODE: undefined,
    OPENAI_API_KEY: undefined,
    BROWNSTONE_AUTH_SECRET: undefined,
  }, () => {
    const config = loadConfig();
    assert.equal(config.permissionMode, 'read-only');
    assert.equal(config.providerMode, 'local-sim');
    assert.equal(config.serverHost, '127.0.0.1');
    assert.equal(config.serverPort, 8787);
    assert.ok(config.authSecret.length >= 32);
  });
});

test('loadConfig reads integer env vars', () => {
  withEnv({ BROWNSTONE_SERVER_PORT: '9000', BROWNSTONE_AUTH_SECRET: undefined }, () => {
    const config = loadConfig();
    assert.equal(config.serverPort, 9000);
  });
});

test('loadConfig rejects non-integer env vars', () => {
  withEnv({ BROWNSTONE_SERVER_PORT: 'not-a-number', BROWNSTONE_AUTH_SECRET: undefined }, () => {
    assert.throws(() => loadConfig(), /must be an integer/);
  });
});

test('loadConfig enforces port range', () => {
  withEnv({ BROWNSTONE_SERVER_PORT: '99999', BROWNSTONE_AUTH_SECRET: undefined }, () => {
    assert.throws(() => loadConfig(), /<= 65535/);
  });
});

test('loadConfig reads boolean env vars', () => {
  withEnv({ BROWNSTONE_REQUIRE_APPROVALS: 'true', BROWNSTONE_AUTH_SECRET: undefined }, () => {
    const config = loadConfig();
    assert.equal(config.requireApprovalForWrites, true);
  });
  withEnv({ BROWNSTONE_REQUIRE_APPROVALS: 'false', BROWNSTONE_AUTH_SECRET: undefined }, () => {
    const config = loadConfig();
    assert.equal(config.requireApprovalForWrites, false);
  });
});

test('loadConfig rejects invalid boolean env vars', () => {
  withEnv({ BROWNSTONE_REQUIRE_APPROVALS: 'maybe', BROWNSTONE_AUTH_SECRET: undefined }, () => {
    assert.throws(() => loadConfig(), /boolean/);
  });
});

test('loadConfig accepts overrides directly', () => {
  const config = loadConfig({ serverPort: 12345 });
  assert.equal(config.serverPort, 12345);
});

test('loadConfig parses CSV env vars', () => {
  withEnv({ BROWNSTONE_BROWSER_ALLOWLIST: 'a.com,b.com,c.com', BROWNSTONE_AUTH_SECRET: undefined }, () => {
    const config = loadConfig();
    assert.deepEqual(config.browserAllowlist, ['a.com', 'b.com', 'c.com']);
  });
});

test('loadConfig requires auth secret of 32+ chars if explicit', () => {
  withEnv({ BROWNSTONE_AUTH_SECRET: 'short' }, () => {
    assert.throws(() => loadConfig(), /at least 32 characters/);
  });
});

test('loadConfig generates ephemeral auth secret in dev if none set', () => {
  withEnv({ BROWNSTONE_AUTH_SECRET: undefined }, () => {
    const a = loadConfig();
    const b = loadConfig();
    // Different per call (each generates a fresh secret).
    assert.notEqual(a.authSecret, b.authSecret);
  });
});

test('resolvePermissionMode falls back to read-only on unknown', () => {
  assert.equal(resolvePermissionMode(undefined), 'read-only');
  assert.equal(resolvePermissionMode('garbage'), 'read-only');
});

test('resolvePermissionMode accepts known values', () => {
  assert.equal(resolvePermissionMode('workspace-write'), 'workspace-write');
  assert.equal(resolvePermissionMode('danger-full-access'), 'danger-full-access');
});
