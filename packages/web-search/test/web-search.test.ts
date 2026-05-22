import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebSearchProvider, performWebSearch } from '../src/index.ts';

function configWith(overrides = {}) {
  return {
    searchProviderMode: 'disabled',
    braveSearchApiKey: undefined,
    maxSearchResults: 5,
    ...overrides,
  };
}

test('disabled provider returns empty results', async () => {
  const provider = createWebSearchProvider(configWith());
  const result = await performWebSearch(configWith(), 'anything', provider);
  assert.equal(result.provider, 'disabled');
  assert.deepEqual(result.results, []);
});

test('disabled provider preserves the query in result', async () => {
  const provider = createWebSearchProvider(configWith());
  const result = await performWebSearch(configWith(), 'specific query', provider);
  assert.equal(result.query, 'specific query');
});

test('performWebSearch rejects empty query', async () => {
  const provider = createWebSearchProvider(configWith());
  await assert.rejects(performWebSearch(configWith(), '   ', provider), /non-empty/);
});

test('falls back to disabled when brave mode is set but no API key', () => {
  const config = configWith({ searchProviderMode: 'brave', braveSearchApiKey: undefined });
  const provider = createWebSearchProvider(config);
  assert.equal(provider.name, 'disabled');
});

test('uses brave provider when key is set', () => {
  const config = configWith({ searchProviderMode: 'brave', braveSearchApiKey: 'fake-key' });
  const provider = createWebSearchProvider(config);
  assert.equal(provider.name, 'brave');
});
