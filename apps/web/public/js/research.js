import { api } from './api.js';

function renderAnswer(result) {
  const article = document.getElementById('research-answer');
  article.replaceChildren();

  const heading = document.createElement('h3');
  heading.textContent = result.query;
  article.append(heading);

  const summary = document.createElement('p');
  summary.textContent = result.summary || '(no summary)';
  article.append(summary);

  const body = document.createElement('div');
  body.textContent = result.answer;
  body.style.whiteSpace = 'pre-wrap';
  article.append(body);

  if (result.citations?.length) {
    const wrapper = document.createElement('div');
    wrapper.className = 'citations';
    const title = document.createElement('strong');
    title.textContent = 'Citations';
    wrapper.append(title);
    const list = document.createElement('ol');
    for (const citation of result.citations) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = citation.url;
      link.textContent = citation.title;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      item.append(link);
      if (citation.snippet) {
        const note = document.createElement('div');
        note.style.color = 'var(--text-dim)';
        note.style.fontSize = '12px';
        note.textContent = citation.snippet;
        item.append(note);
      }
      list.append(item);
    }
    wrapper.append(list);
    article.append(wrapper);
  }
}

export function init() {
  document.getElementById('research-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = document.getElementById('research-query').value.trim();
    const mode = document.getElementById('research-mode').value;
    if (!query) return;
    const article = document.getElementById('research-answer');
    article.textContent = 'Researching…';
    try {
      const result = await api('POST', '/research/answer', { body: { query, mode } });
      renderAnswer(result);
    } catch (error) {
      article.textContent = `Failed: ${error.message}`;
    }
  });
}
