import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startSession, listSessions, loadSession, appendTurn } from '../src/index.ts';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brownstone-sessions-'));
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

let counter = 0;
let config;
let owner;
beforeEach(() => {
  counter += 1;
  config = { dataDir: path.join(tmpRoot, `test-${counter}`) };
  owner = {
    id: 'user_test',
    email: 'a@b.com',
    displayName: 'Tester',
    role: 'member',
    createdAt: new Date().toISOString(),
  };
});

test('startSession creates a session with the owner', async () => {
  const session = await startSession(config, owner);
  assert.equal(session.ownerUserId, owner.id);
  assert.deepEqual(session.turns, []);
  assert.ok(session.id.startsWith('session_'));
});

test('listSessions returns previously-created sessions, newest first', async () => {
  const a = await startSession(config, owner);
  await new Promise((r) => setTimeout(r, 5));
  const b = await startSession(config, owner);
  const list = await listSessions(config, owner);
  const ids = list.map((s) => s.id);
  // Newest first
  assert.deepEqual(ids[0], b.id);
  assert.deepEqual(ids[1], a.id);
});

test('listSessions returns light records without turns body', async () => {
  await startSession(config, owner);
  const list = await listSessions(config, owner);
  assert.deepEqual(list[0].turns, []);
});

test('loadSession retrieves a stored session', async () => {
  const created = await startSession(config, owner);
  const loaded = await loadSession(config, created.id);
  assert.equal(loaded?.id, created.id);
  assert.equal(loaded?.ownerUserId, owner.id);
});

test('loadSession returns undefined for unknown id', async () => {
  const loaded = await loadSession(config, 'session_nonexistent');
  assert.equal(loaded, undefined);
});

test('appendTurn adds a turn and updates updatedAt', async () => {
  const session = await startSession(config, owner);
  const original = session.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  const updated = await appendTurn(config, session.id, {
    user: 'hello',
    assistant: 'hi there',
    toolCalls: [],
  });
  assert.equal(updated.turns.length, 1);
  assert.equal(updated.turns[0].user, 'hello');
  assert.notEqual(updated.updatedAt, original);
});

test('appendTurn throws when session does not exist', async () => {
  await assert.rejects(
    appendTurn(config, 'session_nope', { user: 'x', assistant: 'y', toolCalls: [] }),
    /no longer exists/,
  );
});

test('appendTurn sets session title from first user prompt', async () => {
  const session = await startSession(config, owner);
  await appendTurn(config, session.id, {
    user: 'A long question that should become the title',
    assistant: '...',
    toolCalls: [],
  });
  const list = await listSessions(config, owner);
  assert.ok(list[0].title?.startsWith('A long question'));
});

test('appendTurn stores tool calls with results', async () => {
  const session = await startSession(config, owner);
  await appendTurn(config, session.id, {
    user: 'compute',
    assistant: 'done',
    toolCalls: [{
      id: 'call_1', toolName: 'calc', input: { x: 1 },
      result: { ok: true, content: '1' },
    }],
  });
  const loaded = await loadSession(config, session.id);
  assert.equal(loaded?.turns[0].toolCalls[0].result?.content, '1');
});
