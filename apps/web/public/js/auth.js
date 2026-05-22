import { api, refreshCsrf, clearCsrfToken } from './api.js';

/**
 * Login/register overlay.
 *
 * The overlay sits over the workspace (z-index 200) and toggles with the
 * HTML `hidden` attribute. We do NOT hide the underlying app-shell — the
 * overlay's backdrop blur takes care of that visually, and keeping the
 * shell rendered avoids a flash on each auth state change.
 *
 * Public API:
 *   - init()              wire form submits + logout button (called once at boot)
 *   - bootstrap()         try /auth/me; show overlay on 401, emit on success
 *   - onAuthChange(fn)    subscribe; receives the current user or null
 *   - getCurrentUser()    last-known user
 *   - logout()            POST /auth/logout, clear state, re-show overlay
 */

let currentUser = null;
const authListeners = new Set();

export function onAuthChange(listener) {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function emit() {
  for (const listener of authListeners) listener(currentUser);
}

export function getCurrentUser() {
  return currentUser;
}

export async function bootstrap() {
  try {
    // skipUnauthHandler: bootstrap *is* the unauth handler, so it must
    // not re-trigger itself via the api client on 401.
    const me = await api('GET', '/auth/me', { skipUnauthHandler: true });
    currentUser = me;
    await refreshCsrf();
    hideOverlay();
    emit();
    return me;
  } catch (error) {
    if (error.statusCode === 401) {
      showOverlay();
      emit();
      return null;
    }
    throw error;
  }
}

export async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch { /* fall through */ }
  currentUser = null;
  clearCsrfToken();
  showOverlay();
  emit();
}

function setError(form, message) {
  const slot = form.querySelector('[data-role="error"]');
  if (slot) slot.textContent = message ?? '';
}

function bindLoginForm(overlay) {
  const form = overlay.querySelector('#login-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError(form, null);
    const data = new FormData(form);
    try {
      const result = await api('POST', '/auth/login', {
        body: { email: data.get('email'), password: data.get('password') },
      });
      currentUser = result.user;
      await refreshCsrf();
      hideOverlay();
      emit();
    } catch (error) {
      setError(form, error.message);
    }
  });
}

function bindRegisterForm(overlay) {
  const form = overlay.querySelector('#register-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError(form, null);
    const data = new FormData(form);
    try {
      const result = await api('POST', '/auth/register', {
        body: {
          email: data.get('email'),
          password: data.get('password'),
          displayName: data.get('displayName') ?? '',
        },
      });
      currentUser = result.user;
      await refreshCsrf();
      hideOverlay();
      emit();
    } catch (error) {
      setError(form, error.message);
    }
  });
}

function bindTabs(overlay) {
  const tabs = overlay.querySelectorAll('.auth-tabs .tab-button');
  const forms = {
    login: overlay.querySelector('#login-form'),
    register: overlay.querySelector('#register-form'),
  };
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      tabs.forEach((other) => other.classList.toggle('active', other === tab));
      const target = tab.dataset.tab;
      for (const [name, form] of Object.entries(forms)) {
        form.hidden = name !== target;
      }
    });
  }
}

function showOverlay() {
  const overlay = document.getElementById('auth-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  // Reset the tab to "Log in" — if the user previously created an account
  // they're likely coming back to log in, not register a second time.
  const tabs = overlay.querySelectorAll('.auth-tabs .tab-button');
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === 'login'));
  overlay.querySelector('#login-form').hidden = false;
  overlay.querySelector('#register-form').hidden = true;
  // Clear any stale errors and password fields.
  overlay.querySelectorAll('[data-role="error"]').forEach((el) => { el.textContent = ''; });
  overlay.querySelectorAll('input[type="password"]').forEach((el) => { el.value = ''; });
}

function hideOverlay() {
  const overlay = document.getElementById('auth-overlay');
  if (overlay) overlay.hidden = true;
}

export function init() {
  const overlay = document.getElementById('auth-overlay');
  bindTabs(overlay);
  bindLoginForm(overlay);
  bindRegisterForm(overlay);

  const logoutButton = document.getElementById('logout-button');
  if (logoutButton) {
    logoutButton.addEventListener('click', () => {
      logout();
    });
  }
}
