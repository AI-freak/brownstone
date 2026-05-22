# Changelog

All notable changes to Brownstone will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — Initial public release

This is the first public release of Brownstone. The project began as an internal prototype called "Safe Agent Studio" and went through two major rewrites (Pass 1 architectural cleanup, Pass 2 runtime fill-in) before being opened to the public under the Brownstone name.

### Architecture

- **Multi-process design**: control plane (HTTP API), browser worker (page automation host), task worker (background queue), scheduler worker (cron-style), web UI (static + proxy), CLI (`brownstone` command), VS Code extension.
- **21 packages** in an npm workspace: typed contracts, error hierarchy, file-backed storage, config loader, auth, http kit, security primitives, two LLM provider implementations, session store, telemetry, memory, task queue/executor, runtime orchestrator, browser automation client, git tools, file patching, web search, research, operations (schedules/comments/approvals/exports).

### Authentication & security

- **Multi-user with roles**: registration creates accounts, first user becomes admin, others are members. Admins bypass ownership filters.
- **scrypt password hashing** via Node's built-in crypto module (no native dependencies, unlike bcrypt).
- **Signed-cookie sessions** with HMAC over the auth secret. Stateless — no server-side session table.
- **CSRF protection** for cookie-based mutating requests; bearer-token requests bypass.
- **Approval token gating** for destructive actions. Operator sets `BROWNSTONE_APPROVAL_TOKEN`; the agent's writes require it to be presented in a header.
- **Path safety** via `safeResolve` — every workspace path resolves through `path.relative` and is rejected if it escapes the workspace root.
- **Localhost binding enforcement** — the control plane refuses to start on a non-loopback address unless `BROWNSTONE_ALLOW_PUBLIC_BIND=true` is set.

### LLM integration

- **Streaming provider interface**: `ProviderEvent` union covers `text_delta`, `thinking_delta`, `tool_call_start`, `tool_call_end`, `usage`, `done`, `error`. Providers expose a `stream(request)` method returning an async iterable of events plus a `final` promise.
- **Two providers ship**: `@brownstone/providers-local-sim` (synthetic, offline dev) and `@brownstone/providers-openai` (full OpenAI-compatible streaming with hand-written SSE parsing, fragmented tool-arg assembly, abort support).
- **Built-in tools**: `workspace_read`, `web_search`, `git_status`. Adding a tool is one function in `packages/runtime/src/builtin-tools.ts`.

### Chat UI

- **Three-panel glass design**: Conversation / Project dashboard / Preview & approvals.
- **Token streaming** via Server-Sent Events — responses materialize word-by-word.
- **Inline markdown rendering** with syntax highlighting for code blocks. 150-line in-house renderer, HTML-escapes first then applies markdown patterns.
- **Collapsible tool-call panels** with status indicators (⋯ → ✓ / ✗), timing, and expandable input/output JSON.
- **Login overlay** with multi-user registration; first-time hint banner directs new users to the Create Account tab.
- **Approval-token bar** pinned at the bottom of the workspace; memory-only (not persisted).

### Test suite

- **173 tests, all passing in under 10 seconds.**
- Coverage spans errors (10), storage (8), http-kit (26), security (18), config (12), auth (33), providers (7), session-store (9), task-queue (10), patching (11), web-search (5), runtime built-in tools (10), and full HTTP-level integration via a real control plane on a random port (14).
- Run with `npm test` after `npm install`.

### Known limitations

These are explicitly out of scope for 0.5.0 and tracked for future work:

- Browser worker uses a stub HTTP driver (not real Playwright).
- No rate limiting on `/auth/*` endpoints (works fine on localhost; problematic if you expose this publicly).
- Logout doesn't revoke sessions (HMAC stateless tokens).
- Vector retrieval uses naive term-frequency, not embeddings.
- Memory notes, schedules, collaboration comments, approvals are wired in the backend but their UIs are minimal.
- No migration script from earlier internal data layouts.
- No bcrypt-to-scrypt verify shim for hashes from a hypothetical prior install.

See `CONTRIBUTING.md` for what would help most.
