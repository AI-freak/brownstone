import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { builtinTools } from '../src/builtin-tools.ts';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brownstone-tools-'));
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

let counter = 0;
let workspace;
let config;
let context;
beforeEach(async () => {
  counter += 1;
  workspace = path.join(tmpRoot, `t-${counter}`);
  await fs.mkdir(workspace, { recursive: true });
  config = {
    workspaceRoot: workspace,
    searchProviderMode: 'disabled',
    maxSearchResults: 5,
  };
  context = { config, sessionId: 'session_x', userId: 'user_x' };
});

function toolByName(name) {
  return builtinTools(config).find((t) => t.definition.name === name);
}

// ---- workspace_read ----------------------------------------------------

test('workspace_read returns file contents', async () => {
  await fs.writeFile(path.join(workspace, 'hello.txt'), 'Hello, world!');
  const tool = toolByName('workspace_read');
  const result = await tool.run({ relativePath: 'hello.txt' }, context);
  assert.equal(result.ok, true);
  assert.equal(result.content, 'Hello, world!');
});

test('workspace_read rejects path traversal', async () => {
  const tool = toolByName('workspace_read');
  const result = await tool.run({ relativePath: '../escape.txt' }, context);
  assert.equal(result.ok, false);
  assert.match(result.content, /outside the allowed root/);
});

test('workspace_read rejects missing relativePath', async () => {
  const tool = toolByName('workspace_read');
  const result = await tool.run({}, context);
  assert.equal(result.ok, false);
  assert.match(result.content, /requires a non-empty/);
});

test('workspace_read returns failure for missing file (not exception)', async () => {
  const tool = toolByName('workspace_read');
  const result = await tool.run({ relativePath: 'nope.txt' }, context);
  assert.equal(result.ok, false);
});

test('workspace_read truncates large files', async () => {
  const big = 'x'.repeat(9000);
  await fs.writeFile(path.join(workspace, 'big.txt'), big);
  const tool = toolByName('workspace_read');
  const result = await tool.run({ relativePath: 'big.txt' }, context);
  assert.equal(result.ok, true);
  assert.ok(result.content.length <= 8500);
  assert.equal(result.metadata.truncated, true);
});

test('workspace_read refuses files >1 MiB', async () => {
  const big = 'x'.repeat(1024 * 1024 + 100);
  await fs.writeFile(path.join(workspace, 'huge.bin'), big);
  const tool = toolByName('workspace_read');
  const result = await tool.run({ relativePath: 'huge.bin' }, context);
  assert.equal(result.ok, false);
  assert.match(result.content, /larger than 1 MiB/);
});

// ---- web_search --------------------------------------------------------

test('web_search reports disabled state cleanly', async () => {
  const tool = toolByName('web_search');
  const result = await tool.run({ query: 'anything' }, context);
  assert.equal(result.ok, false);
  assert.match(result.content, /disabled/);
});

test('web_search rejects empty query', async () => {
  const tool = toolByName('web_search');
  const result = await tool.run({ query: '   ' }, context);
  assert.equal(result.ok, false);
});

// ---- Tool definitions --------------------------------------------------

test('every built-in tool has name, description, and schema', () => {
  for (const tool of builtinTools(config)) {
    assert.ok(tool.definition.name);
    assert.ok(tool.definition.description);
    assert.equal(typeof tool.definition.inputSchema, 'object');
  }
});

test('built-in tools have unique names', () => {
  const names = builtinTools(config).map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length);
});
