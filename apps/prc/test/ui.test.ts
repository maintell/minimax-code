import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const shellUrl = new URL('../web/index.html', import.meta.url);
const clientUrl = new URL('../web/app.js', import.meta.url);

test('the console shell declares the login form, transcript and composer', async () => {
  const html = await readFile(shellUrl, 'utf8');
  assert.match(html, /id="login"/u);
  assert.match(html, /id="sessions"/u);
  assert.match(html, /id="transcript"/u);
  assert.match(html, /id="composer"/u);
});

test('the console scopes its socket to the binding and matches prefixed events', async () => {
  const script = await readFile(clientUrl, 'utf8');
  assert.match(script, /\/ws\?binding_id=/u);
  assert.match(script, /evt\.session\.message_chunk/u);
  assert.match(script, /evt\.session\.turn_end/u);
  assert.match(script, /evt\.permission\.ask/u);
  assert.match(script, /evt\.permission\.resolved/u);
  assert.match(script, /payload\??\.request_id/u);
});
