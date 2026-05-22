import { api } from './api.js';

function renderSchedules(schedules) {
  const list = document.getElementById('schedule-list');
  list.replaceChildren();
  if (!schedules.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No schedules.';
    list.append(empty);
    return;
  }
  for (const schedule of schedules) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = schedule.title;
    const meta = document.createElement('div');
    meta.style.fontSize = '12px';
    meta.style.color = 'var(--text-dim)';
    meta.textContent = `every ${Math.round(schedule.everyMs / 1000)}s — next ${new Date(schedule.nextRunAt).toLocaleString()}`;
    const prompt = document.createElement('div');
    prompt.style.marginTop = '6px';
    prompt.textContent = schedule.prompt;
    item.append(title, meta, prompt);
    list.append(item);
  }
}

export async function refresh() {
  const schedules = await api('GET', '/schedules');
  renderSchedules(schedules);
}

export function init() {
  document.getElementById('schedule-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    try {
      await api('POST', '/schedules', {
        body: {
          title: data.get('title'),
          prompt: data.get('prompt'),
          everyMs: Number(data.get('everyMs')),
        },
      });
      form.reset();
      await refresh();
    } catch (error) {
      alert(`Create failed: ${error.message}`);
    }
  });
}
