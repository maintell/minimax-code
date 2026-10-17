export let AGENT_CURSOR_SOURCE = 'mavis-embedded-browser-agent-cursor';
export let AGENT_CURSOR_WORLD_ID = 1005;
export let AGENT_CURSOR_CONTROL_NAME = '__mavisEmbeddedBrowserAgentCursorControl';
export let AGENT_CURSOR_TEST_QUEUE_NAME = '__mavisEmbeddedBrowserAgentCursorTestQueue';
export let AGENT_CURSOR_HOST_ATTRIBUTE = 'data-mavis-agent-cursor-host';
export let AGENT_CURSOR_BRIDGE_VERSION = '2026-08-06-v7';
export let AGENT_CURSOR_ANIMATION_MS = 300;
export let AGENT_EXECUTION_GLOW_TRANSITION_MS = 1200;
export let AGENT_EXECUTION_GLOW_PULSE_MS = 2400;
export let AGENT_EXECUTION_GLOW_MIN_VISIBLE_MS = 600;
export let AGENT_EXECUTION_GLOW_IDLE_HOLD_MS = 800;
export function normalizeAgentCursorBridgeMessage(value) {
    if (!value || typeof value !== 'object')
        return null;
    const message = value;
    if (message.source !== AGENT_CURSOR_SOURCE ||
        message.type !== 'cursor-arrived' ||
        typeof message.sessionId !== 'string' ||
        message.sessionId.length === 0 ||
        !Number.isSafeInteger(message.tabId) ||
        Number(message.tabId) <= 0 ||
        !Number.isSafeInteger(message.moveSequence) ||
        Number(message.moveSequence) <= 0 ||
        !Number.isFinite(message.x) ||
        !Number.isFinite(message.y)) {
        return null;
    }
    return message;
}
export function buildAgentCursorBridgeScript(options) {
    const allowTestQueue = options?.allowTestQueue === true;
    const shadowMode = options?.openShadowRootForTests === true ? 'open' : 'closed';
    return `(() => {
  const source = '${AGENT_CURSOR_SOURCE}';
  const controlName = '${AGENT_CURSOR_CONTROL_NAME}';
  const hostAttribute = '${AGENT_CURSOR_HOST_ATTRIBUTE}';
  const bridgeVersion = '${AGENT_CURSOR_BRIDGE_VERSION}';
  const animationMs = ${AGENT_CURSOR_ANIMATION_MS};
  const glowTransitionMs = ${AGENT_EXECUTION_GLOW_TRANSITION_MS};
  const glowPulseMs = ${AGENT_EXECUTION_GLOW_PULSE_MS};
  const glowMinVisibleMs = ${AGENT_EXECUTION_GLOW_MIN_VISIBLE_MS};
  const glowIdleHoldMs = ${AGENT_EXECUTION_GLOW_IDLE_HOLD_MS};
  const cursorHotspotX = 24;
  const cursorHotspotY = 22;
  const allowTestQueue = ${allowTestQueue};
  if (
    globalThis.__mavisEmbeddedBrowserAgentCursorVersion === bridgeVersion &&
    globalThis[controlName] &&
    typeof globalThis[controlName].dispatch === 'function'
  ) {
    return true;
  }

  let host = null;
  let root = null;
  let cursor = null;
  let glowBase = null;
  let glowPulse = null;
  let glowRunning = false;
  let glowReducedMotion = false;
  let glowStartedAt = 0;
  let glowStopTimer = null;
  let glowExitTimer = null;
  let lastSequence = 0;
  let arrivalTimer = null;
  let transitionListener = null;
  let lastX = null;
  let lastY = null;

  const ensureHost = () => {
    if (!host) {
      host = document.createElement('div');
      host.setAttribute(hostAttribute, 'true');
      host.setAttribute('aria-hidden', 'true');
      host.style.position = 'fixed';
      host.style.inset = '0';
      host.style.zIndex = '2147483647';
      host.style.pointerEvents = 'none';
      host.style.overflow = 'hidden';
      root = host.attachShadow({ mode: '${shadowMode}' });
      const style = document.createElement('style');
      style.textContent =
        ':host{all:initial}' +
        '@keyframes mavisGlowEnterBase{from{opacity:0}to{opacity:1}}' +
        '@keyframes mavisGlowEnterPulse{from{opacity:0}to{opacity:1}}' +
        '@keyframes mavisGlowPulse{0%,100%{opacity:1}50%{opacity:0}}' +
        '[part^="execution-glow-"]{position:fixed;inset:0;display:none;opacity:0;' +
        'pointer-events:none;will-change:opacity;}' +
        '[part="execution-glow-base"]{box-shadow:inset 0 0 80px rgba(0,148,252,.10);}' +
        '[part="execution-glow-pulse"]{box-shadow:inset 0 0 48px rgba(0,148,252,.16);}' +
        '[part="cursor"]{position:absolute;left:0;top:0;width:60px;height:68px;' +
        'display:none;pointer-events:none;will-change:transform;}' +
        '[part="cursor"] svg{display:block;width:60px;height:68px;}';
      glowBase = document.createElement('div');
      glowBase.setAttribute('part', 'execution-glow-base');
      glowPulse = document.createElement('div');
      glowPulse.setAttribute('part', 'execution-glow-pulse');
      cursor = document.createElement('div');
      cursor.setAttribute('part', 'cursor');
      cursor.style.transform = 'translate3d(0px,0px,0)';
      const svgNamespace = 'http://www.w3.org/2000/svg';
      const createSvgElement = (name, attributes = {}) => {
        const element = document.createElementNS(svgNamespace, name);
        for (const [key, value] of Object.entries(attributes)) {
          element.setAttribute(key, String(value));
        }
        return element;
      };
      const svg = createSvgElement('svg', {
        width: 60,
        height: 68,
        viewBox: '0 0 60 68',
        fill: 'none',
        'aria-hidden': 'true',
      });
      const cursorShape = createSvgElement('g', { filter: 'url(#filter0_dd_703_57199)' });
      cursorShape.append(
        createSvgElement('path', {
          'fill-rule': 'evenodd',
          'clip-rule': 'evenodd',
          d: 'M25.7312 22.3L35.3998 31.9894C36.6143 33.2073 35.7527 35.2856 34.0331 35.2856L32.6214 35.2855L34.0236 38.6161C34.2693 39.1997 34.2727 39.8456 34.034 40.4326C33.7941 41.0208 33.3397 41.4799 32.7538 41.7255C32.4585 41.8489 32.1494 41.9112 31.8334 41.9112C30.8749 41.9112 30.0157 41.3403 29.6443 40.4568L28.1705 36.9533L27.2109 37.8046C25.9642 38.9072 24 38.0226 24 36.3571V23.0162C24 22.112 25.0922 21.6599 25.7312 22.3Z',
          fill: 'white',
          'fill-opacity': '0.95',
        }),
        createSvgElement('path', {
          'fill-rule': 'evenodd',
          'clip-rule': 'evenodd',
          d: 'M25.1528 23.7636C25.1528 23.6126 25.3362 23.5364 25.4423 23.6437L34.5631 32.7841C35.0602 33.2823 34.7072 34.1323 34.0037 34.1323L30.885 34.1306L32.9606 39.0623C33.2224 39.6851 32.9295 40.4013 32.3078 40.662C31.6838 40.9238 30.9688 40.632 30.7081 40.0103L28.6118 35.0233L26.4665 36.9235C25.9867 37.3479 25.2464 37.0521 25.161 36.4485L25.1528 36.3318V23.7636Z',
          fill: '#0094FC',
        }),
      );
      const definitions = createSvgElement('defs');
      const shadowFilter = createSvgElement('filter', {
        id: 'filter0_dd_703_57199',
        x: 0,
        y: 0,
        width: 60,
        height: 70,
        filterUnits: 'userSpaceOnUse',
        'color-interpolation-filters': 'sRGB',
      });
      shadowFilter.append(
        createSvgElement('feFlood', {
          'flood-opacity': 0,
          result: 'BackgroundImageFix',
        }),
        createSvgElement('feColorMatrix', {
          in: 'SourceAlpha',
          type: 'matrix',
          values: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0',
          result: 'hardAlpha',
        }),
        createSvgElement('feOffset', { dy: 2 }),
        createSvgElement('feGaussianBlur', { stdDeviation: 12 }),
        createSvgElement('feComposite', { in2: 'hardAlpha', operator: 'out' }),
        createSvgElement('feColorMatrix', {
          type: 'matrix',
          values: '0 0 0 0 0 0 0 0 0 0.478431 0 0 0 0 1 0 0 0 0.8 0',
        }),
        createSvgElement('feBlend', {
          mode: 'normal',
          in2: 'BackgroundImageFix',
          result: 'effect1_dropShadow_703_57199',
        }),
        createSvgElement('feColorMatrix', {
          in: 'SourceAlpha',
          type: 'matrix',
          values: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0',
          result: 'hardAlpha',
        }),
        createSvgElement('feOffset', { dy: 2 }),
        createSvgElement('feGaussianBlur', { stdDeviation: 1 }),
        createSvgElement('feComposite', { in2: 'hardAlpha', operator: 'out' }),
        createSvgElement('feColorMatrix', {
          type: 'matrix',
          values: '0 0 0 0 0 0 0 0 0 0.0967733 0 0 0 0 0.164776 0 0 0 0.24 0',
        }),
        createSvgElement('feBlend', {
          mode: 'normal',
          in2: 'effect1_dropShadow_703_57199',
          result: 'effect2_dropShadow_703_57199',
        }),
        createSvgElement('feBlend', {
          mode: 'normal',
          in: 'SourceGraphic',
          in2: 'effect2_dropShadow_703_57199',
          result: 'shape',
        }),
      );
      definitions.append(shadowFilter);
      svg.append(cursorShape, definitions);
      cursor.append(svg);
      root.append(style, glowBase, glowPulse, cursor);
    }
    if (!host.isConnected) document.documentElement.appendChild(host);
    return cursor;
  };

  const emitArrival = (command) => {
    const message = {
      source,
      type: 'cursor-arrived',
      sessionId: command.sessionId,
      tabId: command.tabId,
      moveSequence: command.moveSequence,
      x: command.x,
      y: command.y,
    };
    if (allowTestQueue) {
      const queue = globalThis['${AGENT_CURSOR_TEST_QUEUE_NAME}'];
      if (Array.isArray(queue)) queue.push(message);
    }
    try {
      const bridge = globalThis.mavisEmbeddedBrowserCursorBridge;
      if (bridge && typeof bridge.emitCursorEvent === 'function') {
        const delivery = bridge.emitCursorEvent(message);
        if (delivery && typeof delivery.catch === 'function') delivery.catch(() => {});
      }
    } catch (_) {
      // Arrival is advisory. The main process owns the bounded fallback.
    }
  };

  const cursorTransform = (x, y) =>
    'translate3d(' + (x - cursorHotspotX) + 'px,' + (y - cursorHotspotY) + 'px,0)';

  const glowElements = () => [glowBase, glowPulse].filter(Boolean);

  const clearGlowTimers = () => {
    if (glowStopTimer) clearTimeout(glowStopTimer);
    if (glowExitTimer) clearTimeout(glowExitTimer);
    glowStopTimer = null;
    glowExitTimer = null;
  };

  const startExecutionGlow = () => {
    ensureHost();
    const continuing = glowElements().some((element) => element.style.display === 'block');
    clearGlowTimers();
    glowRunning = true;
    glowStartedAt = Date.now();
    glowReducedMotion =
      typeof globalThis.matchMedia === 'function' &&
      globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const element of glowElements()) {
      element.style.display = 'block';
      element.style.visibility = 'visible';
      element.style.transition = 'none';
    }
    if (continuing && !glowReducedMotion) {
      glowBase.style.animation = 'none';
      glowBase.style.opacity = '1';
      glowPulse.style.opacity = '1';
      glowPulse.style.animation = 'mavisGlowPulse ' + glowPulseMs + 'ms linear infinite';
      return true;
    }
    if (glowReducedMotion) {
      glowBase.style.animation = 'none';
      glowPulse.style.animation = 'none';
      glowBase.style.opacity = '.5';
      glowPulse.style.opacity = '.5';
      return true;
    }
    glowBase.style.opacity = '';
    glowPulse.style.opacity = '';
    glowBase.style.animation =
      'mavisGlowEnterBase ' + glowTransitionMs + 'ms linear forwards';
    glowPulse.style.animation =
      'mavisGlowEnterPulse ' + glowTransitionMs + 'ms linear forwards,' +
      'mavisGlowPulse ' + glowPulseMs + 'ms linear ' + glowTransitionMs + 'ms infinite';
    return true;
  };

  const stopExecutionGlow = () => {
    ensureHost();
    glowRunning = false;
    clearGlowTimers();
    const beginExit = () => {
      glowStopTimer = null;
      if (glowRunning) return;
      if (glowReducedMotion) {
        for (const element of glowElements()) {
          element.style.display = 'none';
          element.style.opacity = '0';
        }
        return;
      }
      for (const element of glowElements()) {
        const currentOpacity = globalThis.getComputedStyle
          ? globalThis.getComputedStyle(element).opacity
          : '1';
        element.style.animation = 'none';
        element.style.opacity = currentOpacity;
        void element.getBoundingClientRect();
        element.style.transition =
          'opacity ' + glowTransitionMs + 'ms cubic-bezier(.5,0,.5,1)';
        element.style.opacity = '0';
      }
      glowExitTimer = setTimeout(() => {
        glowExitTimer = null;
        if (glowRunning) return;
        for (const element of glowElements()) {
          element.style.display = 'none';
          element.style.transition = 'none';
        }
      }, glowTransitionMs);
    };
    // Browser Use emits a sequence of short tools. Hold the active state for
    // one idle window so inspect -> click -> type -> screenshot reads as one
    // continuous execution instead of restarting the glow for every promise.
    const remainingMs = Math.max(
      glowIdleHoldMs,
      glowMinVisibleMs - (Date.now() - glowStartedAt),
    );
    if (remainingMs > 0) glowStopTimer = setTimeout(beginExit, remainingMs);
    else beginExit();
    return true;
  };

  const setCaptureHidden = (hidden) => {
    ensureHost();
    for (const element of glowElements()) {
      element.style.visibility = hidden ? 'hidden' : 'visible';
    }
    return true;
  };

  const dispatch = (command) => {
    if (!command || typeof command !== 'object') return false;
    const element = ensureHost();
    if (!element) return false;
    if (command.type === 'execution-start') return startExecutionGlow();
    if (command.type === 'execution-stop') return stopExecutionGlow();
    if (command.type === 'capture-hide') return setCaptureHidden(true);
    if (command.type === 'capture-restore') return setCaptureHidden(false);
    if (command.type === 'hide' || command.type === 'reset') {
      if (arrivalTimer) clearTimeout(arrivalTimer);
      arrivalTimer = null;
      if (transitionListener) element.removeEventListener('transitionend', transitionListener);
      transitionListener = null;
      element.style.display = 'none';
      element.style.transition = 'none';
      if (command.type === 'reset') {
        lastSequence = 0;
        lastX = null;
        lastY = null;
      }
      return true;
    }
    if (
      command.type !== 'move' ||
      typeof command.sessionId !== 'string' ||
      !Number.isSafeInteger(command.tabId) ||
      command.tabId <= 0 ||
      !Number.isSafeInteger(command.moveSequence) ||
      (command.restore === true
        ? command.moveSequence !== lastSequence
        : command.moveSequence <= lastSequence) ||
      !Number.isFinite(command.x) ||
      !Number.isFinite(command.y)
    ) {
      return false;
    }
    if (command.restore !== true) lastSequence = command.moveSequence;
    if (arrivalTimer) clearTimeout(arrivalTimer);
    if (transitionListener) element.removeEventListener('transitionend', transitionListener);
    transitionListener = null;
    const wasHidden = element.style.display !== 'block';
    element.style.display = command.visible === false ? 'none' : 'block';
    if (command.animateMovement && wasHidden) {
      const startX = lastX === null ? Math.max(0, window.innerWidth / 2) : lastX;
      const startY = lastY === null ? Math.max(0, window.innerHeight / 2) : lastY;
      element.style.transition = 'none';
      element.style.transform = cursorTransform(startX, startY);
      void element.getBoundingClientRect();
    }
    element.style.transition = command.animateMovement
      ? 'transform ' + animationMs + 'ms ease-out'
      : 'none';
    element.style.transform = cursorTransform(command.x, command.y);
    lastX = command.x;
    lastY = command.y;
    let completed = false;
    const complete = () => {
      if (completed || lastSequence !== command.moveSequence) return;
      completed = true;
      if (arrivalTimer) clearTimeout(arrivalTimer);
      arrivalTimer = null;
      if (transitionListener) element.removeEventListener('transitionend', transitionListener);
      transitionListener = null;
      if (command.restore === true) return;
      emitArrival(command);
    };
    if (command.animateMovement) {
      transitionListener = (event) => {
        if (event.target === element && event.propertyName === 'transform') complete();
      };
      element.addEventListener('transitionend', transitionListener);
      arrivalTimer = setTimeout(complete, animationMs + 34);
    } else {
      queueMicrotask(complete);
    }
    return true;
  };

  if (allowTestQueue && !Array.isArray(globalThis['${AGENT_CURSOR_TEST_QUEUE_NAME}'])) {
    globalThis['${AGENT_CURSOR_TEST_QUEUE_NAME}'] = [];
  }
  ensureHost();
  globalThis.__mavisEmbeddedBrowserAgentCursorVersion = bridgeVersion;
  globalThis[controlName] = Object.freeze({ dispatch });
  return true;
})()`;
}
export let AGENT_CURSOR_BRIDGE_SCRIPT = buildAgentCursorBridgeScript();
export let AGENT_CURSOR_BRIDGE_TEST_SCRIPT = buildAgentCursorBridgeScript({
    allowTestQueue: true,
    openShadowRootForTests: true,
});
