import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const shellUrl = new URL('../web/index.html', import.meta.url);
const clientUrl = new URL('../web/app.js', import.meta.url);

test('the shell declares the login form, the session rail, the transcript and the composer', async () => {
  const html = await readFile(shellUrl, 'utf8');
  assert.match(html, /id="login"/u);
  assert.match(html, /id="sessions"/u);
  assert.match(html, /id="transcript"/u);
  assert.match(html, /id="composer"/u);
  assert.match(html, /id="device"/u);
  // One DOM, two layouts: the view is a data attribute, not a second page.
  assert.match(html, /<body data-view="sessions">/u);
  assert.match(html, /id="rail"/u);
  assert.match(html, /id="room"/u);
  // The device picker and the permission stack are overlays over that shell.
  assert.match(html, /id="sheet" class="sheet"/u);
  assert.match(html, /id="permissions"/u);
});

test('the console resolves devices and switches the binding with them', async () => {
  const script = await readFile(clientUrl, 'utf8');
  assert.match(script, /\/api\/devices/u);
  assert.match(script, /\$\('device'\)\.addEventListener\('click'/u);
  assert.match(script, /prc\.device/u);
  // Every request carries the chosen device, and the socket follows the binding.
  assert.match(script, /'x-device-id': deviceId/u);
  assert.match(script, /\/ws\?binding_id=/u);
});

test('the console scopes its socket to the binding and matches prefixed events', async () => {
  const script = await readFile(clientUrl, 'utf8');
  assert.match(script, /evt\.session\.message_chunk/u);
  assert.match(script, /evt\.session\.message'/u);
  assert.match(script, /evt\.session\.turn_end/u);
  assert.match(script, /evt\.permission\.ask/u);
  assert.match(script, /evt\.permission\.resolved/u);
  assert.match(script, /payload\??\.request_id/u);
});

test('the console renders a row on both the history and live paths', async () => {
  const script = await readFile(clientUrl, 'utf8');
  assert.match(script, /from '\.\/render\.js'/u);
  // History replay and the live socket both go through the one renderer; a fix
  // applied to only one of them leaves the other printing raw content.
  assert.match(script, /for \(const message of messages\) append\(\.\.\.renderRow\(message\)\)/u);
  assert.match(script, /const nodes = renderRow\(msg\)/u);
});

test('the renderer reaches markdown, the view model and the record parser', async () => {
  const render = await readFile(new URL('../web/render.js', import.meta.url), 'utf8');
  assert.match(render, /from '\.\/markdown\.js'/u);
  assert.match(render, /from '\.\/view\.js'/u);
  assert.match(render, /from '\.\/events\.js'/u);
  // Answers are rendered through the sanitizing renderer, not pasted as text.
  assert.match(render, /innerHTML = renderMarkdown\(text\)/u);
});
