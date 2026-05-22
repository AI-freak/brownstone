import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { enqueueTask, listTasks, loadTask, claimNextTask, completeTask } from '../src/index.ts';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brownstone-queue-'));
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

let counter = 0;
let config;
let owner;
beforeEach(() => {
  counter += 1;
  config = { dataDir: path.join(tmpRoot, `test-${counter}`) };
  owner = { id: 'user_x', email: 'x@y.z', displayName: 'X', role: 'member', createdAt: '' };
});

test('enqueueTask returns a queued task', async () => {
  const task = await enqueueTask(config, owner, 'web_search', { query: 'hi' });
  assert.equal(task.status, 'queued');
  assert.equal(task.ownerUserId, owner.id);
  assert.equal(task.kind, 'web_search');
  assert.deepEqual(task.input, { query: 'hi' });
});

test('listTasks returns newest first', async () => {
  const a = await enqueueTask(config, owner, 'web_search', { q: 'a' });
  await new Promise((r) => setTimeout(r, 5));
  const b = await enqueueTask(config, owner, 'web_search', { q: 'b' });
  const list = await listTasks(config);
  assert.equal(list[0].id, b.id);
  assert.equal(list[1].id, a.id);
});

test('claimNextTask transitions queued → running and increments attempts', async () => {
  await enqueueTask(config, owner, 'web_search', { q: 'a' });
  const claimed = await claimNextTask(config);
  assert.equal(claimed?.status, 'running');
  assert.equal(claimed?.attempts, 1);
});

test('claimNextTask is FIFO', async () => {
  const a = await enqueueTask(config, owner, 'web_search', { q: 'a' });
  await new Promise((r) => setTimeout(r, 5));
  const b = await enqueueTask(config, owner, 'web_search', { q: 'b' });

  const first = await claimNextTask(config);
  const second = await claimNextTask(config);

  assert.equal(first?.id, a.id);
  assert.equal(second?.id, b.id);
});

test('claimNextTask returns undefined on empty queue', async () => {
  const result = await claimNextTask(config);
  assert.equal(result, undefined);
});

test('completeTask updates status and result', async () => {
  await enqueueTask(config, owner, 'web_search', { q: 'a' });
  const claimed = await claimNextTask(config);
  const result = await completeTask(config, claimed.id, { status: 'succeeded', result: { count: 3 } });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.result, { count: 3 });
});

test('completeTask throws for unknown id', async () => {
  await assert.rejects(
    completeTask(config, 'task_nope', { status: 'succeeded' }),
    /not found/,
  );
});

test('loadTask retrieves by id', async () => {
  const created = await enqueueTask(config, owner, 'web_search', { q: 'a' });
  const loaded = await loadTask(config, created.id);
  assert.equal(loaded?.id, created.id);
});

test('concurrent enqueues do not lose tasks', async () => {
  await Promise.all(Array.from({ length: 15 }, (_, i) =>
    enqueueTask(config, owner, 'web_search', { q: `q${i}` }),
  ));
  const list = await listTasks(config);
  assert.equal(list.length, 15);
});

test('concurrent claims each yield a unique task', async () => {
  for (let i = 0; i < 5; i += 1) await enqueueTask(config, owner, 'web_search', { q: String(i) });

  const claimed = await Promise.all(Array.from({ length: 5 }, () => claimNextTask(config)));
  const ids = claimed.map((t) => t?.id);
  const unique = new Set(ids);
  assert.equal(unique.size, 5);
});
