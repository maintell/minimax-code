const $ = (id) => document.getElementById(id);

let csrf = sessionStorage.getItem('prc.csrf') ?? readCsrfCookie();
let bindingId = null;
let deviceId = '';
let currentSession = null;
let socket;
let socketBindingId = null;
let reconnectTimer;
let streamingBubble = null;
const pendingCommands = new Map();
const permissionCards = new Map();

function readCsrfCookie() {
  for (const part of document.cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === 'prc_csrf') return decodeURIComponent(rest.join('='));
  }
  return '';
}

async function api(path, init = {}) {
  const headers = {
    'content-type': 'application/json',
    ...(csrf ? { 'x-csrf-token': csrf } : {}),
    ...(deviceId ? { 'x-device-id': deviceId } : {}),
    ...(init.headers ?? {}),
  };
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = new Error(body?.error?.code ?? body?.code ?? `HTTP_${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function showConsole() {
  $('login').hidden = true;
  $('console').hidden = false;
}

function showLogin(message = '') {
  closeSocket();
  bindingId = null;
  deviceId = '';
  currentSession = null;
  streamingBubble = null;
  for (const card of permissionCards.values()) card.remove();
  permissionCards.clear();
  $('console').hidden = true;
  $('login').hidden = false;
  $('login-error').textContent = message;
  $('password').focus();
}

$('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-error').textContent = '';
  try {
    const body = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('password').value }),
    });
    csrf = body.csrf;
    sessionStorage.setItem('prc.csrf', csrf);
    $('password').value = '';
    showConsole();
    await refresh();
    $('input').focus();
  } catch (error) {
    // A rejected login leaves the form in place; only a successful one hides it.
    showLogin(error.status === 401
      ? 'Wrong password.'
      : error.status === 429
        ? 'Too many attempts. Wait a moment and try again.'
        : 'Could not sign in. Is the gateway running?');
    $('password').select();
  }
});

async function refresh() {
  let state;
  try {
    state = await api('/api/state');
  } catch (error) {
    if (error.status === 401) {
      csrf = '';
      sessionStorage.removeItem('prc.csrf');
      showLogin('Session expired. Sign in again.');
      return;
    }
    $('status').textContent = 'unavailable';
    return;
  }

  deviceId = typeof state?.binding?.deviceId === 'string' ? state.binding.deviceId : '';
  bindingId = state?.binding?.id ?? null;
  $('input').disabled = bindingId === null;
  $('stop').disabled = bindingId === null;

  if (bindingId === null) {
    closeSocket();
    $('status').textContent = 'no producer';
    renderSessions([]);
    $('transcript').replaceChildren(
      appendNotice('No producer is connected. Start the desktop app, then reload this page.'),
    );
    return;
  }

  connectSocket();

  try {
    const list = await api('/api/sessions');
    const sessions = list.payload?.sessions ?? [];
    renderSessions(sessions);
    if (currentSession === null && sessions[0]) await openSession(sessions[0].id);
  } catch (error) {
    renderSessions([]);
    $('status').textContent = error.status === 409 ? 'no producer' : 'sessions unavailable';
  }
}

function renderSessions(sessions) {
  const list = $('sessions');
  list.replaceChildren(...sessions.map((session) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = session.title || session.id;
    button.dataset.sessionId = String(session.id);
    button.onclick = () => { void openSession(session.id); };
    li.append(button);
    return li;
  }));
  if (!sessions.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No sessions.';
    list.append(li);
  }
  markActiveSession();
}

function markActiveSession() {
  for (const button of $('sessions').querySelectorAll('button[data-session-id]')) {
    const active = button.dataset.sessionId === String(currentSession);
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
}

async function openSession(id) {
  currentSession = id;
  streamingBubble = null;
  markActiveSession();
  const transcript = $('transcript');
  transcript.replaceChildren();
  try {
    const page = await api(`/api/sessions/${encodeURIComponent(id)}/messages?limit=50`);
    const messages = page.messages ?? [];
    for (const message of messages) {
      const text = messageText(message);
      if (text) appendText(text);
    }
    if (!messages.length) transcript.append(appendNotice('No messages yet.'));
  } catch (error) {
    transcript.append(appendNotice(`Could not load messages: ${error.message}`));
  }
  connectSocket();
}

function messageText(message) {
  if (typeof message === 'string') return message;
  if (typeof message?.content === 'string') return message.content;
  const content = message?.content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  if (typeof content?.text === 'string') return content.text;
  if (typeof message?.text === 'string') return message.text;
  return '';
}

function appendText(text, extraClass = '') {
  const div = document.createElement('div');
  div.className = extraClass ? `bubble ${extraClass}` : 'bubble';
  div.textContent = text;
  $('transcript').append(div);
  return div;
}

function appendNotice(text) {
  const div = document.createElement('div');
  div.className = 'notice';
  div.textContent = text;
  return div;
}

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = $('input').value.trim();
  if (!content || currentSession === null) return;
  $('input').value = '';
  appendText(`me: ${content}`, 'me');
  try {
    await api(`/api/sessions/${encodeURIComponent(currentSession)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  } catch (error) {
    $('transcript').append(appendNotice(`Message not sent: ${error.message}`));
  }
});

$('stop').addEventListener('click', () => {
  if (currentSession === null) return;
  // The gateway exposes stop as a socket command; it has no HTTP abort route.
  if (sendCommand('session.stop', { session_id: currentSession })) {
    $('status').textContent = 'stopping…';
  } else {
    $('status').textContent = 'offline';
  }
});

function nextRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `r-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sendCommand(type, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  const requestId = nextRequestId();
  pendingCommands.set(requestId, type);
  socket.send(JSON.stringify({ kind: 'cmd', requestId, type, payload }));
  return true;
}

function settleCommand(message) {
  const requestId = typeof message.requestId === 'string' ? message.requestId : '';
  const type = pendingCommands.get(requestId);
  if (!type) return;
  pendingCommands.delete(requestId);
  $('status').textContent = message.kind === 'err'
    ? `${type} failed: ${message.message ?? message.code ?? 'error'}`
    : 'idle';
}

function connectSocket() {
  if (bindingId === null) return;
  if (socket && socketBindingId === bindingId
      && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  closeSocket();

  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/ws?binding_id=${encodeURIComponent(bindingId)}`);
  socket = ws;
  socketBindingId = bindingId;
  $('status').textContent = 'connecting';

  ws.onopen = () => {
    if (socket !== ws) return;
    $('status').textContent = 'connected';
  };
  ws.onmessage = (event) => handleMessage(event.data);
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    socketBindingId = null;
    pendingCommands.clear();
    $('status').textContent = 'offline';
    scheduleReconnect();
  };
  ws.onerror = () => {
    // A close follows and owns the reconnect.
  };
}

function closeSocket() {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  pendingCommands.clear();
  if (!socket) return;
  const ws = socket;
  socket = null;
  socketBindingId = null;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  try {
    ws.close();
  } catch {
    // Already closing.
  }
}

function scheduleReconnect() {
  if (reconnectTimer !== undefined || !csrf) return;
  $('status').textContent = 'reconnecting…';
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    // Re-read discovery before retrying: the binding may be gone or replaced.
    void refresh().catch((error) => {
      if (error?.status === 401) showLogin('Session expired. Sign in again.');
      else $('status').textContent = 'offline';
    });
  }, 1_500);
}

function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message?.kind !== 'evt') {
    if (message?.kind === 'ack' || message?.kind === 'err') settleCommand(message);
    return;
  }

  if (message.type === 'evt.session.message_chunk') {
    if (message.payload?.session_id !== currentSession) return;
    const text = chunkText(message.payload?.chunk);
    if (!text) return;
    if (streamingBubble === null) streamingBubble = appendText('', 'stream');
    streamingBubble.textContent += text;
    return;
  }

  if (message.type === 'evt.session.turn_end') {
    const endedSession = message.payload?.session_id;
    if (typeof endedSession === 'string' && endedSession !== currentSession) return;
    streamingBubble = null;
    $('status').textContent = 'idle';
    return;
  }

  if (message.type === 'evt.permission.ask') {
    renderPermission(message.payload);
    return;
  }

  if (message.type === 'evt.permission.resolved') {
    removePermission(message.payload);
  }
}

// The chunk field is the producer's raw stream object and its exact text shape
// is not settled yet. Append only text we recognise; never dump JSON.
function chunkText(chunk) {
  if (typeof chunk?.text === 'string') return chunk.text;
  const content = chunk?.message?.content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

function renderPermission(card) {
  if (!card || typeof card.requestId !== 'string' || !card.requestId) return;
  if (permissionCards.has(card.requestId)) return;

  const box = document.createElement('div');
  box.id = `p-${card.requestId}`;
  box.className = 'permission';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', `Permission request for ${card.toolName || 'a tool'}`);

  const title = document.createElement('strong');
  title.textContent = card.toolName || 'Tool';
  box.append(title);

  if (card.reason) {
    const reason = document.createElement('p');
    reason.className = 'permission-reason';
    reason.textContent = card.reason;
    box.append(reason);
  }

  if (card.toolInput) {
    const input = document.createElement('pre');
    input.textContent = card.toolInput;
    box.append(input);
  }

  if (card.ruleContents) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Matching rule';
    const rule = document.createElement('pre');
    rule.textContent = card.ruleContents;
    details.append(summary, rule);
    box.append(details);
  }

  const actions = document.createElement('div');
  actions.className = 'permission-actions';
  for (const [label, decision] of [['Allow once', 'allowOnce'], ['Allow always', 'allowAlways'], ['Deny', 'deny']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.decision = decision;
    button.onclick = () => { void decidePermission(card, decision, box, actions); };
    actions.append(button);
  }
  box.append(actions);

  permissionCards.set(card.requestId, box);
  $('permissions').append(box);
}

async function decidePermission(card, decision, box, actions) {
  const buttons = [...actions.querySelectorAll('button')];
  for (const button of buttons) button.disabled = true;
  try {
    await api(`/api/permissions/${encodeURIComponent(card.requestId)}`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
    permissionCards.delete(card.requestId);
    box.remove();
  } catch (error) {
    for (const button of buttons) button.disabled = false;
    const note = document.createElement('p');
    note.className = 'permission-error';
    note.textContent = `Could not send the decision: ${error.message}`;
    box.append(note);
  }
}

// An ask arrives normalised as a card; its resolution arrives raw from the
// producer, so the two are joined on the producer's request id.
function removePermission(payload) {
  const requestId = typeof payload?.request_id === 'string' ? payload.request_id : '';
  if (!requestId) return;
  const box = permissionCards.get(requestId);
  if (!box) return;
  permissionCards.delete(requestId);
  box.remove();
}

async function start() {
  if (!csrf) return;
  await refresh();
  if (!csrf) return;
  showConsole();
  $('input').focus();
}

void start();
