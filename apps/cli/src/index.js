#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Command } from 'commander';
import { loadConfig } from '@brownstone/config';

/**
 * Brownstone CLI.
 *
 * Replaces the previous hand-rolled `--mode=X` argument parser that did not
 * support `--mode X` syntax, had no `--help`, and silently ignored typos.
 *
 * Auth flow:
 *   `sa login`    → prompts for email/password, stores token at ~/.brownstone/token
 *   `sa logout`   → deletes the stored token
 *   all other commands read the token and send it as Authorization: Bearer.
 */

const CONFIG_DIR = path.join(os.homedir(), '.brownstone');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token');

async function readToken() {
  try { return (await fs.readFile(TOKEN_FILE, 'utf8')).trim(); }
  catch { return null; }
}

async function writeToken(token) {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(TOKEN_FILE, token, { mode: 0o600 });
}

async function deleteToken() {
  await fs.unlink(TOKEN_FILE).catch(() => undefined);
}

async function callApi(method, path, options = {}) {
  const config = loadConfig();
  const token = options.token ?? await readToken();
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.approvalToken) headers['x-brownstone-approval'] = options.approvalToken;

  const response = await fetch(`${config.controlPlaneBaseUrl}${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!response.ok) {
    const message = parsed?.error || `${response.status} ${response.statusText}`;
    const error = new Error(message);
    error.statusCode = response.status;
    throw error;
  }
  return parsed;
}

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

/**
 * Ask the user a question. When `silent` is set, characters are not echoed —
 * useful for password input. Uses raw mode so the user's typed bytes never
 * appear on screen and never end up in their shell history.
 */
async function prompt(question, opts = {}) {
  if (!opts.silent) {
    const rl = readline.createInterface({ input, output });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }
  // Silent mode: take over stdin manually and read one line.
  output.write(question);
  const wasRaw = input.isTTY ? input.isRaw : false;
  if (input.isTTY) input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');

  let buffer = '';
  try {
    for await (const chunk of input) {
      for (const char of chunk) {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          output.write('\n');
          return buffer;
        }
        if (char === '\u0003') { // Ctrl-C
          output.write('\n');
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') { // backspace
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += char;
      }
    }
    return buffer;
  } finally {
    if (input.isTTY) input.setRawMode(wasRaw);
    input.pause();
  }
}

const program = new Command();
program
  .name('sa')
  .description('Brownstone CLI — talk to your local control plane from the terminal')
  .version('0.5.0');

program
  .command('login')
  .description('Authenticate with the control plane and store a token')
  .option('-e, --email <email>', 'email')
  .option('-p, --password <password>', 'password (avoid; prefer interactive prompt)')
  .action(async (options) => {
    const email = options.email ?? await prompt('Email: ');
    const password = options.password ?? await prompt('Password: ', { silent: true });
    try {
      const result = await callApi('POST', '/auth/login', { body: { email, password } });
      await writeToken(result.token);
      console.log(`Logged in as ${result.user.email} (${result.user.role}).`);
    } catch (error) {
      console.error(`Login failed: ${error.message}`);
      process.exitCode = 1;
    }
  });

program
  .command('register')
  .description('Create a new account on the control plane')
  .option('-e, --email <email>', 'email')
  .option('-n, --display-name <name>', 'display name')
  .action(async (options) => {
    const email = options.email ?? await prompt('Email: ');
    const password = await prompt('Password: ', { silent: true });
    const displayName = options.displayName ?? await prompt('Display name (optional): ');
    try {
      const result = await callApi('POST', '/auth/register', {
        body: { email, password, displayName },
      });
      await writeToken(result.token);
      console.log(`Registered as ${result.user.email} (${result.user.role}).`);
    } catch (error) {
      console.error(`Registration failed: ${error.message}`);
      process.exitCode = 1;
    }
  });

program
  .command('logout')
  .description('Forget the stored access token')
  .action(async () => {
    await deleteToken();
    console.log('Logged out.');
  });

program
  .command('whoami')
  .description('Show the current authenticated user')
  .action(async () => {
    try {
      const me = await callApi('GET', '/auth/me');
      console.log(`${me.email} (${me.role}) — ${me.displayName || '(no display name)'}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  });

program
  .command('chat')
  .description('Send a chat turn, streaming the response token-by-token')
  .requiredOption('-s, --session <id>', 'session id')
  .requiredOption('-p, --prompt <text>', 'prompt')
  .option('--no-stream', 'use the non-streaming /chat endpoint instead')
  .action(async (options) => {
    try {
      if (options.stream === false) {
        const result = await callApi('POST', '/chat', {
          body: { sessionId: options.session, prompt: options.prompt },
        });
        process.stdout.write(result.answer + '\n');
        return;
      }
      await streamChat(options.session, options.prompt);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  });

/**
 * Stream a chat turn via /chat/stream (SSE). Writes tokens as they arrive
 * and surfaces tool-call activity inline.
 */
async function streamChat(sessionId, prompt) {
  const config = loadConfig();
  const token = await readToken();
  if (!token) {
    console.error('Not authenticated. Run `sa login` first.');
    process.exitCode = 1;
    return;
  }

  const response = await fetch(`${config.controlPlaneBaseUrl}/chat/stream`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ sessionId, prompt }),
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    console.error(`Stream failed (${response.status}): ${text}`);
    process.exitCode = 1;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separatorIndex;
    while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const event = parseSseEvent(rawEvent);
      if (!event) continue;
      handleStreamEvent(event);
    }
  }
  process.stdout.write('\n');
}

function parseSseEvent(raw) {
  const lines = raw.split('\n');
  let eventType = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event:')) eventType = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try { return { type: eventType, data: JSON.parse(dataLines.join('\n')) }; }
  catch { return null; }
}

function handleStreamEvent(event) {
  const data = event.data;
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(data.text);
      return;
    case 'tool_call_start':
      process.stdout.write(`\n[tool] ${data.toolName}(${formatInput(data.input)}) `);
      return;
    case 'tool_call_end':
      process.stdout.write(`${data.ok ? '✓' : '✗'} ${data.durationMs}ms\n`);
      return;
    case 'error':
      process.stderr.write(`\n[error] ${data.message}\n`);
      return;
    default:
      return;
  }
}

function formatInput(input) {
  const entries = Object.entries(input ?? {});
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => {
      const str = typeof v === 'string' ? `"${v.slice(0, 40)}"` : JSON.stringify(v).slice(0, 40);
      return `${k}=${str}`;
    })
    .join(', ');
}

program
  .command('sessions')
  .description('List your sessions')
  .action(async () => {
    try {
      const sessions = await callApi('GET', '/sessions');
      if (!sessions.length) { console.log('(no sessions)'); return; }
      for (const session of sessions) {
        console.log(`${session.id}  created ${session.createdAt}  turns=${session.turns?.length ?? 0}`);
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  });

program
  .command('new-session')
  .description('Start a new session')
  .action(async () => {
    try {
      const session = await callApi('POST', '/sessions', { body: {} });
      console.log(session.id);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  });

program
  .command('tasks')
  .description('List your tasks')
  .action(async () => {
    try {
      const tasks = await callApi('GET', '/tasks');
      if (!tasks.length) { console.log('(no tasks)'); return; }
      for (const task of tasks) {
        console.log(`${task.status.padEnd(10)} ${task.id}  ${task.kind}  ${task.createdAt}`);
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  });

program
  .command('health')
  .description('Check the control plane is alive')
  .action(async () => {
    try {
      const health = await callApi('GET', '/health');
      console.log(JSON.stringify(health, null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
