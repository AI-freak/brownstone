import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fields, queryFields, Router, readJsonBody, DEFAULT_MAX_JSON_BODY_BYTES } from '../src/index.ts';
import { ValidationError, PayloadTooLargeError } from '@brownstone/errors';

// ---- Body field readers -------------------------------------------------

test('fields.string throws for missing field', () => {
  assert.throws(() => fields({}).string('name'), /required/);
});

test('fields.string throws for empty string', () => {
  assert.throws(() => fields({ name: '' }).string('name'), /required/);
});

test('fields.string returns the value when present', () => {
  assert.equal(fields({ name: 'Alice' }).string('name'), 'Alice');
});

test('fields.optionalString returns undefined when missing or empty', () => {
  assert.equal(fields({}).optionalString('name'), undefined);
  assert.equal(fields({ name: '' }).optionalString('name'), undefined);
  assert.equal(fields({ name: null }).optionalString('name'), undefined);
});

test('fields.optionalString throws if type is wrong', () => {
  assert.throws(() => fields({ name: 42 }).optionalString('name'), /must be a string/);
});

test('fields.number rejects non-numbers and NaN', () => {
  assert.throws(() => fields({ x: 'abc' }).number('x'), /finite/);
  assert.throws(() => fields({ x: NaN }).number('x'), /finite/);
  assert.equal(fields({ x: 42 }).number('x'), 42);
  assert.equal(fields({ x: 0 }).number('x'), 0);
});

test('fields.boolean is strict (no coercion)', () => {
  assert.equal(fields({ x: true }).boolean('x'), true);
  assert.equal(fields({ x: false }).boolean('x'), false);
  assert.throws(() => fields({ x: 'true' }).boolean('x'), /boolean/);
  assert.throws(() => fields({ x: 1 }).boolean('x'), /boolean/);
});

test('fields.optionalBoolean returns fallback', () => {
  assert.equal(fields({}).optionalBoolean('x', true), true);
  assert.equal(fields({ x: false }).optionalBoolean('x', true), false);
});

test('fields.stringArray enforces all elements are strings', () => {
  assert.deepEqual(fields({ tags: ['a', 'b'] }).stringArray('tags'), ['a', 'b']);
  assert.throws(() => fields({ tags: ['a', 1] }).stringArray('tags'), /tags\[1\]/);
  assert.throws(() => fields({ tags: 'a,b' }).stringArray('tags'), /array of strings/);
});

test('fields.object rejects arrays and null', () => {
  assert.throws(() => fields({ x: [] }).object('x'), /object/);
  assert.throws(() => fields({ x: null }).object('x'), /object/);
  assert.deepEqual(fields({ x: { a: 1 } }).object('x'), { a: 1 });
});

test('fields.enum allows only listed values', () => {
  const allowed = ['quick', 'balanced', 'deep'];
  assert.equal(fields({ mode: 'quick' }).enum('mode', allowed), 'quick');
  assert.throws(() => fields({ mode: 'unknown' }).enum('mode', allowed), /one of/);
});

test('fields() rejects non-object bodies', () => {
  assert.throws(() => fields(null), /must be a JSON object/);
  assert.throws(() => fields([]), /must be a JSON object/);
  assert.throws(() => fields('a string'), /must be a JSON object/);
});

test('queryFields.string throws when missing', () => {
  const params = new URLSearchParams();
  assert.throws(() => queryFields(params).string('q'), /required/);
});

test('queryFields.optionalInt parses or falls back', () => {
  const params = new URLSearchParams({ depth: '3' });
  assert.equal(queryFields(params).optionalInt('depth', 1), 3);
  assert.equal(queryFields(params).optionalInt('missing', 1), 1);
});

test('queryFields.optionalInt throws for non-integer', () => {
  const params = new URLSearchParams({ depth: 'abc' });
  assert.throws(() => queryFields(params).optionalInt('depth', 1), /integer/);
});

// ---- Router -------------------------------------------------------------

test('Router matches static paths', () => {
  const router = new Router().add({ method: 'GET', path: '/health', handler: () => 'ok' });
  const match = router.match('GET', '/health');
  assert.ok(match);
  assert.deepEqual(match.params, {});
});

test('Router extracts path params', () => {
  const router = new Router().add({ method: 'GET', path: '/sessions/:id', handler: () => null });
  const match = router.match('GET', '/sessions/abc-123');
  assert.ok(match);
  assert.deepEqual(match.params, { id: 'abc-123' });
});

test('Router decodes percent-encoded params', () => {
  const router = new Router().add({ method: 'GET', path: '/uploads/:filename', handler: () => null });
  const match = router.match('GET', '/uploads/hello%20world.txt');
  assert.ok(match);
  assert.equal(match.params.filename, 'hello world.txt');
});

test('Router respects method', () => {
  const router = new Router().add({ method: 'GET', path: '/x', handler: () => null });
  assert.ok(router.match('GET', '/x'));
  assert.equal(router.match('POST', '/x'), undefined);
});

test('Router returns first match (ordering matters for static-vs-param)', () => {
  let chosenHandler = '';
  const router = new Router()
    .add({ method: 'POST', path: '/tasks/process-next', handler: () => { chosenHandler = 'static'; return null; } })
    .add({ method: 'POST', path: '/tasks/:id', handler: () => { chosenHandler = 'param'; return null; } });
  const match = router.match('POST', '/tasks/process-next');
  match?.route.handler({ req: null, res: null, params: match.params, url: new URL('http://x/'), body: {}, locals: {} });
  assert.equal(chosenHandler, 'static');
});

test('Router returns undefined when path-segments differ in length', () => {
  const router = new Router().add({ method: 'GET', path: '/a/b', handler: () => null });
  assert.equal(router.match('GET', '/a'), undefined);
  assert.equal(router.match('GET', '/a/b/c'), undefined);
});

// ---- readJsonBody -------------------------------------------------------

function makeStream(body) {
  return Readable.from([Buffer.from(body)]);
}

test('readJsonBody parses valid JSON', async () => {
  const result = await readJsonBody(makeStream('{"a":1}'));
  assert.deepEqual(result, { a: 1 });
});

test('readJsonBody returns {} for empty body', async () => {
  const result = await readJsonBody(makeStream(''));
  assert.deepEqual(result, {});
});

test('readJsonBody throws ValidationError on bad JSON', async () => {
  await assert.rejects(
    readJsonBody(makeStream('not json')),
    ValidationError,
  );
});

test('readJsonBody throws PayloadTooLargeError on big bodies', async () => {
  const huge = 'x'.repeat(1024);
  await assert.rejects(
    readJsonBody(makeStream(`"${huge}"`), 100),
    PayloadTooLargeError,
  );
});

test('readJsonBody default limit is DEFAULT_MAX_JSON_BODY_BYTES', () => {
  // Just verify the constant is exported and sensible.
  assert.ok(DEFAULT_MAX_JSON_BODY_BYTES >= 1024 * 1024);
});
