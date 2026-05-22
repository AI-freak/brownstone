/**
 * Approval token state.
 *
 * Memory-only (no localStorage) — the token is sensitive and shouldn't persist
 * between browser sessions. The operator pastes it once into the bar at the
 * bottom of the workspace.
 *
 * app.js owns the DOM wiring and calls setApprovalToken(); this module is the
 * single source of truth that other modules (chat) read from.
 */

let approvalToken = '';

export function getApprovalToken() {
  return approvalToken || null;
}

export function setApprovalToken(value) {
  approvalToken = value ?? '';
}

export function init() {
  // No-op: the original Pass 2 wiring lived here, but the restored design
  // moves the bar to a different location and app.js handles binding.
  // Kept for API stability.
}
