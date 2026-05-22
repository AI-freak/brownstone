import * as vscode from 'vscode';
import { ChatHostView } from './host.js';
import { DashboardView } from './dashboard.js';

/**
 * VS Code extension entrypoint.
 *
 * Fixes from review:
 *   #19 — Config is now loaded lazily inside `activate`, so an invalid env
 *         no longer crashes module loading and the error is surfaced as a
 *         user-visible toast.
 *   #20 — Both webviews ship with a strict CSP and a per-load nonce; only
 *         the extension's own script may execute.
 *   #18 — Dashboard renders the static HTML shell once, then sends data
 *         diffs via postMessage so user state (scroll position, selected
 *         row, expanded items) is preserved across refreshes.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let config: import('@brownstone/contracts').AgentConfig;
  try {
    const { loadConfig } = await import('@brownstone/config');
    config = loadConfig();
  } catch (error) {
    vscode.window.showErrorMessage(`Brownstone: failed to load configuration. ${(error as Error).message}`);
    return;
  }

  const chatHost = new ChatHostView(context, config);
  const dashboard = new DashboardView(context, config);

  context.subscriptions.push(
    vscode.commands.registerCommand('safeAgent.openChat', () => chatHost.show()),
    vscode.commands.registerCommand('safeAgent.openDashboard', () => dashboard.show()),
    vscode.commands.registerCommand('safeAgent.refreshDashboard', () => dashboard.refresh()),
  );
}

export function deactivate(): void { /* nothing to clean up */ }
