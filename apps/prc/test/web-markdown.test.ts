import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../web/markdown.js';

test('plain text becomes one paragraph', () => {
  assert.equal(renderMarkdown('a'), '<p>a</p>');
  assert.equal(renderMarkdown('one\ntwo'), '<p>one<br>two</p>');
  assert.equal(renderMarkdown('one\n\ntwo'), '<p>one</p>\n<p>two</p>');
});

test('empty and non-string input render nothing', () => {
  for (const value of ['', '   \n ', undefined, null, 42, {}]) {
    assert.equal(renderMarkdown(value), '');
  }
});

test('a fenced block keeps its body verbatim and names its language', () => {
  const html = renderMarkdown('```js\nconst a = **b**; // <b>\n```');
  assert.equal(html, '<pre><code class="language-js">const a = **b**; // &lt;b&gt;</code></pre>');
  // An unterminated fence still renders as code rather than leaking backticks.
  assert.equal(renderMarkdown('```\nstill code'), '<pre><code>still code</code></pre>');
});

test('headings, rules and quotes map to their elements', () => {
  assert.equal(renderMarkdown('## Title'), '<h2>Title</h2>');
  assert.equal(renderMarkdown('---'), '<hr>');
  assert.equal(renderMarkdown('> quoted'), '<blockquote>quoted</blockquote>');
  assert.equal(renderMarkdown('> one\n> two'), '<blockquote>one two</blockquote>');
});

test('lists keep their order and one level of nesting', () => {
  assert.equal(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(
    renderMarkdown('- a\n  - b\n- c'),
    '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>',
  );
  // A wrapped line belongs to the item above it.
  assert.equal(renderMarkdown('- a\n  continues'), '<ul><li>a continues</li></ul>');
});

test('a table is read from its header and separator', () => {
  const html = renderMarkdown('| a | b | c |\n|:-:|--:|---|\n| 1 | 2 | 3 |');
  assert.equal(
    html,
    '<table><thead><tr><th class="align-center">a</th><th class="align-right">b</th><th>c</th></tr></thead>'
    + '<tbody><tr><td class="align-center">1</td><td class="align-right">2</td><td>3</td></tr></tbody></table>',
  );
  // Pipes without a separator stay text.
  assert.equal(renderMarkdown('a | b'), '<p>a | b</p>');
});

test('emphasis and inline code are distinguished', () => {
  assert.equal(renderMarkdown('**bold** and *italic*'), '<p><strong>bold</strong> and <em>italic</em></p>');
  assert.equal(renderMarkdown('~~gone~~'), '<p><del>gone</del></p>');
  assert.equal(renderMarkdown('use `a**b**` here'), '<p>use <code>a**b**</code> here</p>');
  // Underscores inside an identifier are not emphasis.
  assert.equal(renderMarkdown('call file_name_here'), '<p>call file_name_here</p>');
});

test('links are produced only for web and mail addresses', () => {
  assert.equal(
    renderMarkdown('[docs](https://example.com/a?b=1)'),
    '<p><a href="https://example.com/a?b=1" rel="noreferrer noopener" target="_blank">docs</a></p>',
  );
  assert.equal(
    renderMarkdown('see https://example.com/x.'),
    '<p>see <a href="https://example.com/x" rel="noreferrer noopener" target="_blank">https://example.com/x</a>.</p>',
  );
  for (const unsafe of ['javascript:alert(1)', 'data:text/html,x', '//evil.example', '/local']) {
    const html = renderMarkdown(`[x](${unsafe})`);
    assert.ok(!html.includes('<a '), `${unsafe} must not become a link`);
  }
});

test('input HTML never reaches the output as markup', () => {
  const html = renderMarkdown('<script>alert(1)</script> **ok**');
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<strong>ok</strong>'));
  // An attribute cannot be injected through a link label or address.
  assert.ok(!renderMarkdown('[a" onmouseover="x](https://e.com)').includes('onmouseover="x'));
});

test('product markup and CJK text survive as text', () => {
  assert.ok(renderMarkdown('<deliver-assets><media src="a" /></deliver-assets>').includes('&lt;deliver-assets&gt;'));
  assert.equal(renderMarkdown('中文 **重点** 👍'), '<p>中文 <strong>重点</strong> 👍</p>');
});

test('rendering is stable when applied twice', () => {
  const once = renderMarkdown('## a\n\n- b\n\n`c`');
  assert.equal(renderMarkdown('## a\n\n- b\n\n`c`'), once);
});
