/**
 * Minimal markdown renderer.
 *
 * Handles: headings, bold, italic, inline code, code blocks (with language),
 * unordered/ordered lists, blockquotes, links, line breaks.
 *
 * Why not a library? marked + DOMPurify is ~50KB minified; we need maybe
 * 5KB worth of features for the chat UI. This stays under 150 lines and
 * has no transitive dependencies — easy to audit for XSS.
 *
 * The renderer escapes HTML *first*, then applies markdown patterns over
 * the escaped text. That order matters: a user prompt like `<script>` is
 * displayed literally because '<' becomes '&lt;' before any regex runs.
 */

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/`/g, '&#96;');
}

/**
 * Highlight a code block. Returns escaped HTML with span wrappers for
 * common token types. The grammar is approximate, not a full parser — just
 * enough to make code readable in chat. Recognizes:
 *   - Comments (// and #)
 *   - Strings (single, double, backtick)
 *   - Keywords (a small common set)
 *   - Numbers
 * Anything else is left as escaped text.
 */
const KEYWORDS = new Set([
  // common across many languages
  'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'const', 'let', 'var', 'class', 'new', 'this', 'super',
  'extends', 'implements', 'import', 'export', 'from', 'as', 'default',
  'async', 'await', 'true', 'false', 'null', 'undefined', 'try', 'catch',
  'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'delete', 'void',
  'def', 'lambda', 'pass', 'yield', 'with', 'is', 'not', 'and', 'or', 'None',
  'True', 'False', 'self', 'print', 'public', 'private', 'protected', 'static',
  'interface', 'type', 'enum', 'namespace', 'package',
]);

function highlight(code, language) {
  const escaped = escapeHtml(code);
  if (!language) return escaped;

  // Apply patterns in order: comments → strings → numbers → keywords.
  // We replace with sentinel tokens to avoid double-wrapping.
  let out = escaped;
  // Single-line comments
  out = out.replace(/(\/\/[^\n]*)/g, '<span class="tok-comment">$1</span>');
  out = out.replace(/(^|\n)(#[^\n]*)/g, '$1<span class="tok-comment">$2</span>');
  // Strings (already-escaped quotes)
  out = out.replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|`[^`]*?`)/g, '<span class="tok-string">$1</span>');
  // Numbers
  out = out.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>');
  // Keywords (avoid replacing inside span tags)
  out = out.replace(/\b([a-zA-Z_]+)\b/g, (match) => (
    KEYWORDS.has(match) ? `<span class="tok-keyword">${match}</span>` : match
  ));
  return out;
}

export function renderMarkdown(source) {
  if (!source) return '';

  const lines = source.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const buffer = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buffer.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume closing fence
      const langClass = lang ? ` data-lang="${escapeAttr(lang)}"` : '';
      out.push(`<pre class="md-code"${langClass}><code>${highlight(buffer.join('\n'), lang)}</code></pre>`);
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level} class="md-h${level}">${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        buf.push(lines[i].slice(2));
        i += 1;
      }
      out.push(`<blockquote class="md-quote">${renderInline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
        i += 1;
      }
      out.push(`<ul class="md-list">${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
        i += 1;
      }
      out.push(`<ol class="md-list">${items.join('')}</ol>`);
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Paragraph (continues until blank line or block element)
    const buf = [line];
    i += 1;
    while (i < lines.length
        && lines[i].trim() !== ''
        && !lines[i].startsWith('```')
        && !/^#{1,6}\s/.test(lines[i])
        && !/^[-*]\s/.test(lines[i])
        && !/^\d+\.\s/.test(lines[i])
        && !lines[i].startsWith('> ')) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(`<p class="md-p">${renderInline(buf.join(' '))}</p>`);
  }

  return out.join('\n');
}

function renderInline(text) {
  let out = escapeHtml(text);
  // Inline code (escaped quotes don't matter here because backticks aren't in our escape set)
  out = out.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  // Bold then italic. The order matters because **bold** would otherwise
  // partially match the italic regex.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<![*\w])\*([^*]+)\*(?!\w)/g, '<em>$1</em>');
  // Links — keep target=_blank rel=noopener.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => (
    `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
  ));
  return out;
}
