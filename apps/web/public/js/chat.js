/**
 * Chat module: streaming + tool calls + markdown, rendered into the original
 * design's message-stream / message-bubble DOM.
 *
 * Public API: init({ ...elements }), refreshSessions(), setThinkingModeProvider().
 *
 * Layout:
 *   For each turn we append one .message-bubble.user and one
 *   .message-bubble.assistant. Tool calls appear inside the assistant bubble.
 *   Markdown is rendered with the same renderer chat used before.
 */

import { api } from './api.js';
import { getApprovalToken } from './approval.js';
import { renderMarkdown } from './markdown.js';

let activeSessionId = null;
let activeStreamAbort = null;
let getThinkingMode = () => 'balanced';

// DOM handles, populated by init().
let messageStream = null;
let chatInput = null;
let sendButton = null;
let sessionSelect = null;
let newSessionButton = null;
let welcomeCard = null;

export function setThinkingModeProvider(fn) {
  if (typeof fn === 'function') getThinkingMode = fn;
}

// ---------- Rendering primitives ----------

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
}

function buildUserBubble(text) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message-bubble user';
  wrapper.innerHTML = `<div class="message-meta">You</div>`;
  const p = document.createElement('p');
  p.textContent = text;
  wrapper.appendChild(p);
  return wrapper;
}

function buildAssistantBubble(initialText = '') {
  const wrapper = document.createElement('div');
  wrapper.className = 'message-bubble assistant';

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = 'Brownstone';
  wrapper.appendChild(meta);

  const body = document.createElement('div');
  body.className = 'message-body';
  body.dataset.role = 'assistant-text';
  body.innerHTML = renderMarkdown(initialText);
  wrapper.appendChild(body);

  const toolList = document.createElement('div');
  toolList.className = 'tool-calls';
  toolList.dataset.role = 'tool-list';
  wrapper.appendChild(toolList);

  return wrapper;
}

function buildToolCallElement(call) {
  const el = document.createElement('details');
  el.className = 'tool-call';
  el.dataset.callId = call.id;
  el.dataset.status = call.result ? (call.result.ok ? 'ok' : 'failed') : 'running';

  const summary = document.createElement('summary');
  const indicator = document.createElement('span');
  indicator.className = 'tool-indicator';
  indicator.textContent = el.dataset.status === 'running' ? '⋯' : el.dataset.status === 'ok' ? '✓' : '✗';
  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = call.toolName;
  const duration = document.createElement('span');
  duration.className = 'tool-duration';
  duration.dataset.role = 'duration';
  duration.textContent = call.result?.durationMs ? ` ${call.result.durationMs}ms` : '';
  summary.append(indicator, document.createTextNode(' '), name, duration);
  el.append(summary);

  const inputBlock = document.createElement('pre');
  inputBlock.className = 'tool-io';
  inputBlock.innerHTML = `<strong>Input</strong>\n${escapeHtml(JSON.stringify(call.input ?? {}, null, 2))}`;
  el.append(inputBlock);

  const outputBlock = document.createElement('pre');
  outputBlock.className = 'tool-io';
  outputBlock.dataset.role = 'output';
  outputBlock.innerHTML = `<strong>Output</strong>\n${escapeHtml(call.result?.content ?? '(pending)')}`;
  el.append(outputBlock);

  return el;
}

function hideWelcomeCard() {
  if (welcomeCard && !welcomeCard.hidden) welcomeCard.hidden = true;
}

function renderTurns(turns) {
  // Clear existing messages but keep the welcome card placeholder.
  for (const node of [...messageStream.children]) {
    if (node !== welcomeCard) node.remove();
  }
  if (turns.length === 0) {
    if (welcomeCard) welcomeCard.hidden = false;
    return;
  }
  hideWelcomeCard();

  for (const turn of turns) {
    messageStream.appendChild(buildUserBubble(turn.user));
    const assistantBubble = buildAssistantBubble(turn.assistant ?? '');
    if (turn.toolCalls?.length) {
      const toolList = assistantBubble.querySelector('[data-role="tool-list"]');
      for (const call of turn.toolCalls) toolList.appendChild(buildToolCallElement(call));
    }
    messageStream.appendChild(assistantBubble);
  }
  scrollToBottom();
}

function scrollToBottom() {
  const nearBottom = messageStream.scrollHeight - messageStream.scrollTop - messageStream.clientHeight < 100;
  if (nearBottom) messageStream.scrollTop = messageStream.scrollHeight;
}

// ---------- SSE parsing ----------

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

// ---------- Streaming ----------

async function streamTurn(sessionId, prompt) {
  hideWelcomeCard();
  messageStream.appendChild(buildUserBubble(prompt));
  const assistantBubble = buildAssistantBubble('');
  messageStream.appendChild(assistantBubble);
  scrollToBottom();

  const assistantText = assistantBubble.querySelector('[data-role="assistant-text"]');
  const toolList = assistantBubble.querySelector('[data-role="tool-list"]');
  let buffer = '';
  const toolElementsByCallId = new Map();

  const controller = new AbortController();
  activeStreamAbort = () => controller.abort();

  const approvalToken = getApprovalToken();
  const csrf = await api('GET', '/auth/csrf').catch(() => null);
  const csrfHeader = csrf?.csrfToken;

  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(csrfHeader ? { 'x-brownstone-csrf': csrfHeader } : {}),
      ...(approvalToken ? { 'x-brownstone-approval': approvalToken } : {}),
    },
    body: JSON.stringify({ sessionId, prompt, thinkingMode: getThinkingMode() }),
    signal: controller.signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    assistantText.innerHTML = renderMarkdown(`**Error:** ${text || response.statusText}`);
    activeStreamAbort = null;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      let separatorIndex;
      while ((separatorIndex = sseBuffer.indexOf('\n\n')) !== -1) {
        const raw = sseBuffer.slice(0, separatorIndex);
        sseBuffer = sseBuffer.slice(separatorIndex + 2);
        const event = parseSseEvent(raw);
        if (!event) continue;
        const data = event.data;
        switch (event.type) {
          case 'text_delta':
            buffer += data.text;
            assistantText.innerHTML = renderMarkdown(buffer);
            break;
          case 'tool_call_start': {
            const el = buildToolCallElement({ id: data.callId, toolName: data.toolName, input: data.input });
            toolList.appendChild(el);
            toolElementsByCallId.set(data.callId, el);
            break;
          }
          case 'tool_call_end': {
            const el = toolElementsByCallId.get(data.callId);
            if (!el) break;
            el.dataset.status = data.ok ? 'ok' : 'failed';
            el.querySelector('.tool-indicator').textContent = data.ok ? '✓' : '✗';
            el.querySelector('[data-role="duration"]').textContent = ` ${data.durationMs}ms`;
            el.querySelector('[data-role="output"]').innerHTML = `<strong>Output</strong>\n${escapeHtml(data.output)}`;
            break;
          }
          case 'error':
            assistantText.innerHTML += `<p class="md-p"><em>Error: ${escapeHtml(data.message)}</em></p>`;
            break;
          default:
            break;
        }
        scrollToBottom();
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      assistantText.innerHTML += `<p class="md-p"><em>Stream interrupted: ${escapeHtml(error.message)}</em></p>`;
    }
  } finally {
    activeStreamAbort = null;
  }
}

// ---------- Session list ----------

export async function refreshSessions() {
  const sessions = await api('GET', '/sessions');
  sessionSelect.replaceChildren();
  for (const session of sessions) {
    const option = document.createElement('option');
    option.value = session.id;
    const label = session.title || `Session ${session.id.slice(0, 8)}`;
    option.textContent = `${label} · ${new Date(session.updatedAt).toLocaleTimeString()}`;
    sessionSelect.appendChild(option);
  }
  if (sessions.length && !activeSessionId) {
    activeSessionId = sessions[0].id;
    sessionSelect.value = activeSessionId;
    await loadAndRender(activeSessionId);
  } else if (activeSessionId) {
    sessionSelect.value = activeSessionId;
  } else {
    renderTurns([]);
  }
}

async function loadAndRender(id) {
  const session = await api('GET', `/sessions/${encodeURIComponent(id)}`);
  activeSessionId = id;
  renderTurns(session.turns ?? []);
}

// ---------- Init ----------

export function init(opts) {
  messageStream = opts.messageStream;
  chatInput = opts.input;
  sendButton = opts.sendButton;
  sessionSelect = opts.sessionSelect;
  newSessionButton = opts.newSessionButton;
  welcomeCard = opts.welcomeCard;

  sessionSelect.addEventListener('change', (event) => {
    if (activeStreamAbort) activeStreamAbort();
    loadAndRender(event.target.value).catch((error) => console.error('Load session failed:', error));
  });

  newSessionButton.addEventListener('click', async () => {
    if (activeStreamAbort) activeStreamAbort();
    const session = await api('POST', '/sessions', { body: {} });
    activeSessionId = session.id;
    await refreshSessions();
    renderTurns([]);
    chatInput.focus();
  });

  sendButton.addEventListener('click', () => triggerSend());
  chatInput.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      triggerSend();
    }
  });
}

async function triggerSend() {
  const prompt = chatInput.value.trim();
  if (!prompt) return;
  if (!activeSessionId) {
    // Create a session lazily for first-time users.
    const session = await api('POST', '/sessions', { body: {} });
    activeSessionId = session.id;
    await refreshSessions();
  }
  chatInput.disabled = true;
  sendButton.disabled = true;
  try {
    await streamTurn(activeSessionId, prompt);
    chatInput.value = '';
  } catch (error) {
    console.error('Stream failed:', error);
  } finally {
    chatInput.disabled = false;
    sendButton.disabled = false;
    chatInput.focus();
  }
}
