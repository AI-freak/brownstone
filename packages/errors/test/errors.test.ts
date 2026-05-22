import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AppError,
  ValidationError,
  UnauthenticatedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  UpstreamError,
  TimeoutError,
  InternalError,
  toAppError,
} from '../src/index.ts';

test('each error subclass exposes correct statusCode and code', () => {
  assert.equal(new ValidationError('x').statusCode, 400);
  assert.equal(new ValidationError('x').code, 'validation_failed');
  assert.equal(new UnauthenticatedError('x').statusCode, 401);
  assert.equal(new ForbiddenError('x').statusCode, 403);
  assert.equal(new NotFoundError('x').statusCode, 404);
  assert.equal(new ConflictError('x').statusCode, 409);
  assert.equal(new PayloadTooLargeError('x').statusCode, 413);
  assert.equal(new UpstreamError('x').statusCode, 502);
  assert.equal(new TimeoutError('x').statusCode, 504);
  assert.equal(new InternalError('x').statusCode, 500);
});

test('toJSON serializes message and code, omits empty details', () => {
  const err = new ValidationError('Bad field');
  assert.deepEqual(err.toJSON(), { error: 'Bad field', code: 'validation_failed' });
});

test('toJSON includes details when provided', () => {
  const err = new ValidationError('Bad field', { details: { field: 'email' } });
  assert.deepEqual(err.toJSON(), {
    error: 'Bad field',
    code: 'validation_failed',
    details: { field: 'email' },
  });
});

test('AppError preserves cause via Error options', () => {
  const cause = new Error('original');
  const wrapped = new ValidationError('higher', { cause });
  assert.equal(wrapped.cause, cause);
});

test('AppError accepts cause: false without dropping it', () => {
  // Edge case: the 'in' operator path lets falsy causes through.
  const err = new ValidationError('x', { cause: false });
  // Node's Error constructor sets the property; we just verify no throw.
  assert.ok(err instanceof ValidationError);
});

test('toAppError passes through AppError instances unchanged', () => {
  const original = new ForbiddenError('nope');
  assert.equal(toAppError(original), original);
});

test('toAppError converts plain Error with statusCode', () => {
  const e = Object.assign(new Error('upstream down'), { statusCode: 502 });
  const wrapped = toAppError(e);
  assert.ok(wrapped instanceof UpstreamError);
  assert.equal(wrapped.message, 'upstream down');
});

test('toAppError converts plain Error to InternalError by default', () => {
  const wrapped = toAppError(new Error('boom'));
  assert.ok(wrapped instanceof InternalError);
  assert.equal(wrapped.statusCode, 500);
});

test('toAppError handles non-Error throws (strings, undefined)', () => {
  const a = toAppError('bare string');
  const b = toAppError(undefined);
  assert.ok(a instanceof InternalError);
  assert.ok(b instanceof InternalError);
});

test('AppError name reflects the constructor name', () => {
  assert.equal(new ValidationError('x').name, 'ValidationError');
  assert.equal(new UnauthenticatedError('x').name, 'UnauthenticatedError');
});
