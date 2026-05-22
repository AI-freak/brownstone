import { api } from './api.js';

function renderNode(node, container) {
  const wrapper = document.createElement('div');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `${node.type === 'dir' ? '📁' : '📄'} ${node.name}`;
  wrapper.append(button);
  container.append(wrapper);

  if (node.type === 'file') {
    button.addEventListener('click', async () => {
      try {
        const file = await api('GET', `/workspace/file?path=${encodeURIComponent(node.relativePath)}`);
        document.getElementById('workspace-file').textContent = file.content;
      } catch (error) {
        document.getElementById('workspace-file').textContent = `Failed: ${error.message}`;
      }
    });
  } else if (node.children?.length) {
    const list = document.createElement('ul');
    wrapper.append(list);
    for (const child of node.children) renderNode(child, list);
  }
}

export async function refresh() {
  const tree = await api('GET', '/workspace/tree?depth=3');
  const root = document.getElementById('workspace-tree');
  root.replaceChildren();
  for (const node of tree.entries) renderNode(node, root);
}

export function init() {
  // Lazy load on first activation by main shell.
}
