import { eventRecord, summarizeTodos } from './events.js';
import { backoffDelay, sameId } from './ids.js';
import { chunkText, chunkThinking, messageText } from './text.js';

const $ = (id) => document.getElementById(id);
const QUICK_CLOSE_MS = 5_000;

let csrf = sessionStorage.getItem('prc.csrf') ?? readCsrfCookie();
let bindingId = null;
let deviceId = '';
let devices = [];
let currentSession = null;
let socket;
let socketBindingId = null;
let reconnectTimer;
let reconnectAttempt = 0;
let quickCloses = 0;
let openedAt = 0;
let stableTimer;
let streamingBubble = null;
// The placeholder that says the session is empty stands only while it is true.
let emptyNotice = null;
// The plan is re-emitted after every step, so the same list can arrive twice for
// one change; the key of the last card rendered keeps the transcript honest.
let lastTodosKey = '';
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
  resetReconnect();
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

$('device').addEventListener('change', async () => {
  const next = $('device').value;
  if (!next || next === deviceId) return;
  deviceId = next;
  sessionStorage.setItem('prc.device', next);
  currentSession = null;
  streamingBubble = null;
  emptyNotice = null;
  closeSocket();
  resetReconnect();
  $('transcript').replaceChildren();
  await refresh();
});

async function refresh() {
  let state;
  let deviceList;
  try {
    // Devices first: the picker decides which binding every later call uses,
    // and a fresh console keeps the device it last selected.
    deviceList = await api('/api/devices');
    devices = Array.isArray(deviceList?.devices) ? deviceList.devices : [];
    const stored = sessionStorage.getItem('prc.device') ?? '';
    const chosen = devices.find((entry) => entry.deviceId === stored) ?? devices[0];
    deviceId = typeof chosen?.deviceId === 'string' ? chosen.deviceId : '';
    renderDevices(chosen?.deviceId ?? '');
    state = deviceId ? await api('/api/state') : null;
  } catch (error) {
    if (error.status === 401) {
      csrf = '';
      sessionStorage.removeItem('prc.csrf');
      showLogin('Session expired. Sign in again.');
      return;
    }
    $('status').textContent = 'unavailable';
    scheduleReconnect();
    return;
  }

  bindingId = state?.binding?.id ?? null;
  $('input').disabled = bindingId === null;
  $('stop').disabled = bindingId === null;

  if (bindingId === null) {
    closeSocket();
    resetReconnect();
    $('status').textContent = 'no producer';
    renderSessions([]);
    emptyNotice = null;
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

function renderDevices(selectedDeviceId) {
  const select = $('device');
  select.replaceChildren(...devices.map((device) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = `${device.deviceId.slice(-6)} · g${device.generation} · ${device.online ? 'online' : 'offline'}`;
    if (device.deviceId === selectedDeviceId) option.selected = true;
    return option;
  }));
  select.hidden = devices.length === 0;
  select.disabled = devices.length < 2;
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
    const active = currentSession !== null && sameId(button.dataset.sessionId, currentSession);
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
}

async function openSession(id) {
  currentSession = id;
  streamingBubble = null;
  emptyNotice = null;
  lastTodosKey = '';
  markActiveSession();
  const transcript = $('transcript');
  transcript.replaceChildren();
  try {
    const page = await api(`/api/sessions/${encodeURIComponent(id)}/messages?limit=50`);
    // A slow history response must not overwrite the session opened after it.
    if (!sameId(id, currentSession)) return;
    const messages = page.messages ?? [];
    for (const message of messages) {
      if (renderEventRecord(message)) continue;
      const text = messageText(message);
      // History rows carry the role, so the operator's own turns align right
      // exactly like the optimistic bubble the composer prints.
      if (text) appendText(text, message?.role === 'user' ? 'me' : '');
    }
    if (!messages.length) {
      emptyNotice = appendNotice('No messages yet.');
      transcript.append(emptyNotice);
    }
  } catch (error) {
    if (!sameId(id, currentSession)) return;
    transcript.append(appendNotice(`Could not load messages: ${error.message}`));
  }
  connectSocket();
}

function appendText(text, extraClass = '') {
  dismissEmptyNotice();
  const div = document.createElement('div');
  div.className = extraClass ? `bubble ${extraClass}` : 'bubble';
  div.textContent = text;
  $('transcript').append(div);
  return div;
}

// The session is no longer empty the moment anything else is written into it.
function dismissEmptyNotice() {
  if (emptyNotice === null) return;
  emptyNotice.remove();
  emptyNotice = null;
}

function appendNotice(text) {
  const div = document.createElement('div');
  div.className = 'notice';
  div.textContent = text;
  return div;
}

// The desktop's own vocabulary, so a plan reads the same in both surfaces.
const TODO_MARKERS = { pending: '○', in_progress: '●', completed: '✓', cancelled: '–' };
const TODO_STATUS_LABELS = {
  pending: 'pending', in_progress: 'in progress', completed: 'completed', cancelled: 'cancelled',
};

// A machine record is rendered as what it describes, never as its own JSON.
// `true` tells the caller the message was consumed, so it is not printed as
// prose as well; a record with no reader is consumed and dropped.
function renderEventRecord(message) {
  const record = eventRecord(message);
  if (record === null) return false;
  if (record.kind === 'todos') appendTodoCard(record.todos);
  else if (record.kind === 'warning') appendWarning(record.text, record.code);
  return true;
}

function appendTodoCard(todos) {
  const key = JSON.stringify(todos);
  if (key === lastTodosKey) return;
  lastTodosKey = key;
  dismissEmptyNotice();

  const counts = summarizeTodos(todos);
  const card = document.createElement('details');
  card.className = counts.remaining > 0 ? 'todos' : 'todos done';
  // What the agent is working on is the point of the card, so an unfinished plan
  // stands open; a finished one collapses to its summary line.
  card.open = counts.remaining > 0;
  const summary = document.createElement('summary');
  summary.textContent = counts.remaining > 0
    ? `Todo list ${counts.completed}/${counts.total} · ${counts.remaining} remaining`
    : `Todo list ${counts.completed}/${counts.total} completed`;
  card.append(summary);

  const list = document.createElement('ol');
  for (const todo of todos) {
    const item = document.createElement('li');
    item.className = `todo ${todo.status}`;
    const marker = document.createElement('span');
    marker.className = 'todo-marker';
    marker.textContent = TODO_MARKERS[todo.status] ?? TODO_MARKERS.pending;
    // The glyph is decoration; the status word is what a screen reader reads.
    marker.setAttribute('aria-hidden', 'true');
    const status = document.createElement('span');
    status.className = 'sr-only';
    status.textContent = `${TODO_STATUS_LABELS[todo.status] ?? 'pending'}: `;
    const content = document.createElement('span');
    content.className = 'todo-text';
    content.textContent = todo.content;
    item.append(marker, status, content);
    list.append(item);
  }
  card.append(list);
  $('transcript').append(card);
}

function appendWarning(text, code) {
  dismissEmptyNotice();
  const div = document.createElement('div');
  div.className = 'warning';
  div.setAttribute('role', 'status');
  div.textContent = text;
  // The code is what support would ask for; it stays out of the sentence.
  if (code) div.title = code;
  $('transcript').append(div);
}

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = $('input').value.trim();
  if (!content || currentSession === null) return;
  $('input').value = '';
  appendText(content, 'me');
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
    openedAt = Date.now();
    // A successful open clears the state-failure count. A connection that
    // closes immediately is tracked separately so flapping still backs off.
    reconnectAttempt = 0;
    if (stableTimer !== undefined) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      stableTimer = undefined;
      if (socket === ws) quickCloses = 0;
    }, QUICK_CLOSE_MS);
    $('status').textContent = 'connected';
  };
  ws.onmessage = (event) => handleMessage(event.data);
  ws.onclose = () => {
    if (socket !== ws) return;
    const quick = openedAt !== 0 && Date.now() - openedAt < QUICK_CLOSE_MS;
    if (stableTimer !== undefined) {
      clearTimeout(stableTimer);
      stableTimer = undefined;
    }
    openedAt = 0;
    socket = null;
    socketBindingId = null;
    pendingCommands.clear();
    quickCloses = quick ? quickCloses + 1 : 0;
    $('status').textContent = 'offline';
    scheduleReconnect(quickCloses);
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
  if (stableTimer !== undefined) {
    clearTimeout(stableTimer);
    stableTimer = undefined;
  }
  openedAt = 0;
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

function resetReconnect() {
  reconnectAttempt = 0;
  quickCloses = 0;
}

function scheduleReconnect(extraAttempts = 0) {
  if (reconnectTimer !== undefined || !csrf) return;
  const delay = backoffDelay(reconnectAttempt + extraAttempts);
  reconnectAttempt += 1;
  $('status').textContent = 'reconnecting…';
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    // Re-read discovery before retrying: the binding may be gone or replaced.
    void refresh().catch((error) => {
      if (error?.status === 401) {
        showLogin('Session expired. Sign in again.');
        return;
      }
      $('status').textContent = 'offline';
      scheduleReconnect();
    });
  }, delay);
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
    if (!sameId(message.payload?.session_id, currentSession)) return;
    const text = chunkText(message.payload?.chunk);
    if (text) {
      if (streamingBubble === null) streamingBubble = appendText('', 'stream');
      // The placeholder must not survive into the answer.
      if (streamingBubble.classList.contains('thinking')) {
        streamingBubble.classList.remove('thinking');
        streamingBubble.textContent = '';
      }
      streamingBubble.textContent += text;
      $('status').textContent = 'streaming';
      return;
    }
    // Reasoning-only chunks still mean the turn is alive; show that instead of
    // leaving the transcript frozen until the answer lands.
    if (chunkThinking(message.payload?.chunk) && streamingBubble === null) {
      streamingBubble = appendText('thinking…', 'stream thinking');
      $('status').textContent = 'thinking';
    }
    return;
  }

  if (message.type === 'evt.session.message') {
    if (!sameId(message.payload?.session_id, currentSession)) return;
    const msg = message.payload?.msg;
    // The composer already printed the operator's own message, so the user
    // echo of the same turn must not produce a second bubble.
    if (msg?.role === 'user') return;
    if (renderEventRecord(msg)) return;
    const text = messageText(msg);
    if (!text) return;
    // The completed message repeats whatever the chunks streamed; replace the
    // streaming bubble instead of appending a duplicate of the same answer.
    if (streamingBubble !== null) {
      streamingBubble.classList.remove('thinking');
      streamingBubble.textContent = text;
      streamingBubble = null;
      return;
    }
    appendText(text);
    return;
  }

  if (message.type === 'evt.session.turn_end') {
    const endedSession = message.payload?.session_id;
    if (endedSession !== undefined && endedSession !== null && !sameId(endedSession, currentSession)) return;
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

function renderPermission(card) {
  if (!card || typeof card.requestId !== 'string' || !card.requestId) return;
  for (const requestId of permissionCards.keys()) {
    if (sameId(requestId, card.requestId)) return;
  }

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
  const requestId = payload?.request_id;
  if (requestId === undefined || requestId === null) return;
  for (const [cardRequestId, box] of permissionCards) {
    if (!sameId(cardRequestId, requestId)) continue;
    permissionCards.delete(cardRequestId);
    box.remove();
    return;
  }
}

async function start() {
  if (!csrf) return;
  await refresh();
  if (!csrf) return;
  showConsole();
  $('input').focus();
}

void start();
