// A small markdown renderer for the transcript. It is deliberately not a
// general-purpose library: it covers what an agent answer actually contains and
// never passes input HTML through, because the answer is untrusted text.
//
// The contract is one string in, sanitized HTML out; every `<` from the input is
// escaped before any tag is emitted, so the only markup in the result is what
// this file wrote.

const SAFE_URL = /^(?:https?:|mailto:)/iu;
const BLANK = /^[ \t]*$/u;
const FENCE = /^(?:```|~~~)(.*)$/u;
const HEADING = /^(#{1,6})[ \t]+(.*)$/u;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})[ \t]*$/u;
const QUOTE = /^>[ \t]?(.*)$/u;
const BULLET = /^([ \t]*)([-*+])[ \t]+(.*)$/u;
const NUMBERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/u;
const TABLE_HEAD = /^[ \t]*\|?(?:[^|\n]*\|)+[^|\n]*$/u;
const TABLE_RULE = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)+\|?[ \t]*$/u;
const TOKEN = '\u0000';

export function renderMarkdown(text) {
  if (typeof text !== 'string' || text.trim() === '') return '';
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (BLANK.test(line)) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const [block, next] = readFence(lines, index, fence[1].trim());
      out.push(block);
      index = next;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      out.push('<hr>');
      index += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const body = [];
      let cursor = index;
      while (cursor < lines.length) {
        const match = QUOTE.exec(lines[cursor]);
        if (!match) break;
        body.push(match[1]);
        cursor += 1;
      }
      out.push(`<blockquote>${inline(body.join(' '))}</blockquote>`);
      index = cursor;
      continue;
    }

    if (isListItem(line)) {
      const [block, next] = readList(lines, index);
      out.push(block);
      index = next;
      continue;
    }

    if (TABLE_HEAD.test(line) && TABLE_RULE.test(lines[index + 1] ?? '')) {
      const [block, next] = readTable(lines, index);
      out.push(block);
      index = next;
      continue;
    }

    const [block, next] = readParagraph(lines, index);
    out.push(block);
    index = next;
  }
  return out.join('\n');
}

function isListItem(line) {
  return BULLET.test(line) || NUMBERED.test(line);
}

// An unterminated fence runs to the end of the message: a truncated answer still
// reads as code instead of leaking its backticks into prose.
function readFence(lines, start, info) {
  const language = /^[\w+#.-]+/u.exec(info)?.[0] ?? '';
  const body = [];
  let cursor = start + 1;
  while (cursor < lines.length) {
    if (FENCE.test(lines[cursor]) && lines[cursor].trim().length <= 4) break;
    body.push(lines[cursor]);
    cursor += 1;
  }
  const className = language ? ` class="language-${escapeAttribute(language)}"` : '';
  const code = `<pre><code${className}>${escapeHtml(body.join('\n'))}</code></pre>`;
  return [code, Math.min(cursor + 1, lines.length)];
}

// One level of nesting, decided by the indent of the marker: an answer rarely
// goes deeper and a wrong guess reads worse than a flat list.
function readList(lines, start) {
  const items = [];
  let cursor = start;
  while (cursor < lines.length) {
    const bullet = BULLET.exec(lines[cursor]);
    const numbered = NUMBERED.exec(lines[cursor]);
    const match = bullet ?? numbered;
    if (!match) {
      // A blank line ends the list; a plain line continues the last item.
      if (BLANK.test(lines[cursor])) break;
      if (items.length === 0) break;
      items[items.length - 1].text += ` ${lines[cursor].trim()}`;
      cursor += 1;
      continue;
    }
    items.push({
      indent: match[1].replace(/\t/gu, '  ').length,
      ordered: numbered !== null,
      text: match[3],
    });
    cursor += 1;
  }

  // A stack rather than a single indent level: `a / a.1 / b` has to close the
  // sublist and keep going with the same parent list.
  const stack = [];
  let html = '';
  for (const item of items) {
    while (stack.length > 0 && item.indent < stack[stack.length - 1].indent) {
      html += `</li></${stack.pop().tag}>`;
    }
    const parent = stack[stack.length - 1];
    if (!parent || item.indent > parent.indent) {
      const tag = item.ordered ? 'ol' : 'ul';
      stack.push({ tag, indent: item.indent });
      html += `<${tag}><li>${inline(item.text)}`;
    } else {
      html += `</li><li>${inline(item.text)}`;
    }
  }
  while (stack.length > 0) html += `</li></${stack.pop().tag}>`;
  return [html, cursor];
}

function readTable(lines, start) {
  const split = (line) => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
  const head = split(lines[start]);
  const aligns = split(lines[start + 1]).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return '';
  });
  const cell = (tag, value, position) => {
    const align = aligns[position];
    return align ? `<${tag} class="align-${align}">${inline(value)}</${tag}>` : `<${tag}>${inline(value)}</${tag}>`;
  };

  let cursor = start + 2;
  const rows = [];
  while (cursor < lines.length && TABLE_HEAD.test(lines[cursor]) && !BLANK.test(lines[cursor])) {
    rows.push(split(lines[cursor]));
    cursor += 1;
  }

  const headHtml = `<thead><tr>${head.map((value, position) => cell('th', value, position)).join('')}</tr></thead>`;
  const bodyHtml = rows.length === 0
    ? ''
    : `<tbody>${rows.map((row) => `<tr>${head.map((_, position) => cell('td', row[position] ?? '', position)).join('')}</tr>`).join('')}</tbody>`;
  return [`<table>${headHtml}${bodyHtml}</table>`, cursor];
}

function readParagraph(lines, start) {
  const body = [];
  let cursor = start;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (BLANK.test(line)) break;
    if (body.length > 0 && startsBlock(lines, cursor)) break;
    body.push(line.trim());
    cursor += 1;
  }
  return [`<p>${inline(body.join('\n'))}</p>`, cursor];
}

function startsBlock(lines, index) {
  const line = lines[index];
  return Boolean(
    FENCE.exec(line)
    || HEADING.exec(line)
    || RULE.test(line)
    || QUOTE.exec(line)
    || isListItem(line)
    || (TABLE_HEAD.test(line) && TABLE_RULE.test(lines[index + 1] ?? '')),
  );
}

// Inline: code spans are cut out first so nothing inside them is transformed,
// then links are parked as tokens so emphasis cannot rewrite a URL, and only
// then does the remaining text get its emphasis and autolinks.
function inline(raw) {
  const parked = [];
  const park = (html) => {
    parked.push(html);
    return `${TOKEN}${parked.length - 1}${TOKEN}`;
  };

  const segments = String(raw).split(/(`+[^`]*`+)/u);
  let html = '';
  for (const segment of segments) {
    const span = /^(`+)([^`]*)\1$/u.exec(segment);
    if (span) {
      html += park(`<code>${escapeHtml(span[2].replace(/^ | $/gu, ''))}</code>`);
      continue;
    }
    html += escapeHtml(segment);
  }

  html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, (match, label, url) => {
    if (!SAFE_URL.test(url)) return match;
    return park(`<a href="${escapeAttribute(url)}" rel="noreferrer noopener" target="_blank">${emphasis(escapeHtml(label))}</a>`);
  });

  html = html.replace(/(https?:\/\/[^\s<>\u0000]+)/gu, (match) => {
    // Trailing punctuation belongs to the sentence, not to the address.
    const trimmed = match.replace(/[.,;:!?)\]}]+$/u, '');
    const tail = match.slice(trimmed.length);
    return `${park(`<a href="${escapeAttribute(trimmed)}" rel="noreferrer noopener" target="_blank">${escapeHtml(trimmed)}</a>`)}${tail}`;
  });

  html = emphasis(html).replace(/\n/gu, '<br>');
  return html.replace(/\u0000(\d+)\u0000/gu, (_, position) => parked[Number(position)] ?? '');
}

function emphasis(html) {
  return html
    .replace(/\*\*(?=\S)([\s\S]*?)\*\*/gu, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?)__/gu, '<strong>$1</strong>')
    .replace(/~~(?=\S)([\s\S]*?)~~/gu, '<del>$1</del>')
    .replace(/(^|[^*])\*(?=\S)([\s\S]*?)\*(?!\*)/gu, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([\s\S]*?)_(?![\w_])/gu, '$1<em>$2</em>');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/gu, '&#96;');
}
