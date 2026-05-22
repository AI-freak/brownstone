import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  authenticate,
  registerUser,
  loadUserProfile,
  hashPassword,
  verifyPassword,
  validatePassword,
  issueSessionCookie,
  verifySessionCookie,
  buildSessionCookieHeader,
  buildClearCookieHeader,
  parseCookies,
  deriveCsrfToken,
  assertCsrfToken,
} from '../src/index.ts';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brownstone-auth-'));
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

function configFor(name) {
  return {
    workspaceRoot: tmpRoot,
    dataDir: path.join(tmpRoot, name),
    authSecret: crypto.randomBytes(32).toString('hex'),
    authCookieName: '__sa',
    sessionTtlMs: 60_000,
    bcryptRounds: 4, // fast for tests
    allowRegistration: true,
    permissionMode: 'read-only',
    enableShellTool: false,
    requireApprovalForWrites: false,
    requireApprovalForExternalActions: false,
    shellCommandAllowlist: [],
    model: 'test',
    providerMode: 'local-sim',
    openAiBaseUrl: '',
    serverHost: '127.0.0.1',
    serverPort: 0,
    controlPlaneBaseUrl: '',
    browserHost: '127.0.0.1',
    browserPort: 0,
    webHost: '127.0.0.1',
    webPort: 0,
    browserAllowlist: [],
    maxBrowserActionsPerTask: 0,
    taskPollMs: 100,
    maxToolSteps: 1,
    maxTaskRuntimeMs: 1000,
    searchProviderMode: 'disabled',
    maxSearchResults: 5,
    maxFetchedPagesPerResearch: 0,
    pluginApproval: 'manual',
    uploadMaxBytes: 1024,
    defaultThinkingMode: 'balanced',
    schedulerTickMs: 1000,
  };
}

let testIndex = 0;
let config;
beforeEach(() => {
  testIndex += 1;
  config = configFor(`auth-test-${testIndex}`);
});

// ---- Passwords -----------------------------------------------------------

test('validatePassword rejects short passwords', () => {
  assert.throws(() => validatePassword('short'), /at least 8/);
});

test('validatePassword accepts 8+ char passwords', () => {
  assert.doesNotThrow(() => validatePassword('eight-chars'));
});

test('hashPassword + verifyPassword round-trip', async () => {
  const hash = await hashPassword(config, 'correct-horse-battery-staple');
  assert.equal(await verifyPassword('correct-horse-battery-staple', hash), true);
  assert.equal(await verifyPassword('wrong-password', hash), false);
});

test('verifyPassword returns false on malformed hash (no exception)', async () => {
  assert.equal(await verifyPassword('any', 'definitely-not-a-bcrypt-hash'), false);
});

// ---- Cookies -------------------------------------------------------------

test('issueSessionCookie + verifySessionCookie round-trip', () => {
  const issued = issueSessionCookie(config, 'user_123');
  const payload = verifySessionCookie(config, issued.value);
  assert.equal(payload.uid, 'user_123');
  assert.ok(payload.exp > Date.now());
});

test('verifySessionCookie rejects tampered payload', () => {
  const issued = issueSessionCookie(config, 'user_123');
  // Flip a byte in the payload section.
  const [head, sig] = issued.value.split('.');
  const tampered = head.slice(0, -1) + (head.slice(-1) === 'A' ? 'B' : 'A') + '.' + sig;
  assert.throws(() => verifySessionCookie(config, tampered), /did not verify|malformed/);
});

test('verifySessionCookie rejects forged signature', () => {
  const issued = issueSessionCookie(config, 'user_123');
  const [head] = issued.value.split('.');
  const forged = head + '.' + 'X'.repeat(43);
  assert.throws(() => verifySessionCookie(config, forged), /did not verify/);
});

test('verifySessionCookie rejects expired cookies', () => {
  const shortLifeConfig = { ...config, sessionTtlMs: 1 };
  const issued = issueSessionCookie(shortLifeConfig, 'user_x');
  // Wait a tick. setTimeout returns void so synthesize.
  return new Promise((resolve) => setTimeout(() => {
    assert.throws(() => verifySessionCookie(shortLifeConfig, issued.value), /expired/);
    resolve();
  }, 50));
});

test('verifySessionCookie rejects malformed input', () => {
  assert.throws(() => verifySessionCookie(config, 'not-even-close'), /Invalid/);
  assert.throws(() => verifySessionCookie(config, ''), /Invalid/);
});

test('parseCookies handles standard cookie header', () => {
  const parsed = parseCookies('foo=bar; baz=qux; __sa=session-token');
  assert.deepEqual(parsed, { foo: 'bar', baz: 'qux', __sa: 'session-token' });
});

test('parseCookies handles URL-encoded values', () => {
  const parsed = parseCookies('name=hello%20world');
  assert.equal(parsed.name, 'hello world');
});

test('parseCookies handles malformed values gracefully', () => {
  const parsed = parseCookies('a=%E0%A4%A; b=ok');
  // Malformed percent-encoding falls back to raw value, doesn't throw.
  assert.ok('a' in parsed);
  assert.equal(parsed.b, 'ok');
});

test('parseCookies returns empty for undefined header', () => {
  assert.deepEqual(parseCookies(undefined), {});
});

test('buildSessionCookieHeader includes HttpOnly, SameSite=Strict, Path=/', () => {
  const header = buildSessionCookieHeader('__sa', 'value', { maxAgeSeconds: 60, secure: false });
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Path=\//);
  assert.match(header, /Max-Age=60/);
  assert.doesNotMatch(header, /Secure/);
});

test('buildSessionCookieHeader includes Secure when requested', () => {
  const header = buildSessionCookieHeader('__sa', 'value', { maxAgeSeconds: 60, secure: true });
  assert.match(header, /Secure/);
});

test('buildClearCookieHeader sets Max-Age=0', () => {
  const header = buildClearCookieHeader('__sa', false);
  assert.match(header, /Max-Age=0/);
});

// ---- Registration & authentication -------------------------------------

test('first registered user becomes admin', async () => {
  const profile = await registerUser(config, {
    email: 'admin@example.com',
    password: 'first-password',
    displayName: 'Admin',
  });
  assert.equal(profile.role, 'admin');
});

test('subsequent users become members', async () => {
  await registerUser(config, { email: 'a@example.com', password: 'first-password' });
  const second = await registerUser(config, { email: 'b@example.com', password: 'second-password' });
  assert.equal(second.role, 'member');
});

test('register rejects invalid email', async () => {
  await assert.rejects(
    registerUser(config, { email: 'not-an-email', password: 'good-password' }),
    /valid format/,
  );
});

test('register rejects short password', async () => {
  await assert.rejects(
    registerUser(config, { email: 'a@b.com', password: 'short' }),
    /at least 8/,
  );
});

test('register rejects duplicate email', async () => {
  await registerUser(config, { email: 'dup@example.com', password: 'first-password' });
  await assert.rejects(
    registerUser(config, { email: 'dup@example.com', password: 'second-password' }),
    /already exists/,
  );
});

test('register normalizes email to lowercase', async () => {
  const profile = await registerUser(config, { email: 'Mixed@Example.COM', password: 'good-password' });
  assert.equal(profile.email, 'mixed@example.com');
});

test('authenticate succeeds with correct credentials', async () => {
  await registerUser(config, { email: 'auth@example.com', password: 'correct-password' });
  const profile = await authenticate(config, 'auth@example.com', 'correct-password');
  assert.equal(profile.email, 'auth@example.com');
});

test('authenticate fails with wrong password', async () => {
  await registerUser(config, { email: 'auth@example.com', password: 'correct-password' });
  await assert.rejects(
    authenticate(config, 'auth@example.com', 'wrong-password'),
    /incorrect/,
  );
});

test('authenticate fails with unknown email (same error)', async () => {
  await registerUser(config, { email: 'a@example.com', password: 'correct-password' });
  await assert.rejects(
    authenticate(config, 'b@example.com', 'any-password'),
    /incorrect/,
  );
});

test('loadUserProfile retrieves by id', async () => {
  const created = await registerUser(config, { email: 'load@example.com', password: 'good-password' });
  const loaded = await loadUserProfile(config, created.id);
  assert.equal(loaded.email, 'load@example.com');
});

test('loadUserProfile throws for unknown id', async () => {
  await assert.rejects(loadUserProfile(config, 'user_nonexistent'), /no longer exists/);
});

// ---- CSRF ----------------------------------------------------------------

test('deriveCsrfToken is deterministic per (secret, sessionId)', () => {
  const a = deriveCsrfToken(config, 'session_abc');
  const b = deriveCsrfToken(config, 'session_abc');
  assert.equal(a, b);
});

test('deriveCsrfToken changes when sessionId changes', () => {
  const a = deriveCsrfToken(config, 'session_a');
  const b = deriveCsrfToken(config, 'session_b');
  assert.notEqual(a, b);
});

test('assertCsrfToken accepts valid token', () => {
  const token = deriveCsrfToken(config, 'session_xyz');
  assert.doesNotThrow(() => assertCsrfToken(config, 'session_xyz', token));
});

test('assertCsrfToken rejects mismatched token', () => {
  assert.throws(() => assertCsrfToken(config, 'session_xyz', 'wrong-token'), /CSRF/);
});

test('assertCsrfToken rejects missing token', () => {
  assert.throws(() => assertCsrfToken(config, 'session_xyz', undefined), /Missing CSRF/);
});

test('assertCsrfToken rejects token derived from a different session', () => {
  const tokenForA = deriveCsrfToken(config, 'session_a');
  assert.throws(() => assertCsrfToken(config, 'session_b', tokenForA), /CSRF/);
});
