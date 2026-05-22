import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  readJsonFile,
  writeJsonFile,
  updateJsonFile,
  appendJsonl,
  readJsonlTail,
  generateId,
} from '../src/index.ts';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brownstone-storage-'));
after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

test('readJsonFile returns fallback when file does not exist', async () => {
  const result = await readJsonFile(path.join(tmpDir, 'nope.json'), { hello: 'world' });
  assert.deepEqual(result, { hello: 'world' });
});

test('writeJsonFile then readJsonFile round-trips', async () => {
  const file = path.join(tmpDir, 'data.json');
  await writeJsonFile(file, { a: 1, b: [2, 3] });
  const read = await readJsonFile(file, {});
  assert.deepEqual(read, { a: 1, b: [2, 3] });
});

test('writeJsonFile is atomic — no temp file remains', async () => {
  const file = path.join(tmpDir, 'atomic.json');
  await writeJsonFile(file, { ok: true });
  const entries = await fs.readdir(tmpDir);
  const tempFiles = entries.filter((e) => e.startsWith('atomic.json.') && e.endsWith('.tmp'));
  assert.equal(tempFiles.length, 0);
});

test('updateJsonFile under concurrent writes serializes them', async () => {
  const file = path.join(tmpDir, 'concurrent.json');
  await writeJsonFile(file, { count: 0 });

  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      updateJsonFile(file, { count: 0 }, (current) => ({ count: current.count + 1 })),
    ),
  );

  const final = await readJsonFile(file, { count: 0 });
  // With proper serialization every increment lands. Without the mutex,
  // some would race and we'd see a count less than 20.
  assert.equal(final.count, 20);
});

test('appendJsonl appends new lines', async () => {
  const file = path.join(tmpDir, 'log.jsonl');
  await appendJsonl(file, { a: 1 });
  await appendJsonl(file, { a: 2 });
  await appendJsonl(file, { a: 3 });
  const tail = await readJsonlTail(file, 10);
  assert.deepEqual(tail, [{ a: 1 }, { a: 2 }, { a: 3 }]);
});

test('readJsonlTail respects max', async () => {
  const file = path.join(tmpDir, 'log-tail.jsonl');
  for (let i = 0; i < 10; i += 1) await appendJsonl(file, { n: i });
  const tail = await readJsonlTail(file, 3);
  assert.deepEqual(tail, [{ n: 7 }, { n: 8 }, { n: 9 }]);
});

test('readJsonlTail skips malformed lines', async () => {
  const file = path.join(tmpDir, 'log-bad.jsonl');
  await fs.writeFile(file, '{"a":1}\nthis is not json\n{"a":2}\n', 'utf8');
  const tail = await readJsonlTail(file, 10);
  assert.deepEqual(tail, [{ a: 1 }, { a: 2 }]);
});

test('generateId produces a prefixed, unique-looking string', () => {
  const a = generateId('task');
  const b = generateId('task');
  assert.ok(a.startsWith('task_'));
  assert.ok(b.startsWith('task_'));
  assert.notEqual(a, b);
  assert.ok(a.length >= 20);
});
