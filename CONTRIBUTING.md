# Contributing to Brownstone

Thanks for thinking about contributing. This document lays out how the project is organized, how to get set up, and what to do when you want to make a change.

## Getting set up

You need Node.js 22 or newer. Then:

```bash
git clone https://github.com/<your-username>/brownstone.git
cd brownstone
npm install
npm test
```

If the tests pass (173 of them, all green in under 10 seconds), you have a working dev environment.

To run the actual app:

```bash
cp .env.example .env
# Edit .env to set BROWNSTONE_AUTH_SECRET (any 32+ char random string)
# Optionally set OPENAI_API_KEY to use a real LLM (otherwise it uses local-sim)
npm run build
npm run dev
```

Then open `http://127.0.0.1:8791`. First account you create becomes admin.

## Layout

This is an npm workspace monorepo. The two top-level directories are:

- `packages/` — reusable libraries (`@brownstone/auth`, `@brownstone/runtime`, etc.). Each has its own `src/`, `test/`, `package.json`.
- `apps/` — actual processes: control plane, browser worker, task worker, scheduler, web UI, CLI, VS Code extension.

Open `packages/contracts/src/` for the type definitions — that's the best place to understand what each piece does before diving into implementations.

## Making a change

1. **Open an issue first** for anything non-trivial. Half-hour fix, just open a PR. Architecture-altering thing, let's discuss before you spend an afternoon on it.
2. **Branch from `main`**: `git checkout -b your-change-description`
3. **Keep the change focused.** One concern per PR. Unrelated refactors go in separate PRs.
4. **Add tests.** Every existing package has a `test/` directory using Node's built-in test runner. Match the style — `test('what it does', ...)` with `assert` from `node:assert/strict`. Aim for one test per behavior.
5. **Run `npm test` before pushing.** The CI will run it for you, but catching failures locally is faster.
6. **Write a clear commit message.** First line is a short summary in present tense ("Add retry to web search" not "Added retry"). Body explains *why* if the *what* isn't obvious from the diff.

## Adding a new tool

Tools live in `packages/runtime/src/builtin-tools.ts`. The pattern is:

```ts
const myTool: Tool = {
  definition: {
    name: 'my_tool',
    description: 'What the model should know about this tool.',
    inputSchema: { type: 'object', properties: { /* ... */ } },
  },
  async run(input, context) {
    // do work; return { ok: true, content: '...' } or { ok: false, content: 'error' }
  },
};
```

Add it to the array returned by `builtinTools()`. Write tests in `packages/runtime/test/builtin-tools.test.ts`. That's the whole ceremony.

## Adding a new LLM provider

Implement the `ModelProvider` interface from `packages/contracts/src/chat.ts`. There are two reference implementations in `packages/providers-local-sim` and `packages/providers-openai`; copy whichever is closer to your target.

## Style

- TypeScript everywhere except the CLI and the browser UI modules (vanilla JS).
- No semicolons-as-statement-terminators-everywhere... actually, we use them. Stay consistent.
- No frameworks in the runtime — Node built-ins, contracts, and the project's own packages only.
- The browser UI also avoids frameworks. Plain ES modules, vanilla DOM. We don't want to chase React versions.
- Tests use Node's `node:test` runner. No Jest, no Mocha.
- Errors flow through the typed `AppError` hierarchy in `@brownstone/errors`. Don't throw plain `Error` from middleware or handlers.

## What we want help with

A non-exhaustive list:

- More built-in tools (file write through patches, shell with allowlist, calendar, etc.)
- A real Playwright driver in the browser worker (currently a stub)
- A vector retrieval backend instead of the naive term-frequency one
- An Anthropic-native provider that uses thinking tokens
- VS Code extension polish (better markdown rendering in the webview)
- Documentation, examples, tutorials

If you want to take on one of these, open an issue first so we can discuss the approach.

## What we don't want

- Pull requests that rewrite the project's architecture without discussion.
- Adding heavy dependencies. We've stayed dep-light deliberately.
- Code without tests.
- Pull requests with no description.

## Code of conduct

See `CODE_OF_CONDUCT.md`. Short version: be respectful, assume good faith, no harassment.

## Questions

Open a discussion in the GitHub Discussions tab, or file an issue with the `question` label.
