import type {
  AgentConfig,
  BrowserCaptureResult,
  BrowserNavigateRequest,
  BrowserSubmitRequest,
  BrowserSubmitResult,
} from '@brownstone/contracts';
import { UpstreamError, ValidationError } from '@brownstone/errors';

/**
 * Client for the browser worker process.
 *
 * The browser-worker app is what actually drives the headless browser
 * (Playwright). This package provides the HTTP client the control plane
 * uses to talk to it. Splitting them this way means:
 *   - The control plane process doesn't import Playwright (heavy).
 *   - The browser-worker can crash/restart without bringing down the API.
 *   - Tests can swap this client for a fake without monkey-patching.
 *
 * Also exports `createBrowserDriver` used by the browser-worker itself —
 * an in-process driver that wraps Playwright. We split the driver into a
 * sub-module so importing this package from the control plane doesn't pull
 * Playwright into that process.
 */

function browserUrl(config: AgentConfig, path: string): string {
  return `http://${config.browserHost}:${config.browserPort}${path}`;
}

function checkUrlAllowed(url: string, allowlist: string[]): void {
  // Empty allowlist = nothing allowed. Operator must explicitly enable hosts.
  if (allowlist.length === 0) {
    throw new ValidationError(
      'No browser allowlist configured. Set BROWNSTONE_BROWSER_ALLOWLIST to a comma-separated list of hostnames.',
    );
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new ValidationError(`Invalid URL: ${url}`);
  }
  if (!allowlist.includes(host)) {
    throw new ValidationError(`Host "${host}" is not on the browser allowlist`);
  }
}

export async function requestBrowserCapture(
  config: AgentConfig,
  req: BrowserNavigateRequest,
): Promise<BrowserCaptureResult> {
  checkUrlAllowed(req.url, config.browserAllowlist);
  const response = await fetch(browserUrl(config, '/capture'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new UpstreamError(`Browser worker capture failed (${response.status}): ${detail.slice(0, 200)}`);
  }
  return response.json() as Promise<BrowserCaptureResult>;
}

export async function requestBrowserSubmit(
  config: AgentConfig,
  req: BrowserSubmitRequest,
  approvalToken?: string,
): Promise<BrowserSubmitResult> {
  checkUrlAllowed(req.url, config.browserAllowlist);
  const response = await fetch(browserUrl(config, '/submit'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(approvalToken ? { 'x-brownstone-approval': approvalToken } : {}),
    },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new UpstreamError(`Browser worker submit failed (${response.status}): ${detail.slice(0, 200)}`);
  }
  return response.json() as Promise<BrowserSubmitResult>;
}

// --- In-process driver for the browser-worker -----------------------------

/**
 * Minimal in-process browser driver.
 *
 * For Pass 2 this is a stub that returns synthetic results without launching
 * a real browser. That lets the rest of the system be exercised end-to-end
 * without Playwright installed. To run with a real browser:
 *   1. `npm install playwright` (and run `npx playwright install chromium`).
 *   2. Replace the `capture`/`submit` bodies with Playwright calls.
 *
 * The interface here matches what the browser-worker expects.
 */
export function createBrowserDriver(): {
  capture(req: BrowserNavigateRequest, config: AgentConfig): Promise<BrowserCaptureResult>;
  submit(req: BrowserSubmitRequest, config: AgentConfig): Promise<BrowserSubmitResult>;
} {
  return {
    async capture(req, config) {
      checkUrlAllowed(req.url, config.browserAllowlist);
      // Stub: pretend to fetch the URL with a regular fetch and use the
      // returned title from the HTML. Real impl uses Playwright.
      try {
        const response = await fetch(req.url, { redirect: 'follow' });
        const text = await response.text();
        const titleMatch = text.match(/<title>([^<]*)<\/title>/i);
        return {
          ok: response.ok,
          title: titleMatch?.[1]?.trim(),
          url: response.url,
          textPreview: stripHtml(text).slice(0, 500),
        };
      } catch (error) {
        return { ok: false, textPreview: `Error: ${(error as Error).message}` };
      }
    },
    async submit(req, config) {
      checkUrlAllowed(req.url, config.browserAllowlist);
      // Stub: do a real POST. Real impl would render the form, fill, submit.
      try {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(req.fields)) {
          params.set(key, value);
        }
        const response = await fetch(req.url, {
          method: req.method ?? 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });
        const text = await response.text();
        return {
          ok: response.ok,
          status: response.status,
          url: response.url,
          responsePreview: stripHtml(text).slice(0, 500),
        };
      } catch (error) {
        return { ok: false, responsePreview: `Error: ${(error as Error).message}` };
      }
    },
  };
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
