import * as vscode from 'vscode';
import crypto from 'node:crypto';
import type { AgentConfig } from '@brownstone/contracts';

/**
 * Webview that proxies to the control plane's /chat route.
 *
 * CSP locks down everything except inline styles (needed for VS Code theme
 * integration) and the single inline script tagged with our per-load nonce.
 * No remote resources are loaded.
 */
export class ChatHostView {
  private panel?: vscode.WebviewPanel;

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
      'safeAgentChat',
      'Brownstone Chat',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = this.renderHtml(this.panel.webview);
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.panel.webview.onDidReceiveMessage((message) => this.handle(message));
  }

  private async handle(message: { type: string; [key: string]: unknown }): Promise<void> {
    if (!this.panel) return;
    if (message.type === 'send') {
      try {
        const response = await fetch(`${this.config.controlPlaneBaseUrl}/chat`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: this.config.controlPlaneToken ? `Bearer ${this.config.controlPlaneToken}` : '',
          },
          body: JSON.stringify({ sessionId: message.sessionId, prompt: message.prompt }),
        });
        const data = await response.json();
        this.panel.webview.postMessage({ type: 'reply', data });
      } catch (error) {
        this.panel.webview.postMessage({ type: 'error', message: (error as Error).message });
      }
    }
  }

  private renderHtml(webview: vscode.Webview): string {
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
  <title>Brownstone Chat</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
    #log { border: 1px solid var(--vscode-panel-border); padding: 8px; min-height: 200px; max-height: 50vh; overflow: auto; }
    #form { display: flex; gap: 8px; margin-top: 12px; }
    textarea { flex: 1; }
  </style>
</head>
<body>
  <div id="log"></div>
  <form id="form">
    <textarea id="input" rows="3" placeholder="Ask the agent…"></textarea>
    <button type="submit">Send</button>
  </form>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = vscode.getState() ?? { sessionId: null, log: [] };
    const log = document.getElementById('log');
    const input = document.getElementById('input');

    function render() {
      log.replaceChildren();
      for (const line of state.log) {
        const div = document.createElement('div');
        div.textContent = line;
        log.append(div);
      }
      log.scrollTop = log.scrollHeight;
    }
    render();

    document.getElementById('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      state.log.push('You: ' + text);
      vscode.setState(state); render();
      vscode.postMessage({ type: 'send', sessionId: state.sessionId, prompt: text });
      input.value = '';
    });

    window.addEventListener('message', (event) => {
      const { type, data, message } = event.data ?? {};
      if (type === 'reply') {
        state.log.push('Agent: ' + (data?.answer ?? '(no reply)'));
      } else if (type === 'error') {
        state.log.push('Error: ' + message);
      }
      vscode.setState(state); render();
    });
  </script>
</body>
</html>`;
  }
}
