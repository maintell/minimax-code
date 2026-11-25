import { AGENT_CURSOR_HOST_ATTRIBUTE } from "./agent-cursor-bridge";
/**
 * Takeover pill drawn inside the Agent-controlled web page. The page is a
 * native view that covers the host DOM, so the pill lives in the same
 * isolated world as the Agent cursor (closed shadow root, excluded from Agent
 * page queries through the cursor host attribute). Main decides when it shows
 * (user hover) and owns the takeover: the page only reports whether the
 * pointer is over the button, and the trusted mouse press is handled in main.
 */
export let TAKEOVER_PILL_SOURCE = 'mavis-embedded-browser-takeover-pill';
export let TAKEOVER_PILL_CONTROL_NAME = '__mavisEmbeddedBrowserTakeoverPillControl';
export let TAKEOVER_PILL_HOST_ATTRIBUTE = 'data-mavis-agent-takeover-pill';
export let TAKEOVER_PILL_BRIDGE_VERSION = '2026-11-11-v1';
export let TAKEOVER_PILL_TRANSITION_MS = 200;
const MAX_LABEL_LENGTH = 40;
const MAX_ICON_DATA_URL_LENGTH = 200000;
const COLOR_KEYS = [
    'background',
    'border',
    'shadow',
    'text',
    'actionBackground',
    'actionHoverBackground',
    'actionText',
];
// Values land in individual style properties, never in CSS text, so these
// checks only keep the payload to plain CSS values of the expected kind.
const COLOR_PATTERN = /^[#a-z0-9(),.%\s/-]{1,64}$/iu;
const LENGTH_PATTERN = /^\d{1,3}(\.\d{1,3})?px$/u;
const LINE_HEIGHT_PATTERN = /^\d{1,2}(\.\d{1,6})?(px)?$/u;
// Font names may be CJK; only characters that could end a declaration are refused.
const FONT_FAMILY_PATTERN = /^[^;{}<>\\]{1,500}$/u;
const FALLBACK_FONT_FAMILY = 'system-ui, sans-serif';
const ICON_DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u;
function readLabel(value) {
    if (typeof value !== 'string')
        return null;
    const label = value.trim();
    return label.length > 0 && label.length <= MAX_LABEL_LENGTH ? label : null;
}
function readMatch(value, pattern) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return pattern.test(trimmed) ? trimmed : null;
}
export function normalizeTakeoverPillAppearance(value) {
    if (!value || typeof value !== 'object')
        return null;
    const input = value;
    const text = readLabel(input.text);
    const actionLabel = readLabel(input.actionLabel);
    const fontFamily = readMatch(input.fontFamily, FONT_FAMILY_PATTERN) ?? FALLBACK_FONT_FAMILY;
    const textSize = readMatch(input.textSize, LENGTH_PATTERN);
    const actionSize = readMatch(input.actionSize, LENGTH_PATTERN);
    const textLineHeight = readMatch(input.textLineHeight, LINE_HEIGHT_PATTERN);
    const actionLineHeight = readMatch(input.actionLineHeight, LINE_HEIGHT_PATTERN);
    if (!text ||
        !actionLabel ||
        !fontFamily ||
        !textSize ||
        !actionSize ||
        !textLineHeight ||
        !actionLineHeight) {
        return null;
    }
    const rawColors = input.colors;
    if (!rawColors || typeof rawColors !== 'object')
        return null;
    const colors = {};
    for (const key of COLOR_KEYS) {
        const color = readMatch(rawColors[key], COLOR_PATTERN);
        if (!color || /url\s*\(/iu.test(color))
            return null;
        colors[key] = color;
    }
    const icon = input.iconDataUrl;
    const iconDataUrl = typeof icon === 'string' &&
        icon.length <= MAX_ICON_DATA_URL_LENGTH &&
        ICON_DATA_URL_PATTERN.test(icon)
        ? icon
        : null;
    return {
        text,
        actionLabel,
        iconDataUrl,
        fontFamily,
        textSize,
        textLineHeight,
        actionSize,
        actionLineHeight,
        colors,
    };
}
export function normalizeTakeoverPillMessage(value) {
    if (!value || typeof value !== 'object')
        return null;
    const message = value;
    if (message.source !== TAKEOVER_PILL_SOURCE ||
        message.type !== 'action-pointer' ||
        typeof message.sessionId !== 'string' ||
        message.sessionId.length === 0 ||
        !Number.isSafeInteger(message.tabId) ||
        Number(message.tabId) <= 0 ||
        typeof message.inside !== 'boolean') {
        return null;
    }
    return message;
}
export function buildTakeoverPillBridgeScript(options) {
    const shadowMode = options?.openShadowRootForTests === true ? 'open' : 'closed';
    return `(() => {
  const source = '${TAKEOVER_PILL_SOURCE}';
  const controlName = '${TAKEOVER_PILL_CONTROL_NAME}';
  const bridgeVersion = '${TAKEOVER_PILL_BRIDGE_VERSION}';
  const transitionMs = ${TAKEOVER_PILL_TRANSITION_MS};
  if (
    globalThis.__mavisEmbeddedBrowserTakeoverPillVersion === bridgeVersion &&
    globalThis[controlName] &&
    typeof globalThis[controlName].dispatch === 'function'
  ) {
    return true;
  }

  let host = null;
  let pill = null;
  let icon = null;
  let text = null;
  let action = null;
  let identity = null;
  let open = false;
  let closeTimer = null;
  let iconSource = null;
  let pointerInside = false;

  const emitPointer = (inside) => {
    if (!identity || pointerInside === inside) return;
    pointerInside = inside;
    try {
      const bridge = globalThis.mavisEmbeddedBrowserCursorBridge;
      if (bridge && typeof bridge.emitCursorEvent === 'function') {
        const delivery = bridge.emitCursorEvent({
          source,
          type: 'action-pointer',
          sessionId: identity.sessionId,
          tabId: identity.tabId,
          inside,
        });
        if (delivery && typeof delivery.catch === 'function') delivery.catch(() => {});
      }
    } catch (_) {
      // Main also clears the pointer state when the mouse leaves the page.
    }
  };

  const ensureHost = () => {
    if (!host) {
      host = document.createElement('div');
      host.setAttribute('${AGENT_CURSOR_HOST_ATTRIBUTE}', 'true');
      host.setAttribute('${TAKEOVER_PILL_HOST_ATTRIBUTE}', 'true');
      host.setAttribute('aria-hidden', 'true');
      host.style.position = 'fixed';
      host.style.top = '0';
      host.style.left = '0';
      host.style.right = '0';
      host.style.height = '0';
      host.style.zIndex = '2147483647';
      host.style.pointerEvents = 'none';
      host.style.overflow = 'visible';
      const root = host.attachShadow({ mode: '${shadowMode}' });
      const style = document.createElement('style');
      style.textContent =
        ':host{all:initial}' +
        '[part="pill"]{position:absolute;top:12px;left:50%;display:none;align-items:center;' +
        'gap:12px;padding:6px;box-sizing:border-box;border-radius:12px;border-style:solid;' +
        'border-width:0.9px;white-space:nowrap;pointer-events:auto;cursor:default;' +
        'user-select:none;-webkit-user-select:none;-webkit-font-smoothing:antialiased;' +
        'opacity:0;transform:translate(-50%,-8px);' +
        'transition:opacity ' + transitionMs + 'ms ease-out,transform ' + transitionMs +
        'ms cubic-bezier(.2,.8,.2,1);}' +
        '[part="pill"][data-state="open"]{opacity:1;transform:translate(-50%,0);}' +
        '[part="label"]{display:flex;align-items:center;gap:7px;}' +
        '[part="icon"]{display:block;width:24px;height:24px;flex:none;}' +
        '[part="icon"][data-empty="true"]{display:none;}' +
        '[part="text"]{font-weight:430;}' +
        '[part="action"]{display:flex;align-items:center;justify-content:center;' +
        'padding:4px 12px;border-radius:6px;font-weight:430;cursor:pointer;' +
        'transition:background-color 120ms ease-out;}' +
        '@media (prefers-reduced-motion: reduce){[part="pill"]{transform:translate(-50%,0);' +
        'transition:opacity 120ms linear;}}';
      pill = document.createElement('div');
      pill.setAttribute('part', 'pill');
      const label = document.createElement('div');
      label.setAttribute('part', 'label');
      icon = document.createElement('canvas');
      icon.setAttribute('part', 'icon');
      icon.setAttribute('data-empty', 'true');
      text = document.createElement('span');
      text.setAttribute('part', 'text');
      action = document.createElement('span');
      action.setAttribute('part', 'action');
      label.append(icon, text);
      pill.append(label, action);
      root.append(style, pill);
      action.addEventListener('pointerenter', () => {
        action.style.backgroundColor = action.dataset.hoverBackground || '';
        emitPointer(true);
      });
      action.addEventListener('pointerleave', () => {
        action.style.backgroundColor = action.dataset.background || '';
        emitPointer(false);
      });
    }
    if (!host.isConnected) document.documentElement.appendChild(host);
    return pill;
  };

  // Draw the icon from decoded bytes: no image request, so page CSP cannot block it.
  const paintIcon = (dataUrl) => {
    if (iconSource === dataUrl) return;
    iconSource = dataUrl;
    icon.setAttribute('data-empty', 'true');
    if (!dataUrl || typeof createImageBitmap !== 'function') return;
    const ratio = Math.max(1, Math.min(4, Number(globalThis.devicePixelRatio) || 1));
    icon.width = Math.round(24 * ratio);
    icon.height = Math.round(24 * ratio);
    const context = icon.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, icon.width, icon.height);
    try {
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const type = dataUrl.slice(5, dataUrl.indexOf(';'));
      createImageBitmap(new Blob([bytes], { type }))
        .then((bitmap) => {
          if (iconSource !== dataUrl) return;
          context.clearRect(0, 0, icon.width, icon.height);
          context.drawImage(bitmap, 0, 0, icon.width, icon.height);
          icon.setAttribute('data-empty', 'false');
        })
        .catch(() => {});
    } catch (_) {
      // A broken icon leaves the slot empty; the text and button still show.
    }
  };

  const applyAppearance = (appearance, zoom) => {
    const colors = appearance.colors;
    pill.style.backgroundColor = colors.background;
    pill.style.borderColor = colors.border;
    pill.style.filter = 'drop-shadow(0 0 21.6px ' + colors.shadow + ')';
    pill.style.fontFamily = appearance.fontFamily;
    text.style.color = colors.text;
    text.style.fontSize = appearance.textSize;
    text.style.lineHeight = appearance.textLineHeight;
    text.textContent = appearance.text;
    action.dataset.background = colors.actionBackground;
    action.dataset.hoverBackground = colors.actionHoverBackground;
    action.style.backgroundColor = pointerInside
      ? colors.actionHoverBackground
      : colors.actionBackground;
    action.style.color = colors.actionText;
    action.style.fontSize = appearance.actionSize;
    action.style.lineHeight = appearance.actionLineHeight;
    action.textContent = appearance.actionLabel;
    // Keep the pill the same size whatever the page zoom is.
    host.style.zoom = String(zoom);
    paintIcon(appearance.iconDataUrl);
  };

  const show = (command) => {
    const element = ensureHost();
    if (!element) return false;
    identity = { sessionId: command.sessionId, tabId: command.tabId };
    applyAppearance(command.appearance, command.zoom);
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
    if (open) return true;
    open = true;
    element.style.display = 'flex';
    void element.getBoundingClientRect();
    element.setAttribute('data-state', 'open');
    return true;
  };

  const hide = (immediate) => {
    emitPointer(false);
    if (!pill) return true;
    open = false;
    pill.removeAttribute('data-state');
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
    if (immediate) {
      pill.style.display = 'none';
      return true;
    }
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (!open && pill) pill.style.display = 'none';
    }, transitionMs);
    return true;
  };

  const dispatch = (command) => {
    if (!command || typeof command !== 'object') return false;
    if (command.type === 'show') {
      if (
        typeof command.sessionId !== 'string' ||
        !Number.isSafeInteger(command.tabId) ||
        !command.appearance ||
        typeof command.appearance !== 'object' ||
        !Number.isFinite(command.zoom) ||
        command.zoom <= 0
      ) {
        return false;
      }
      return show(command);
    }
    if (command.type === 'hide') return hide(command.immediate === true);
    if (command.type === 'capture-hide' || command.type === 'capture-restore') {
      if (host) host.style.visibility = command.type === 'capture-hide' ? 'hidden' : 'visible';
      return true;
    }
    return false;
  };

  globalThis.__mavisEmbeddedBrowserTakeoverPillVersion = bridgeVersion;
  globalThis[controlName] = Object.freeze({ dispatch });
  return true;
})()`;
}
export let TAKEOVER_PILL_BRIDGE_SCRIPT = buildTakeoverPillBridgeScript();
export let TAKEOVER_PILL_BRIDGE_TEST_SCRIPT = buildTakeoverPillBridgeScript({
    openShadowRootForTests: true,
});
