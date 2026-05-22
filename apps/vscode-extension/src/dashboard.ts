import * as vscode from 'vscode';
import crypto from 'node:crypto';
import type { AgentConfig } from '@brownstone/contracts';

/**
 * Dashboard that surfaces task/queue/telemetry state.
 *
 * Original behavior: every refresh wrote a new full HTML string into the
 * webview, blowing away scroll position, focus, and selection. The fix is to
 * render a static shell once and then send JSON state diffs via postMessage;
 * the in-webview script reconciles the DOM in place.
 */
export class DashboardView {
  private panel?: vscode.WebviewPanel;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly config: AgentConfig,
  ) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'safeAgentDashboard',
      'Brownstone Dashboard',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = this.renderShell(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose());
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 10_000);
  }

  async refresh(): Promise<void> {
    if (!this.panel) return;
    try {
      const [healthRes, tasksRes, telemetryRes] = await Promise.all([
        this.api('/health'),
        this.api('/tasks'),
        this.api('/telemetry'),
      ]);
      this.panel.webview.postMessage({
        type: 'state',
        payload: {
          health: healthRes,
          tasks: tasksRes,
          telemetry: telemetryRes,
        },
      });
    } catch (error) {
      this.panel.webview.postMessage({ type: 'error', message: (error as Error).message });
    }
  }

  private async api(path: string): Promise<unknown> {
    const response = await fetch(`${this.config.controlPlaneBaseUrl}${path}`, {
      headers: this.config.controlPlaneToken
        ? { authorization: `Bearer ${this.config.controlPlaneToken}` }
        : {},
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`${response.status} ${response.statusText}: ${detail}`);
    }
    return response.json();
  }

  private dispose(): void {
    this.panel = undefined;
    if (this.timer) clearInterval(this.timer);
  }

  private renderShell(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      `connect-src ${this.config.controlPlaneBaseUrl}`,
    ].join('; ');

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Brownstone Dashboard</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
    h2 { margin-top: 24px; font-size: 14px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
    .row { padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border); }
    .row:last-child { border-bottom: none; }
    .status { display: inline-block; padding: 2px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; margin-right: 8px; }
    #error { color: var(--vscode-errorForeground); font-size: 12px; }
  </style>
</head>
<body>
  <div id="error"></div>
  <section><h2>Health</h2><div id="health">Loading…</div></section>
  <section><h2>Tasks</h2><div id="tasks"></div></section>
  <section><h2>Telemetry</h2><div id="telemetry"></div></section>
  <script nonce="${nonce}">
    function renderHealth(health) {
      const root = document.getElementById('health');
      root.replaceChildren();
      if (!health) return;
      const keys = ['mode', 'providerMode', 'host', 'port', 'approvalRequired', 'externalApprovalRequired'];
      for (const key of keys) {
        const row = document.createElement('div');
        row.className = 'row';
        const k = document.createElement('strong');
        k.textContent = key + ': ';
        const v = document.createElement('span');
        v.textContent = String(health[key]);
        row.append(k, v);
        root.append(row);
      }
    }

    function renderTasks(tasks) {
      const root = document.getElementById('tasks');
      const current = new Map(Array.from(root.children).map((child) => [child.dataset.id, child]));
      const seen = new Set();
      for (const task of (tasks ?? [])) {
        seen.add(task.id);
        let row = current.get(task.id);
        if (!row) {
          row = document.createElement('div');
          row.className = 'row';
          row.dataset.id = task.id;
          root.append(row);
        }
        row.replaceChildren();
        const status = document.createElement('span');
        status.className = 'status';
        status.textContent = task.status;
        const text = document.createElement('span');
        text.textContent = task.id.slice(0, 12) + ' · ' + task.kind;
        row.append(status, text);
      }
      // Remove rows for tasks that have disappeared.
      for (const [id, row] of current) {
        if (!seen.has(id)) row.remove();
      }
    }

    function renderTelemetry(events) {
      const root = document.getElementById('telemetry');
      root.replaceChildren();
      for (const event of (events ?? []).slice(-20).reverse()) {
        const row = document.createElement('div');
        row.className = 'row';
        const t = document.createElement('span');
        t.style.opacity = '0.7';
        t.style.fontSize = '11px';
        t.textContent = new Date(event.timestamp).toLocaleTimeString() + ' ';
        const k = document.createElement('strong');
        k.textContent = event.type;
        row.append(t, k);
        root.append(row);
      }
    }

    window.addEventListener('message', (event) => {
      const { type, payload, message } = event.data ?? {};
      const errorBox = document.getElementById('error');
      if (type === 'error') {
        errorBox.textContent = message ?? '';
        return;
      }
      errorBox.textContent = '';
      if (type === 'state') {
        renderHealth(payload?.health);
        renderTasks(payload?.tasks);
        renderTelemetry(payload?.telemetry);
      }
    });
  </script>
</body>
</html>`;
  }
}
