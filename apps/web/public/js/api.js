/**
 * Thin API client wrapping fetch.
 *
 * Responsibilities:
 *   - Maintain CSRF token (fetched once after login).
 *   - Inject the approval-token header on requests that need it.
 *   - Surface 401 by triggering re-authentication.
 *   - Parse JSON error bodies into structured Error objects.
 */

let csrfToken = null;
let onUnauthorized = () => {};
let unauthorizedInFlight = null;

export function configureClient(opts) {
  if (opts.onUnauthorized) onUnauthorized = opts.onUnauthorized;
}

export async function refreshCsrf() {
  const response = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  if (response.status === 401) { csrfToken = null; return null; }
  if (!response.ok) throw new Error('Failed to fetch CSRF token');
  const data = await response.json();
  csrfToken = data.csrfToken ?? null;
  return csrfToken;
}

export function getCsrfToken() { return csrfToken; }
export function clearCsrfToken() { csrfToken = null; }

function buildHeaders(extra = {}, requiresCsrf, approvalToken) {
  const headers = { 'content-type': 'application/json' };
  if (requiresCsrf && csrfToken) headers['x-brownstone-csrf'] = csrfToken;
  if (approvalToken) headers['x-brownstone-approval'] = approvalToken;
  return { ...headers, ...extra };
}

async function parseError(response) {
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON */ }
  const message = body?.error || `${response.status} ${response.statusText}`;
  const error = new Error(message);
  error.statusCode = response.status;
  error.code = body?.code;
  return error;
}

export async function api(method, path, options = {}) {
  const isMutating = method !== 'GET' && method !== 'HEAD';
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: buildHeaders(options.headers ?? {}, isMutating, options.approvalToken),
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 401) {
    csrfToken = null;
    // Callers like auth.bootstrap() opt out so they can handle the 401
    // themselves without recursing through the global unauth handler.
    if (!options.skipUnauthHandler) {
      if (!unauthorizedInFlight) {
        const result = Promise.resolve(onUnauthorized());
        unauthorizedInFlight = result.finally(() => {
          unauthorizedInFlight = null;
        });
      }
      try { await unauthorizedInFlight; } catch { /* swallow */ }
    }
    throw await parseError(response);
  }
  if (!response.ok) throw await parseError(response);

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}
