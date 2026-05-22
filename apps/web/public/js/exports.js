import { api } from './api.js';

export async function refresh() {
  const exports = await api('GET', '/exports');
  const list = document.getElementById('export-list');
  list.replaceChildren();
  if (!exports.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No exports yet.';
    list.append(empty);
    return;
  }
  for (const record of exports) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = record.title;
    const meta = document.createElement('div');
    meta.style.fontSize = '12px';
    meta.style.color = 'var(--text-dim)';
    meta.textContent = new Date(record.createdAt).toLocaleString();
    item.append(title, meta);

    for (const [label, key] of [['HTML', 'htmlPath'], ['Markdown', 'markdownPath'], ['JSON', 'jsonPath']]) {
      const pathValue = record[key];
      if (!pathValue) continue;
      const link = document.createElement('a');
      link.href = `/api/artifacts/raw?path=${encodeURIComponent(pathValue)}`;
      link.textContent = label;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.marginRight = '12px';
      item.append(link);
    }
    list.append(item);
  }
}

export function init() { /* nothing on init */ }
