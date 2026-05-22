import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalSimProvider } from '../src/index.ts';

test('local-sim provider emits text_delta then done', async () => {
  const provider = createLocalSimProvider('test-model');
  const stream = provider.stream({
    messages: [{ role: 'user', content: 'hello world' }],
    tools: [],
  });

  const events = [];
  for await (const event of stream.events) {
    events.push(event);
  }

  const types = events.map((e) => e.type);
  // Should have at least one text_delta and end with done.
  assert.ok(types.includes('text_delta'), 'expected text_delta events');
  assert.equal(types[types.length - 1], 'done');
});

test('local-sim provider final resolves with full text', async () => {
  const provider = createLocalSimProvider();
  const stream = provider.stream({
    messages: [{ role: 'user', content: 'a question' }],
    tools: [],
  });

  let streamed = '';
  for await (const event of stream.events) {
    if (event.type === 'text_delta') streamed += event.text;
  }
  const final = await stream.final;
  assert.equal(final.outputText, streamed);
  assert.equal(final.finishReason, 'stop');
});

test('local-sim provider cancel stops the stream', async () => {
  const provider = createLocalSimProvider();
  const stream = provider.stream({
    messages: [{ role: 'user', content: 'a long question' }],
    tools: [],
  });

  let count = 0;
  for await (const event of stream.events) {
    count += 1;
    if (count === 2) stream.cancel();
  }

  // We should have stopped early.
  const final = await stream.final;
  assert.ok(['error', 'stop'].includes(final.finishReason));
});

test('complete() drains the stream and returns final', async () => {
  const provider = createLocalSimProvider();
  const result = await provider.complete({
    messages: [{ role: 'user', content: 'simple' }],
    tools: [],
  });
  assert.ok(result.outputText.length > 0);
});

test('provider exposes modelName', () => {
  const provider = createLocalSimProvider('alpha-7');
  assert.equal(provider.modelName, 'alpha-7');
});

test('local-sim emits a tool call when prompt asks to use a registered tool', async () => {
  const provider = createLocalSimProvider();
  const stream = provider.stream({
    messages: [{ role: 'user', content: 'Please use workspace_read to look at README.md' }],
    tools: [{
      name: 'workspace_read',
      description: 'Read a workspace file',
      inputSchema: { type: 'object', properties: {} },
    }],
  });
  const events = [];
  for await (const e of stream.events) events.push(e);
  const toolStart = events.find((e) => e.type === 'tool_call_start');
  assert.ok(toolStart, 'expected a tool_call_start event');
  assert.equal(toolStart.toolName, 'workspace_read');
});

test('local-sim does NOT emit a tool call for prompts that just mention a tool name', async () => {
  const provider = createLocalSimProvider();
  const stream = provider.stream({
    messages: [{ role: 'user', content: 'I read about workspace_read in the docs' }],
    tools: [{
      name: 'workspace_read',
      description: 'Read a workspace file',
      inputSchema: { type: 'object', properties: {} },
    }],
  });
  const events = [];
  for await (const e of stream.events) events.push(e);
  const toolStart = events.find((e) => e.type === 'tool_call_start');
  assert.equal(toolStart, undefined, 'should not have invoked the tool just from a passing mention');
});
