import { api } from './api.js';

function renderTasks(tasks) {
  const list = document.getElementById('task-list');
  list.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No tasks yet.';
    list.append(empty);
    return;
  }
  for (const task of tasks) {
    const item = document.createElement('li');

    const status = document.createElement('span');
    status.className = `task-status is-${task.status}`;
    status.textContent = task.status;

    const id = document.createElement('span');
    id.textContent = ` ${task.id.slice(0, 12)} `;

    const kind = document.createElement('strong');
    kind.textContent = task.kind;

    const meta = document.createElement('div');
    meta.style.fontSize = '12px';
    meta.style.color = 'var(--text-dim)';
    meta.style.marginTop = '4px';
    meta.textContent = `created ${new Date(task.createdAt).toLocaleString()}${task.error ? ` — ${task.error}` : ''}`;

    item.append(status, id, kind, meta);
    list.append(item);
  }
}

export async function refresh() {
  const tasks = await api('GET', '/tasks');
  renderTasks(tasks);
}

export function init() {
  document.getElementById('refresh-tasks').addEventListener('click', refresh);
}
