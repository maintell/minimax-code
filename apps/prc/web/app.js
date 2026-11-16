// Wiring for the console: authentication, the socket, and the two views. The
// shapes live in render.js, the message semantics in view.js and events.js.
import { backoffDelay, sameId } from './ids.js';
import { notice, renderRow, streamingBubble } from './render.js';
import { chunkText, chunkThinking } from './text.js';
import { sessionStamp } from './view.js';

const $ = (id) => document.getElementById(id);
const QUICK_CLOSE_MS = 5_000;
const STICK_PX = 80;

let csrf = sessionStorage.getItem('prc.csrf') ?? readCsrfCookie();
let deviceId = sessionStorage.getItem('prc.device') ?? '';
let devices = [];
let bindingId = null;
let currentSession = sessionStorage.getItem('prc.session') ?? '';
let sessionList = [];

let socket;
let socketBindingId = null;
let reconnectTimer;
let reconnectAttempt = 0;
let quickCloses = 0;
let openedAt = 0;
let stableTimer;

let stream = null;
let emptyNotice = null;
let stickToBottom = true;
// The stored session is restored once per page, not on every reconnect.
let restored = false;

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

// Views -----------------------------------------------------------------

function setView(view) {
  document.body.dataset.view = view;
  // The rail is the session list on a phone and a permanent column on a desktop;
  // `data-view` is what tells the browser which of the two to show.
  $('input').toggleAttribute('disabled', bindingId === null);
}

function showLogin(message = '') {
  closeSocket();
  resetReconnect();
  bindingId = null;
  stream = null;
  currentSession = '';
  sessionStorage.removeItem('prc.session');
  for (const card of permissionCards.values()) card.remove();
  permissionCards.clear();
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-error').textContent = message;
  $('password').focus();
}

function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
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
    showApp();
    setView('sessions');
    await refresh();
    if (currentSession !== '') setView('conversation');
  } catch (error) {
    showLogin(error.status === 401
      ? 'Wrong password.'
      : error.status === 429
        ? 'Too many attempts. Wait a moment and try again.'
        : 'Could not sign in. Is the gateway running?');
    $('password').select();
  }
});

$('back').addEventListener('click', () => setView('sessions'));

$('device').addEventListener('click', () => openDeviceSheet());
$('sheet-close').addEventListener('click', () => closeSheet());
$('sheet').addEventListener('click', (event) => {
  if (event.target === $('sheet')) closeSheet();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('sheet').hidden) closeSheet();
});

function openDeviceSheet() {
  renderSheet();
  $('sheet').hidden = false;
  $('sheet-close').focus();
}

function closeSheet() {
  $('sheet').hidden = true;
  $('device').focus();
}

function renderSheet() {
  const list = $('sheet-list');
  list.replaceChildren(...devices.map((device) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-current', device.deviceId === deviceId ? 'true' : 'false');
    const dot = document.createElement('span');
    dot.className = device.online ? 'dot on' : 'dot';
    const label = document.createElement('span');
    label.textContent = `${shortId(device.deviceId)} · gen ${device.generation}`;
    const state = document.createElement('span');
    state.className = 'section';
    state.style.margin = '0 0 0 auto';
    state.textContent = device.online ? 'online' : 'offline';
    button.append(dot, label, state);
    button.onclick = () => { void chooseDevice(device.deviceId); };
    li.append(button);
    return li;
  }));
}

async function chooseDevice(next) {
  closeSheet();
  if (!next || next === deviceId) return;
  deviceId = next;
  sessionStorage.setItem('prc.device', next);
  currentSession = '';
  sessionStorage.removeItem('prc.session');
  stream = null;
  closeSocket();
  resetReconnect();
  $('transcript').replaceChildren();
  await refresh();
  setView('sessions');
}

// Discovery -------------------------------------------------------------

async function refresh() {
  let state;
  try {
    // Devices first: the chip decides which binding every later call uses.
    const deviceList = await api('/api/devices');
    devices = Array.isArray(deviceList?.devices) ? deviceList.devices : [];
    const chosen = devices.find((entry) => entry.deviceId === deviceId) ?? devices[0];
    deviceId = typeof chosen?.deviceId === 'string' ? chosen.deviceId : '';
    if (deviceId) sessionStorage.setItem('prc.device', deviceId);
    renderChip(chosen);
    state = deviceId ? await api('/api/state') : null;
  } catch (error) {
    if (error.status === 401) {
      csrf = '';
      sessionStorage.removeItem('prc.csrf');
      showLogin('Session expired. Sign in again.');
      return;
    }
    setStatus('unavailable');
    scheduleReconnect();
    return;
  }

  bindingId = state?.binding?.id ?? null;
  $('input').disabled = bindingId === null;
  if (bindingId === null) {
    closeSocket();
    resetReconnect();
    setStatus('no producer');
    sessionList = [];
    renderSessions();
    resetTranscript();
    $('transcript').append(notice('No producer is connected. Start the desktop app, then reload.'));
    return;
  }

  connectSocket();

  try {
    const list = await api('/api/sessions');
    sessionList = list.payload?.sessions ?? [];
    renderSessions();
    // Restore the session this browser last showed, once. A session the operator
    // did not open is not opened for them: the app lands on its list.
    if (!restored) {
      restored = true;
      const stored = sessionStorage.getItem('prc.session') ?? '';
      const target = sessionList.find((session) => sameId(session.id, stored));
      if (target) await openSession(target.id, { silent: true });
      else if (currentSession !== '') {
        currentSession = '';
        sessionStorage.removeItem('prc.session');
      }
    }
  } catch (error) {
    sessionList = [];
    renderSessions();
    setStatus(error.status === 409 ? 'no producer' : 'sessions unavailable');
  }
}

function shortId(value) {
  return String(value ?? '').slice(-6) || 'unknown';
}

function renderChip(device) {
  $('device-label').textContent = device
    ? `${shortId(device.deviceId)} · gen ${device.generation}`
    : 'No device';
  $('device-dot').className = device?.online ? 'dot on' : 'dot';
  $('device').title = device?.online ? 'Producer connected' : 'Producer offline';
}

function renderSessions() {
  const list = $('sessions');
  list.replaceChildren(...sessionList.map((session) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'item';
    button.dataset.sessionId = String(session.id);
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = session.title || session.id;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = sessionStamp(session);
    button.append(title, meta);
    button.onclick = () => { void openSession(session.id); };
    li.append(button);
    return li;
  }));
  if (sessionList.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No sessions.';
    list.append(li);
  }
  markActive();
}

function markActive() {
  for (const button of $('sessions').querySelectorAll('button.item')) {
    const active = currentSession !== '' && sameId(button.dataset.sessionId, currentSession);
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
}

// Transcript ------------------------------------------------------------

function resetTranscript() {
  stream = null;
  emptyNotice = null;
  stickToBottom = true;
  $('transcript').replaceChildren();
}

async function openSession(id, { silent = false } = {}) {
  currentSession = String(id);
  sessionStorage.setItem('prc.session', currentSession);
  const title = sessionList.find((session) => sameId(session.id, id))?.title;
  $('room-title').textContent = title || currentSession;
  if (!silent) setView('conversation');
  markActive();
  resetTranscript();
  try {
    const page = await api(`/api/sessions/${encodeURIComponent(id)}/messages?limit=100`);
    // A slow history response must not overwrite the session opened after it.
    if (!sameId(id, currentSession)) return;
    const messages = page.messages ?? [];
    for (const message of messages) append(...renderRow(message));
    if (messages.length === 0) showEmptyNotice();
    scrollToLatest();
  } catch (error) {
    if (!sameId(id, currentSession)) return;
    $('transcript').append(notice(`Could not load messages: ${error.message}`));
  }
  connectSocket();
}

function append(...nodes) {
  if (nodes.length === 0) return;
  dismissEmptyNotice();
  $('transcript').append(...nodes);
  if (stickToBottom) scrollToLatest();
}

function scrollToLatest() {
  const box = $('transcript');
  box.scrollTop = box.scrollHeight;
}

function showEmptyNotice() {
  emptyNotice = notice('No messages yet.');
  $('transcript').append(emptyNotice);
}

// The session stops being empty the moment anything is written into it.
function dismissEmptyNotice() {
  if (emptyNotice === null) return;
  emptyNotice.remove();
  emptyNotice = null;
}

$('transcript').addEventListener('scroll', () => {
  const box = $('transcript');
  stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < STICK_PX;
});

// Composer --------------------------------------------------------------

function autogrow() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

$('input').addEventListener('input', autogrow);

$('input').addEventListener('keydown', (event) => {
  // Confirming an IME candidate must never send the message being composed.
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  $('composer').requestSubmit();
});

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = $('input').value.trim();
  if (!content || currentSession === '') return;
  $('input').value = '';
  autogrow();
  const echo = renderRow({ role: 'user', msg_content: content });
  if (echo.length > 0) append(...echo);
  setStatus('sending');
  try {
    await api(`/api/sessions/${encodeURIComponent(currentSession)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  } catch (error) {
    append(notice(`Message not sent: ${error.message}`));
    setStatus('idle');
  }
});

$('stop').addEventListener('click', () => {
  if (currentSession === '') return;
  // The gateway exposes stop as a socket command; it has no HTTP abort route.
  if (sendCommand('session.stop', { session_id: currentSession })) setStatus('stopping');
  else setStatus('offline');
});

// Socket ----------------------------------------------------------------

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
  setStatus(message.kind === 'err'
    ? `${type} failed: ${message.message ?? message.code ?? 'error'}`
    : 'idle');
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
  setStatus('connecting');

  ws.onopen = () => {
    if (socket !== ws) return;
    openedAt = Date.now();
    reconnectAttempt = 0;
    if (stableTimer !== undefined) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      stableTimer = undefined;
      if (socket === ws) quickCloses = 0;
    }, QUICK_CLOSE_MS);
    setStatus('connected');
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
    setStatus('offline');
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
  setStatus('reconnecting…');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    // Re-read discovery before retrying: the binding may be gone or replaced.
    void refresh().catch((error) => {
      if (error?.status === 401) {
        showLogin('Session expired. Sign in again.');
        return;
      }
      setStatus('offline');
      scheduleReconnect();
    });
  }, delay);
}

function setStatus(text) {
  $('status').textContent = text;
  $('stop').hidden = text !== 'streaming' && text !== 'thinking' && text !== 'stopping';
}

// Events ----------------------------------------------------------------

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
    const chunk = message.payload?.chunk;
    const text = chunkText(chunk);
    if (text) {
      if (stream === null) stream = beginStream();
      if (stream.dataset.state === 'thinking') {
        stream.dataset.state = 'streaming';
        stream.textContent = '';
      }
      stream.textContent += text;
      setStatus('streaming');
      if (stickToBottom) scrollToLatest();
      return;
    }
    // Reasoning-only chunks still mean the turn is alive.
    if (chunkThinking(chunk) && stream === null) {
      stream = beginStream();
      stream.dataset.state = 'thinking';
      stream.textContent = 'Thinking…';
      setStatus('thinking');
    }
    return;
  }

  if (message.type === 'evt.session.message') {
    if (!sameId(message.payload?.session_id, currentSession)) return;
    const msg = message.payload?.msg;
    // The composer already printed the operator's own message.
    if (msg?.role === 'user') return;
    const nodes = renderRow(msg);
    if (stream !== null) {
      const placeholder = stream;
      stream = null;
      // The completed message repeats whatever streamed; it replaces the live
      // row instead of appending a duplicate of the same answer.
      placeholder.replaceWith(...nodes);
      if (stickToBottom) scrollToLatest();
      return;
    }
    append(...nodes);
    return;
  }

  if (message.type === 'evt.session.turn_end') {
    const ended = message.payload?.session_id;
    if (ended !== undefined && ended !== null && !sameId(ended, currentSession)) return;
    stream = null;
    setStatus('idle');
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

function beginStream() {
  const row = streamingBubble();
  if (emptyNotice === null) $('transcript').append(row);
  else {
    emptyNotice.before(row);
    dismissEmptyNotice();
  }
  return row;
}

// Permission sheet ------------------------------------------------------

function renderPermission(card) {
  if (!card || typeof card.requestId !== 'string' || !card.requestId) return;
  for (const requestId of permissionCards.keys()) {
    if (sameId(requestId, card.requestId)) return;
  }

  const box = document.createElement('div');
  box.className = 'permission';
  box.id = `p-${card.requestId}`;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-labelledby', `p-${card.requestId}-title`);

  const title = document.createElement('h3');
  title.id = `p-${card.requestId}-title`;
  title.textContent = card.toolName || 'Tool';
  box.append(title);

  const reason = document.createElement('p');
  reason.textContent = card.reason || 'The agent asks to use this tool.';
  box.append(reason);

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
  showApp();
  setView('sessions');
  await refresh();
  if (!csrf) return;
  // Returning to the tab lands on the session it last showed, as the app does.
  if (currentSession !== '' && sessionList.some((session) => sameId(session.id, currentSession))) {
    setView('conversation');
  }
  autogrow();
}

void start();
