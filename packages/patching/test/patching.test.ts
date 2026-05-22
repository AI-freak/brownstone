import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parsePatchPlan, previewPatchPlan, applyPatchPlan } from '../src/index.ts';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brownstone-patch-'));
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

let counter = 0;
let workspace;
let config;
beforeEach(async () => {
  counter += 1;
  workspace = path.join(tmpRoot, `ws-${counter}`);
  await fs.mkdir(workspace, { recursive: true });
  config = { workspaceRoot: workspace };
});

test('parsePatchPlan rejects non-object input', () => {
  assert.throws(() => parsePatchPlan(null), /must be an object/);
  assert.throws(() => parsePatchPlan('string'), /must be an object/);
});

test('parsePatchPlan rejects missing operations', () => {
  assert.throws(() => parsePatchPlan({ summary: 'x' }), /operations array/);
});

test('parsePatchPlan rejects unknown operation types', () => {
  assert.throws(() => parsePatchPlan({
    summary: '', operations: [{ type: 'eval_arbitrary_code', relativePath: 'x' }],
  }), /must be one of/);
});

test('parsePatchPlan rejects missing content for replace/append', () => {
  assert.throws(() => parsePatchPlan({
    summary: '', operations: [{ type: 'replace_file', relativePath: 'a.txt' }],
  }), /content is required/);
});

test('parsePatchPlan succeeds for well-formed input', () => {
  const plan = parsePatchPlan({
    summary: 'add hello',
    operations: [{ type: 'replace_file', relativePath: 'hello.txt', content: 'Hi' }],
  });
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].content, 'Hi');
});

test('applyPatchPlan creates a new file', async () => {
  const plan = parsePatchPlan({
    summary: '', operations: [{ type: 'replace_file', relativePath: 'a.txt', content: 'hello' }],
  });
  const result = await applyPatchPlan(config, plan);
  assert.equal(result.applied, 1);
  const content = await fs.readFile(path.join(workspace, 'a.txt'), 'utf8');
  assert.equal(content, 'hello');
});

test('applyPatchPlan appends to existing file', async () => {
  await fs.writeFile(path.join(workspace, 'a.txt'), 'one\n');
  const plan = parsePatchPlan({
    summary: '', operations: [{ type: 'append_file', relativePath: 'a.txt', content: 'two\n' }],
  });
  await applyPatchPlan(config, plan);
  const content = await fs.readFile(path.join(workspace, 'a.txt'), 'utf8');
  assert.equal(content, 'one\ntwo\n');
});

test('applyPatchPlan deletes a file', async () => {
  await fs.writeFile(path.join(workspace, 'a.txt'), 'x');
  const plan = parsePatchPlan({
    summary: '', operations: [{ type: 'delete_file', relativePath: 'a.txt' }],
  });
  await applyPatchPlan(config, plan);
  await assert.rejects(fs.stat(path.join(workspace, 'a.txt')));
});

test('applyPatchPlan delete is idempotent on missing file', async () => {
  const plan = parsePatchPlan({
    summary: '', operations: [{ type: 'delete_file', relativePath: 'never.txt' }],
  });
  await assert.doesNotReject(applyPatchPlan(config, plan));
});

test('applyPatchPlan blocks path escape via safeResolve', async () => {
  const plan = parsePatchPlan({
    summary: '', operations: [{ type: 'replace_file', relativePath: '../escape.txt', content: 'x' }],
  });
  await assert.rejects(applyPatchPlan(config, plan), /outside the allowed root/);
});

test('previewPatchPlan describes operations', async () => {
  const plan = parsePatchPlan({
    summary: 'Build feature X',
    operations: [
      { type: 'replace_file', relativePath: 'a.txt', content: 'new' },
      { type: 'delete_file', relativePath: 'b.txt' },
    ],
  });
  const preview = await previewPatchPlan(config, plan);
  assert.match(preview, /Build feature X/);
  assert.match(preview, /REPLACE a\.txt/);
  assert.match(preview, /DELETE b\.txt/);
});
