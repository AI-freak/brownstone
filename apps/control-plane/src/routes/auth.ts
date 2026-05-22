import type { AgentConfig } from '@brownstone/contracts';
import {
  authenticate,
  buildClearCookieHeader,
  buildSessionCookieHeader,
  deriveCsrfToken,
  issueSessionCookie,
  registerUser,
} from '@brownstone/auth';
import { fields, type RouteDefinition } from '@brownstone/http-kit';

const SET_COOKIE = 'set-cookie';

/**
 * /auth/* routes.
 *
 * `register` and `login` are public; both issue a session cookie on success.
 * `logout` clears the cookie; safe to call when not logged in.
 * `csrf` returns a token derived from the caller's session — required on
 * mutating routes when authenticating via cookie.
 */
export function buildAuthRoutes(config: AgentConfig): RouteDefinition[] {
  const cookieMaxAgeSeconds = Math.floor(config.sessionTtlMs / 1000);
  // The cookie must be Secure when served over HTTPS. We can't know that here
  // because the server is HTTP-only; the operator-facing web app is expected
  // to set `BROWNSTONE_COOKIES_SECURE=true` when terminated behind TLS.
  const secureCookies = process.env.BROWNSTONE_COOKIES_SECURE === 'true';

  function setSessionCookie(res: import('node:http').ServerResponse, userId: string): { token: string } {
    const issued = issueSessionCookie(config, userId);
    res.setHeader(SET_COOKIE, buildSessionCookieHeader(config.authCookieName, issued.value, {
      maxAgeSeconds: cookieMaxAgeSeconds,
      secure: secureCookies,
    }));
    return { token: issued.value };
  }

  return [
    {
      method: 'POST',
      path: '/auth/register',
      publicRoute: true,
      csrf: false,
      handler: async ({ body, res }) => {
        const f = fields(body);
        const profile = await registerUser(config, {
          email: f.string('email'),
          password: f.string('password'),
          displayName: f.optionalString('displayName'),
        });
        const issued = setSessionCookie(res, profile.id);
        return { user: profile, token: issued.token };
      },
    },
    {
      method: 'POST',
      path: '/auth/login',
      publicRoute: true,
      csrf: false,
      handler: async ({ body, res }) => {
        const f = fields(body);
        const profile = await authenticate(config, f.string('email'), f.string('password'));
        const issued = setSessionCookie(res, profile.id);
        return { user: profile, token: issued.token };
      },
    },
    {
      method: 'POST',
      path: '/auth/logout',
      publicRoute: true,
      csrf: false,
      handler: async ({ res }) => {
        res.setHeader(SET_COOKIE, buildClearCookieHeader(config.authCookieName, secureCookies));
        return { ok: true };
      },
    },
    {
      method: 'GET',
      path: '/auth/csrf',
      publicRoute: false,
      csrf: false,
      handler: (ctx) => {
        const auth = ctx.locals.auth as import('@brownstone/contracts').AuthContext;
        return { csrfToken: deriveCsrfToken(config, auth.sessionId) };
      },
    },
    {
      method: 'GET',
      path: '/auth/me',
      publicRoute: false,
      csrf: false,
      handler: (ctx) => {
        const auth = ctx.locals.auth as import('@brownstone/contracts').AuthContext;
        return auth.user;
      },
    },
  ];
}
