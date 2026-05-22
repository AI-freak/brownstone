import { test, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { loadConfig } from '@brownstone/config';
import { createLocalSimProvider } from '@brownstone/providers-local-sim';
import { startSession, listSessions, loadSession } from '@brownstone/session-store';
import { runChatTurn, runTurn } from '@brownstone/runtime';
import { enqueueTask, listTasks, loadTask } from '@brownstone/task-queue';
import { processNextTask } from '@brownstone/task-executor';
import { tailEvents, writeEvent } from '@brownstone/telemetry';
import { listMemory } from '@brownstone/memory';
import { requestBrowserCapture, requestBrowserSubmit } from '@brownstone/browser-automation';
import { getGitDiff, getGitStatus } from '@brownstone/git-tools';
import { applyPatchPlan, parsePatchPlan, previewPatchPlan } from '@brownstone/patching';
import { createWebSearchProvider, performWebSearch } from '@brownstone/web-search';
import { answerResearchQuestion, listUploadedDocuments, retrieveUploadedDocuments, saveUploadedText } from '@brownstone/research';
import {
  addComment, createExportBundle, createSchedule,
  listApprovals, listComments, listExports, listSchedules, recordApproval,
} from '@brownstone/operations';
import { startControlPlaneServer } from '../src/server.ts';

/**
 * Integration tests boot the full control plane against a temp data dir,
 * use a local-sim provider so we don't hit any external service, and
 * make real HTTP requests to verify auth + ownership + CSRF + streaming
 * work end-to-end.
 */

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brownstone-int-'));
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

let counter = 0;
let server;
let baseUrl;
let config;

beforeEach(async () => {
  counter += 1;
  const dataDir = path.join(tmpRoot, `int-${counter}`);
  await fs.mkdir(dataDir, { recursive: true });
  const workspaceRoot = path.join(dataDir, 'workspace');
  await fs.mkdir(workspaceRoot, { recursive: true });

  config = loadConfig({
    workspaceRoot,
    dataDir,
    serverPort: 0,         // random port
    authSecret: crypto.randomBytes(32).toString('hex'),
    bcryptRounds: 4,       // fast tests
    allowRegistration: true,
    providerMode: 'local-sim',
    browserAllowlist: [],
    schedulerTickMs: 60_000,
  });

  // Build capabilities by hand (no buildCapabilities to avoid dynamic imports
  // pulling in providers-openai which expects an API key).
  const provider = createLocalSimProvider();
  const searchProvider = createWebSearchProvider(config);

  const capabilities = {
    provider,
    runTurn,
    runChatTurn,
    builtinTools: () => [],
    startSession,
    listSessions,
    loadSession,
    enqueueTask,
    listTasks,
    loadTask,
    processNextTask: (cfg) => processNextTask(cfg),
    tailEvents,
    writeEvent,
    listMemory,
    getGitStatus,
    getGitDiff,
    parsePatchPlan,
    previewPatchPlan,
    applyPatchPlan,
    browserCapture: requestBrowserCapture,
    browserSubmit: requestBrowserSubmit,
    performWebSearch: (cfg, query) => performWebSearch(cfg, query, searchProvider),
    answerResearchQuestion: (args) => answerResearchQuestion({ ...args, provider, searchProvider }),
    saveUploadedText,
    listUploadedDocuments,
    retrieveUploadedDocuments,
    listSchedules,
    createSchedule,
    addComment,
    listComments,
    listApprovals,
    recordApproval,
    listExports,
    createExportBundle,
  };

  server = await startControlPlaneServer({ config, capabilities, installSignalHandlers: false });
  baseUrl = server.baseUrl;
});

afterEach(async () => {
  if (server) {
    await server.close().catch(() => undefined);
    server = undefined;
  }
});

after(async () => {
  if (server) await server.close().catch(() => undefined);
});

// ---- helpers ------------------------------------------------------------

async function request(method, path, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.csrf) headers['x-brownstone-csrf'] = opts.csrf;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: response.status, body: json };
}

async function makeUser(suffix = '') {
  const email = `u${counter}${suffix}@test.local`;
  const password = 'integration-test-password';
  const result = await request('POST', '/auth/register', { body: { email, password } });
  assert.equal(result.status, 200, `register failed: ${JSON.stringify(result.body)}`);
  return { ...result.body, password };
}

// ---- Auth ---------------------------------------------------------------

test('health endpoint is public', async () => {
  const result = await request('GET', '/health');
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
});

test('unauthenticated requests get 401', async () => {
  const result = await request('GET', '/sessions');
  assert.equal(result.status, 401);
});

test('register + login flow returns a usable token', async () => {
  const reg = await request('POST', '/auth/register', {
    body: { email: `flow${counter}@test.local`, password: 'good-password' },
  });
  assert.equal(reg.status, 200);
  assert.ok(reg.body.token);

  const me = await request('GET', '/auth/me', { token: reg.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.email, `flow${counter}@test.local`);
});

test('register with bad password rejected', async () => {
  const result = await request('POST', '/auth/register', {
    body: { email: 'bad@test.local', password: 'x' },
  });
  assert.equal(result.status, 400);
});

test('login with wrong password rejected', async () => {
  await makeUser();
  const result = await request('POST', '/auth/login', {
    body: { email: `u${counter}@test.local`, password: 'wrong' },
  });
  assert.equal(result.status, 401);
});

// ---- Ownership ---------------------------------------------------------

test('users cannot see another user\'s sessions', async () => {
  const alice = await makeUser('-alice');
  const bob = await makeUser('-bob');

  // Bob is admin (registered first); make a session for each.
  const aliceSession = await request('POST', '/sessions', { token: alice.token });
  const bobSession = await request('POST', '/sessions', { token: bob.token });
  assert.equal(aliceSession.status, 200);
  assert.equal(bobSession.status, 200);

  // Wait, Bob is admin (first user) -- swap. Alice is admin (first), Bob is member.
  // Listing as Bob (member) should only show Bob's own.
  const bobList = await request('GET', '/sessions', { token: bob.token });
  assert.equal(bobList.body.length, 1);
  assert.equal(bobList.body[0].id, bobSession.body.id);
});

test('admin sees all sessions', async () => {
  const alice = await makeUser('-alice'); // first user → admin
  const bob = await makeUser('-bob');

  await request('POST', '/sessions', { token: alice.token });
  await request('POST', '/sessions', { token: bob.token });

  const adminList = await request('GET', '/sessions', { token: alice.token });
  assert.equal(adminList.body.length, 2);
});

test('user cannot access another user\'s session by id (404 not 403)', async () => {
  await makeUser('-alice'); // admin
  const bob = await makeUser('-bob');
  const aliceSession = await request('POST', '/sessions', {
    token: (await makeUser('-alice2')).token, // grab a different member
  });
  // Actually let me simplify: use admin to create a session for someone, then member tries to read.
  // For now, just confirm bob can't read someone else's session.
  const fake = await request('POST', '/sessions', { token: bob.token });
  const fakeId = fake.body.id;
  // Bob can see his own:
  const bobReads = await request('GET', `/sessions/${fakeId}`, { token: bob.token });
  assert.equal(bobReads.status, 200);
  // Now create a new member 'charlie' and try to read Bob's session.
  const charlie = await makeUser('-charlie');
  const charlieReads = await request('GET', `/sessions/${fakeId}`, { token: charlie.token });
  assert.equal(charlieReads.status, 404); // ownership disclosure protection
});

// ---- CSRF --------------------------------------------------------------

test('bearer token requests skip CSRF', async () => {
  const user = await makeUser();
  // POST without CSRF token, just Bearer.
  const result = await request('POST', '/sessions', { token: user.token });
  assert.equal(result.status, 200);
});

// ---- Streaming ---------------------------------------------------------

test('chat streaming returns SSE events', async () => {
  const user = await makeUser();
  const session = await request('POST', '/sessions', { token: user.token });

  const response = await fetch(`${baseUrl}/chat/stream`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${user.token}`,
    },
    body: JSON.stringify({ sessionId: session.body.id, prompt: 'hello' }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const eventTypes = new Set();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const match of buffer.matchAll(/event:\s*(\S+)/g)) {
      eventTypes.add(match[1]);
    }
  }
  assert.ok(eventTypes.has('text_delta'), 'expected text_delta events');
  assert.ok(eventTypes.has('stream_end'), 'expected stream_end event');
});

test('chat stream rejected without auth', async () => {
  const response = await fetch(`${baseUrl}/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'x', prompt: 'y' }),
  });
  assert.equal(response.status, 401);
});

// ---- Tasks -------------------------------------------------------------

test('tasks are scoped by owner', async () => {
  const alice = await makeUser('-alice'); // admin
  const bob = await makeUser('-bob');

  await request('POST', '/tasks', {
    token: bob.token,
    body: { kind: 'web_search', input: { query: 'cats' } },
  });

  const aliceTasks = await request('GET', '/tasks', { token: alice.token });
  const bobTasks = await request('GET', '/tasks', { token: bob.token });

  // Admin (alice) sees all; bob only sees his own.
  assert.equal(bobTasks.body.length, 1);
  assert.ok(aliceTasks.body.length >= 1);
});

test('member cannot drive global task queue', async () => {
  await makeUser('-admin');
  const member = await makeUser('-member');
  const result = await request('POST', '/tasks/process-next', { token: member.token });
  assert.equal(result.status, 403);
});

// ---- Body validation --------------------------------------------------

test('routes return 400 on malformed bodies', async () => {
  const user = await makeUser();
  const result = await request('POST', '/chat', { token: user.token, body: { prompt: 'no session' } });
  assert.equal(result.status, 400);
});
