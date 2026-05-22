/**
 * Top-level wiring for the Brownstone UI.
 *
 * Layout follows the original three-panel design (chat → dashboard → preview).
 * Backend wiring uses the Pass 2 modules:
 *   - api.js        : fetch wrapper, CSRF, 401 handling
 *   - auth.js       : login overlay, session bootstrap
 *   - approval.js   : per-action approval token
 *   - chat.js       : streaming chat with tool-call rendering
 *   - markdown.js   : safe markdown renderer for assistant text
 *
 * This file owns:
 *   - Auth state binding (showing/hiding the overlay + user pill)
 *   - Thinking-mode select
 *   - Suggestion pills (generic, no brand mentions)
 *   - Dashboard refresh (health, schedules, exports, uploads, file tree, telemetry)
 *   - Preview tab switching
 *   - Approval token bar wiring
 *   - The thin "send" pipeline that hands prompts to chat.js
 */

import { api, configureClient } from './js/api.js';
import * as approval from './js/approval.js';
import * as auth from './js/auth.js';
import * as chat from './js/chat.js';
import { renderMarkdown } from './js/markdown.js';

// ---------- DOM lookup ----------
const elements = {
  // Header
  healthPill: document.getElementById('health-pill'),
  modePill: document.getElementById('mode-pill'),
  userPill: document.getElementById('user-pill'),
  logoutButton: document.getElementById('logout-button'),
  thinkingMode: document.getElementById('thinking-mode'),

  // Chat panel
  modeStrip: document.getElementById('mode-strip'),
  templateGrid: document.getElementById('template-grid'),
  messageStream: document.getElementById('message-stream'),
  welcomeCard: document.getElementById('welcome-card'),
  chatInput: document.getElementById('chat-input'),
  sendButton: document.getElementById('send-button'),
  sessionSelect: document.getElementById('session-select'),
  newSessionButton: document.getElementById('new-session-button'),
  suggestions: document.getElementById('suggestions'),
  uploadInput: document.getElementById('upload-input'),
  uploadButton: document.getElementById('upload-button'),
  scheduleButton: document.getElementById('schedule-button'),
  exportButton: document.getElementById('export-button'),

  // Dashboard panel
  refreshButton: document.getElementById('refresh-button'),
  statusGrid: document.getElementById('status-grid'),
  safeDefaults: document.getElementById('safe-defaults'),
  fileTree: document.getElementById('file-tree'),
  sourceList: document.getElementById('source-list'),
  uploadsList: document.getElementById('uploads-list'),
  scheduleList: document.getElementById('schedule-list'),
  exportsList: document.getElementById('exports-list'),
  activityFeed: document.getElementById('activity-feed'),

  // Preview panel
  previewStack: document.getElementById('preview-stack'),
  textPreview: document.getElementById('text-preview'),
  previewEmpty: document.getElementById('preview-empty'),

  // Login overlay
  authOverlay: document.getElementById('auth-overlay'),

  // Approval bar
  approvalToken: document.getElementById('approval-token'),
  approvalClear: document.getElementById('approval-clear'),
};

// ---------- State ----------
const state = {
  thinkingMode: 'balanced',
};

// ---------- Suggestion pills ----------
// Generic, brand-neutral starters that work for any project.
const DEFAULT_SUGGESTIONS = [
  'Summarize the files in my workspace and tell me what to focus on.',
  'Help me draft a README for this project.',
  'Search the web for recent best practices on prompt engineering.',
  'Use git_status to show me what has changed.',
];

function renderSuggestionPills(prompts) {
  elements.suggestions.innerHTML = '';
  for (const prompt of prompts) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion-pill ghost-button';
    button.textContent = prompt;
    button.addEventListener('click', () => {
      elements.chatInput.value = prompt;
      elements.chatInput.focus();
    });
    elements.suggestions.appendChild(button);
  }
}

// ---------- Auth state binding ----------
function bindAuthState(user) {
  if (user) {
    elements.authOverlay.hidden = true;
    elements.userPill.hidden = false;
    elements.userPill.textContent = `${user.displayName || user.email} · ${user.role}`;
    elements.logoutButton.hidden = false;
  } else {
    elements.authOverlay.hidden = false;
    elements.userPill.hidden = true;
    elements.logoutButton.hidden = true;
  }
}

// ---------- Dashboard refresh ----------
async function refreshHealth() {
  try {
    const health = await api('GET', '/health');
    elements.healthPill.textContent = health.ok ? 'Connected' : 'Degraded';
    elements.modePill.textContent = `${health.mode} · ${health.providerMode}`;
  } catch {
    elements.healthPill.textContent = 'Offline';
    elements.modePill.textContent = 'Mode unknown';
  }
}

function renderSafeDefaults(health) {
  const items = [
    { label: 'Permission mode', value: health?.mode ?? '—' },
    { label: 'Provider', value: health?.providerMode ?? '—' },
    { label: 'Approval required (writes)', value: health?.approvalRequired ? 'On' : 'Off' },
    { label: 'External-action approval', value: health?.externalApprovalRequired ? 'On' : 'Off' },
  ];
  elements.safeDefaults.innerHTML = items
    .map((item) => `<div class="safety-item"><span>${item.label}</span><strong>${escapeHtml(String(item.value))}</strong></div>`)
    .join('');
}

async function refreshDashboard() {
  // The dashboard reads from several endpoints. Each is wrapped so one
  // failure doesn't blank the rest. Empty states are shown as placeholders.
  const [health, schedules, exports, uploads, fileTree, telemetry] = await Promise.all([
    api('GET', '/health').catch(() => null),
    api('GET', '/schedules').catch(() => []),
    api('GET', '/exports').catch(() => []),
    api('GET', '/uploads').catch(() => []),
    api('GET', '/workspace/tree').catch(() => ({ entries: [] })),
    api('GET', '/telemetry').catch(() => []),
  ]);

  renderSafeDefaults(health);
  renderFileTree(fileTree?.entries ?? []);
  renderSimpleList(elements.scheduleList, schedules, (s) => `${s.prompt?.slice(0, 60) ?? s.id} <span class="small-pill">${s.cadence ?? ''}</span>`);
  renderSimpleList(elements.exportsList, exports, (e) => `${e.title ?? e.id}`);
  renderSimpleList(elements.uploadsList, uploads, (u) => `${u.filename ?? u.id} <span class="small-pill">${(u.bytes ?? 0)} B</span>`);
  renderActivity(telemetry);
  renderStatusGrid(health);
}

function renderStatusGrid(health) {
  if (!health) {
    elements.statusGrid.innerHTML = '';
    return;
  }
  const cards = [
    { title: 'Status', value: health.ok ? 'Connected' : 'Degraded', tone: health.ok ? 'success' : 'warning' },
    { title: 'Mode', value: health.mode, tone: 'neutral' },
    { title: 'Provider', value: health.providerMode, tone: 'neutral' },
  ];
  elements.statusGrid.innerHTML = cards
    .map((c) => `
      <div class="status-card status-${c.tone}">
        <span class="small-pill">${c.title}</span>
        <strong>${escapeHtml(c.value ?? '—')}</strong>
      </div>
    `)
    .join('');
}

function renderFileTree(entries) {
  if (!entries.length) {
    elements.fileTree.innerHTML = '<div class="empty-state">Workspace is empty.</div>';
    return;
  }
  function nodeHtml(entry, depth = 0) {
    const pad = `style="padding-left: ${depth * 14}px"`;
    if (entry.type === 'dir') {
      const children = (entry.children ?? []).map((c) => nodeHtml(c, depth + 1)).join('');
      return `<div class="file-node" ${pad}><strong>📁 ${escapeHtml(entry.name)}</strong></div>${children}`;
    }
    return `<div class="file-node" ${pad}>📄 ${escapeHtml(entry.name)}</div>`;
  }
  elements.fileTree.innerHTML = entries.map((e) => nodeHtml(e)).join('');
}

function renderSimpleList(target, items, renderFn) {
  if (!items?.length) {
    target.innerHTML = '<div class="empty-state">None yet.</div>';
    return;
  }
  target.innerHTML = items.map((item) => `<div class="file-node">${renderFn(item)}</div>`).join('');
}

function renderActivity(events) {
  if (!events?.length) {
    elements.activityFeed.innerHTML = '<div class="empty-state">No activity recorded yet.</div>';
    return;
  }
  elements.activityFeed.innerHTML = events
    .slice(-20)
    .reverse()
    .map((event) => `
      <div class="activity-item">
        <span class="small-pill">${escapeHtml(event.kind ?? 'event')}</span>
        <span>${escapeHtml(event.message ?? JSON.stringify(event.payload ?? {}))}</span>
        <span class="muted">${event.timestamp ?? ''}</span>
      </div>
    `)
    .join('');
}

// ---------- Preview tabs ----------
function bindPreviewTabs() {
  const buttons = document.querySelectorAll('.preview-panel .tab-button');
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const tab = button.dataset.tab;
      for (const b of buttons) b.classList.toggle('active', b === button);
      for (const surface of document.querySelectorAll('.preview-surface')) {
        surface.classList.toggle('active', surface.dataset.surface === tab);
      }
    });
  }
}

// ---------- Approval bar ----------
function bindApprovalBar() {
  elements.approvalToken.value = approval.getApprovalToken() ?? '';
  elements.approvalToken.addEventListener('input', () => {
    approval.setApprovalToken(elements.approvalToken.value.trim() || null);
  });
  elements.approvalClear.addEventListener('click', () => {
    elements.approvalToken.value = '';
    approval.setApprovalToken(null);
  });
}

// ---------- Thinking mode ----------
function bindThinkingMode() {
  elements.thinkingMode.addEventListener('change', () => {
    state.thinkingMode = elements.thinkingMode.value;
    // The mode is passed through to chat.js via a getter so its streaming
    // pipeline picks up the current selection at send time.
    chat.setThinkingModeProvider(() => state.thinkingMode);
  });
  chat.setThinkingModeProvider(() => state.thinkingMode);
}

// ---------- Misc ----------
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
}

// ---------- Boot ----------
async function start() {
  approval.init();
  auth.init();
  configureClient({ onUnauthorized: () => auth.bootstrap() });

  let initialized = false;
  auth.onAuthChange(async (user) => {
    bindAuthState(user);
    if (user) {
      if (!initialized) {
        // Chat module wires the message stream, send button, session list,
        // composer keyboard shortcuts. Runs exactly once on first login.
        chat.init({
          messageStream: elements.messageStream,
          input: elements.chatInput,
          sendButton: elements.sendButton,
          sessionSelect: elements.sessionSelect,
          newSessionButton: elements.newSessionButton,
          welcomeCard: elements.welcomeCard,
        });
        bindThinkingMode();
        bindPreviewTabs();
        bindApprovalBar();
        renderSuggestionPills(DEFAULT_SUGGESTIONS);
        elements.refreshButton.addEventListener('click', () => refreshDashboard().catch(console.error));
        initialized = true;
      }
      await Promise.all([refreshHealth(), refreshDashboard(), chat.refreshSessions()]).catch(console.error);
    }
  });

  await auth.bootstrap();
}

start().catch((error) => console.error('App start failed:', error));
