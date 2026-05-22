import type { AgentConfig, SearchResponse, SearchResult } from '@brownstone/contracts';
import { UpstreamError, ValidationError } from '@brownstone/errors';

/**
 * Web search abstraction.
 *
 * Two implementations:
 *   brave    — real Brave Search API. Requires BRAVE_SEARCH_API_KEY.
 *   disabled — returns an empty result set with provider='disabled' so the
 *              agent can degrade gracefully instead of failing every query.
 *
 * The provider is chosen at config-load time based on
 * BROWNSTONE_SEARCH_PROVIDER. The control plane picks one once at startup
 * via `createWebSearchProvider(config)` and passes the same instance into
 * every search call so we don't reconstruct it.
 */

export interface WebSearchProvider {
  name: string;
  search(query: string, max: number): Promise<SearchResponse>;
}

export function createWebSearchProvider(config: AgentConfig): WebSearchProvider {
  if (config.searchProviderMode === 'brave' && config.braveSearchApiKey) {
    return createBraveProvider(config.braveSearchApiKey);
  }
  return createDisabledProvider();
}

export async function performWebSearch(
  config: AgentConfig,
  query: string,
  provider: WebSearchProvider,
): Promise<SearchResponse> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new ValidationError('Search query must be non-empty');
  }
  return provider.search(trimmed, config.maxSearchResults);
}

function createDisabledProvider(): WebSearchProvider {
  return {
    name: 'disabled',
    async search(query) {
      return { query, results: [], provider: 'disabled' };
    },
  };
}

function createBraveProvider(apiKey: string): WebSearchProvider {
  return {
    name: 'brave',
    async search(query, max) {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(Math.min(max, 20)));
      const response = await fetch(url.toString(), {
        headers: {
          'accept': 'application/json',
          'x-subscription-token': apiKey,
        },
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new UpstreamError(`Brave Search responded ${response.status}: ${detail.slice(0, 200)}`);
      }
      const body = await response.json() as {
        web?: { results?: Array<{ title: string; url: string; description?: string; meta_url?: { hostname?: string } }> };
      };
      const results: SearchResult[] = (body.web?.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.description,
        source: r.meta_url?.hostname,
      }));
      return { query, results, provider: 'brave' };
    },
  };
}
