# Brownstone

> A local-first AI agent workspace. Runs on your machine, reads your files, calls tools you control, and asks before doing destructive things.

[![Tests](https://github.com/<your-username>/brownstone/actions/workflows/test.yml/badge.svg)](https://github.com/<your-username>/brownstone/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**[→ Try the demo](https://<your-username>.github.io/brownstone/)** (runs entirely in your browser with a fake backend, no install)

---

## What is this?

Brownstone is a self-hosted platform for talking to an AI agent that can actually do things — read your project files, run searches, summarize documents, propose edits — without those things being a black box. Every tool call is visible. Every destructive action goes through an explicit approval gate. The whole thing runs on your laptop or your own server: nothing leaves your network unless you tell it to.

It's built as a multi-process system: a control plane, a browser worker, a task worker, a scheduler, a web UI, a CLI, and a VS Code extension. They share a single workspace and talk over HTTP on loopback.

## Why does this exist?

There are a lot of AI agent frameworks now. Most fall into one of two camps:

- **Library-flavored** (LangChain, LlamaIndex): you assemble your own app on top of them. Lots of flexibility, but you're writing the UI, the auth, the persistence, the orchestration yourself.
- **Hosted SaaS** (most of the well-known agent products): you sign up, paste your data, and trust that they handle it correctly. Convenient but opaque.

Brownstone sits in a third place: a complete application you run yourself. You get the UI and the orchestration out of the box. You also get to see every line of code that touches your files, every tool the agent invokes, every prompt that goes to the model. Nothing is hidden behind a server you don't control.

## Features

- **Streaming chat** with token-by-token rendering, inline markdown, syntax-highlighted code blocks
- **Collapsible tool-call panels** showing exactly what the agent invoked, with timing and input/output
- **Three built-in tools** (workspace_read, web_search, git_status); adding a tool is one function
- **Multi-user with roles**: open or invite-only registration, admins vs members, per-user ownership of sessions and tasks
- **Approval-token gating** for destructive operations — the agent can read freely but writes require an out-of-band token
- **Three permission modes**: `read-only`, `workspace-write`, `danger-full-access`
- **Two LLM providers** out of the box: a synthetic offline simulator for local dev, and a full OpenAI-compatible streaming client (works with OpenAI, Anthropic via their compat layer, vLLM, Ollama's OpenAI plugin, etc.)
- **No native dependencies**: passwords use Node's built-in scrypt, not bcrypt
- **173 tests** covering security primitives, auth, HTTP body parsing, streaming, ownership checks, and full end-to-end integration

## Quick start

You'll need Node.js 22 or newer.

```bash
git clone https://github.com/<your-username>/brownstone.git
cd brownstone
npm install
cp .env.example .env
# Edit .env: set BROWNSTONE_AUTH_SECRET (any 32+ char random string).
# Optionally set OPENAI_API_KEY=... to use a real LLM. Without it,
# the local-sim provider responds with synthetic streaming text.
npm run build
npm run dev
```

Open `http://127.0.0.1:8791`. Click **Create account** — the first account becomes the admin.

Try these prompts to see what's possible:

- `Use git_status to show me what's changed.`
- `Use workspace_read on README.md and tell me what it covers.`
- `Write a debounce function in TypeScript.`
- `Explain how Server-Sent Events work.`

## Architecture

```
   Web UI :8791        CLI               VS Code extension
        \              |                 /
         \             |                /
          \  cookies   | bearer        /
           \  + CSRF   | token        /
            \          |             /
             ▼         ▼            ▼
        ┌─────────────────────────────┐
        │  Control plane  :8787       │
        │  /auth /chat /sessions ...  │
        └────┬───────────────┬────────┘
             │               │
        ┌────▼───────┐  ┌────▼───────┐
        │ Task worker│  │ Browser    │  :8788
        │            │  │ worker     │
        └────────────┘  └────────────┘

        ┌────────────────────┐
        │ Scheduler worker   │  fires due ScheduledTasks
        └────────────────────┘
```

Each process is small and owns one concern. Storage is flat JSON files under `BROWNSTONE_DATA_DIR`. All inter-process communication is HTTP on loopback.

## Configuration

Edit `.env`. The essentials:

| Variable | Default | Notes |
|----------|---------|-------|
| `BROWNSTONE_AUTH_SECRET` | (auto-generated, dev only) | 32+ char random string. **Set this in production.** |
| `BROWNSTONE_APPROVAL_TOKEN` | (none) | Required to perform writes when approvals are on |
| `BROWNSTONE_MODE` | `read-only` | One of `read-only`, `workspace-write`, `danger-full-access` |
| `BROWNSTONE_PROVIDER_MODE` | `local-sim` | `local-sim` or `openai` |
| `OPENAI_API_KEY` | — | Required if `BROWNSTONE_PROVIDER_MODE=openai` |
| `BROWNSTONE_DATA_DIR` | `.brownstone-platform` | Where sessions, tasks, telemetry live |
| `BROWNSTONE_REQUIRE_APPROVALS` | `false` | Require approval token for writes |
| `BROWNSTONE_SEARCH_PROVIDER` | `disabled` | `disabled` or `brave` |
| `BRAVE_SEARCH_API_KEY` | — | Required if search is enabled |

See `.env.example` for the full list (~25 options).

## Running the tests

```bash
npm test                # all 173 tests
npm run test:packages    # unit tests only
npm run test:integration # boots a real control plane and exercises it
```

All tests run with Node's built-in test runner — no Jest, no Mocha. Total runtime is about 10 seconds.

## Layout

```
packages/
  contracts/             Domain types (single source of truth)
  errors/                Typed AppError hierarchy
  storage/               File-backed-JSON primitives (atomic writes, mutex)
  config/                loadConfig() with env validation
  auth/                  scrypt + signed cookies + user store + CSRF
  http-kit/              Router, body parsers, graceful shutdown
  security/              Path containment, localhost binding, approval gates
  providers-local-sim/   Synthetic streaming provider for offline dev
  providers-openai/      OpenAI-compatible streaming provider
  session-store/         Per-user session persistence
  telemetry/             Append-only JSONL event log
  memory/                User-scoped notes
  task-queue/            Persistent task queue
  task-executor/         Drains the queue
  runtime/               Chat-turn orchestrator (provider + tools + session)
  browser-automation/    HTTP client to browser worker + stub driver
  git-tools/             git status/diff via spawn (no shell)
  patching/              Parse + apply file mutation plans
  web-search/            Brave Search + disabled fallback
  research/              Search + fetch + summarize
  operations/            Schedules, comments, approvals, exports

apps/
  control-plane/    HTTP API server
  browser-worker/   Page-automation host
  task-worker/      Drains the queue
  scheduler-worker/ Fires due schedules
  web/              Static UI + proxy
  cli/              The `brownstone` command
  vscode-extension/ Chat + dashboard webviews
```

## Status

This is a **0.5.0 pre-1.0 release**. Breaking changes are likely as the project matures. Specifically called out as work-in-progress in `CHANGELOG.md`:

- Browser worker is a stub HTTP client; real Playwright integration is planned
- No rate limiting on `/auth/*` (fine on localhost, problematic on public deployments)
- Sessions are stateless HMAC cookies — logout clears the browser but doesn't revoke the token
- Vector retrieval uses naive term-frequency, not embeddings
- Several backend features (memory, schedules, collaboration comments) are wired but their UIs are minimal

If you're deploying this publicly, read the security section of the changelog first.

## Contributing

See `CONTRIBUTING.md`. Briefly: open an issue for anything non-trivial, branch from main, keep the change focused, add tests, run `npm test` before pushing.

## License

[MIT](LICENSE). Do whatever you want with this, just keep the copyright notice.

## Acknowledgments

This project started as an internal prototype called "Safe Agent Studio" and went through two structured rewrites (a Pass 1 architectural cleanup addressing 22 review findings, and a Pass 2 runtime fill-in with streaming, tool calls, multi-user auth, and 173 tests) before being opened to the public under the Brownstone name. The full rewrite history is in `CHANGELOG.md`.
