/**
 * Embedded browser comment bridge — the script injected into embedded
 * pages for annotation mode, plus the preload IPC transport envelope.
 * Kept separate from the manager so the injected payload is reviewable
 * on its own and the manager stays within size limits.
 */

import { COMMENT_COMPOSER_BRIDGE_THEME_VARIABLES, COMMENT_COMPOSER_SPEC, resolveCommentInputAutoGrow } from "@mavis/shared/comment-composer";
import { COMMENT_MARKER_BRIDGE_THEME_VARIABLES, COMMENT_MARKER_SPEC } from "@mavis/shared/comment-marker";
export let EMBEDDED_COMMENT_SOURCE = 'mavis-embedded-browser-comment';
export let EMBEDDED_COMMENT_WORLD_ID = 1004;
export let EMBEDDED_COMMENT_CONTROL_NAME = '__mavisEmbeddedBrowserCommentBridgeControl';
export let EMBEDDED_COMMENT_QUEUE_NAME = '__mavisEmbeddedBrowserCommentBridgeQueue';
export let EMBEDDED_COMMENT_DIAGNOSTIC_QUEUE_NAME = '__mavisEmbeddedBrowserCommentBridgeDiagnosticQueue';
const EMBEDDED_COMMENT_COMPOSER_ICONS = {
    close: {
        viewBox: '0 0 20 20',
        paths: [
            {
                'fill-rule': 'evenodd',
                'clip-rule': 'evenodd',
                d: 'M14.6585 4.34363C14.8928 4.10931 15.2728 4.10931 15.5071 4.34363C15.741 4.57786 15.741 4.95705 15.5071 5.19128L10.6975 9.99988L15.5071 14.8085C15.7413 15.0428 15.7414 15.4228 15.5071 15.6571C15.2728 15.8914 14.8928 15.8913 14.6585 15.6571L9.84987 10.8475L5.04128 15.6571C4.80704 15.891 4.42785 15.891 4.19362 15.6571C3.9593 15.4228 3.9593 15.0428 4.19362 14.8085L9.00124 9.99988L4.19362 5.19128C3.95933 4.95698 3.95933 4.57794 4.19362 4.34363C4.42793 4.10932 4.80696 4.10933 5.04128 4.34363L9.84987 9.15125L14.6585 4.34363Z',
                fill: 'currentColor',
            },
        ],
    },
    confirm: {
        viewBox: '0 0 20 20',
        paths: [
            {
                d: 'M3.125 9.11857L8.0609 16.1699L16.875 3.83011',
                stroke: 'currentColor',
                'stroke-width': '1.2',
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round',
            },
        ],
    },
    delete: {
        viewBox: '0 0 20 20',
        paths: [
            {
                d: 'M12.2524 2.28223C13.2415 2.28223 14.0435 3.08414 14.0435 4.07324V5.46973H18.3335C18.6647 5.46984 18.933 5.73812 18.9331 6.06934C18.9331 6.40064 18.6648 6.66883 18.3335 6.66895H15.9595V14.7363C15.9595 16.383 14.6246 17.7175 12.978 17.7178H7.02295C5.37613 17.7178 4.04151 16.3832 4.0415 14.7363V6.66895H1.6665C1.33519 6.66888 1.06689 6.40066 1.06689 6.06934C1.067 5.7381 1.33526 5.4698 1.6665 5.46973H5.95654V4.07324C5.95654 3.08422 6.75856 2.28236 7.74756 2.28223H12.2524ZM5.24072 14.7363C5.24073 15.7204 6.03887 16.5185 7.02295 16.5186H12.978C13.9619 16.5183 14.7593 15.7202 14.7593 14.7363V6.66895H5.24072ZM8.37549 9.52637C8.70671 9.52648 8.97502 9.79474 8.9751 10.126V13.6992C8.97486 14.0303 8.70661 14.2987 8.37549 14.2988C8.04426 14.2988 7.77611 14.0304 7.77588 13.6992V10.126C7.77596 9.79467 8.04417 9.52637 8.37549 9.52637ZM11.7192 9.52637C12.0505 9.52649 12.3188 9.79475 12.3188 10.126V13.6992C12.3186 14.0303 12.0504 14.2987 11.7192 14.2988C11.388 14.2988 11.1199 14.0304 11.1196 13.6992V10.126C11.1197 9.79467 11.3879 9.52637 11.7192 9.52637ZM7.74756 3.48145C7.4213 3.48158 7.15576 3.74696 7.15576 4.07324V5.46973H12.8442V4.07324C12.8442 3.74688 12.5788 3.48145 12.2524 3.48145H7.74756Z',
                fill: 'currentColor',
            },
        ],
    },
};
export let EMBEDDED_COMMENT_BRIDGE_VERSION = '2026-10-12-comment-sidebar-focus-v16';
export function buildEmbeddedCommentBridgeScript(options) {
    const allowSyntheticEventsForTests = options?.allowSyntheticEventsForTests === true;
    const isolateUiInShadowRoot = options?.isolateUiInShadowRoot !== false;
    return `(() => {
  const source = '${EMBEDDED_COMMENT_SOURCE}';
  const controlName = '${EMBEDDED_COMMENT_CONTROL_NAME}';
  const bridgeVersion = '${EMBEDDED_COMMENT_BRIDGE_VERSION}';
  const allowSyntheticEventsForTests = ${allowSyntheticEventsForTests};
  const isolateUiInShadowRoot = ${isolateUiInShadowRoot};
  const composerIcons = ${JSON.stringify(EMBEDDED_COMMENT_COMPOSER_ICONS)};
  const composerCssVariables = ${JSON.stringify(COMMENT_COMPOSER_BRIDGE_THEME_VARIABLES)};
  const composerSpec = ${JSON.stringify(COMMENT_COMPOSER_SPEC)};
  // Serialised rather than reimplemented: the chat composer calls this exact
  // function, so both boxes grow, clamp and wrap on the same numbers. It is
  // pure and closes over nothing, which is what makes this safe.
  const resolveCommentInputAutoGrow = ${resolveCommentInputAutoGrow.toString()};
  const markerCssVariables = ${JSON.stringify(COMMENT_MARKER_BRIDGE_THEME_VARIABLES)};
  const markerSpec = ${JSON.stringify(COMMENT_MARKER_SPEC)};
  if (window.__mavisEmbeddedBrowserCommentBridgeInstalled) {
    return {
      installed: true,
      bridgeVersion: window.__mavisEmbeddedBrowserCommentBridgeVersion || 'legacy',
    };
  }
  window.__mavisEmbeddedBrowserCommentBridgeInstalled = true;
  window.__mavisEmbeddedBrowserCommentBridgeVersion = bridgeVersion;

  let enabled = false;
  let hovered = null;
  let activeElement = null;
  let activeRect = null;
  let hoverBox = null;
  let activeBox = null;
  let dragBox = null;
  let composer = null;
  let commentSeq = 0;
  let messageSeq = 0;
  let placeholderText = 'Add comment...';
  let themeMode = 'system';
  let themePalette = null;
  let selectionMode = 'free_rect';
  let interactionState = 'disabled';
  let pointerGesture = null;
  let suppressedClick = null;
  let activeComment = null;
  let composerInput = null;
  // Relayout hook for the open composer. The viewport drives the box's width,
  // and width drives wrapping, so a resize has to re-measure the comment.
  let composerRelayout = null;
  let composerGeneration = 0;
  let testMessageHandler = null;
  const comments = [];
  const freeRectActivationDistance = 4;
  let bridgeUiHost = null;
  let bridgeUiRoot = null;
  let bridgeUiEventBoundaryRoot = null;
  const bridgeUiPropagationEvents = [
    'pointerdown',
    'pointerup',
    'pointercancel',
    'mousedown',
    'mouseup',
    'click',
    'dblclick',
    'touchstart',
    'touchend',
    'touchcancel',
    'contextmenu',
    'wheel',
    'keydown',
    'keyup',
    'keypress',
    'beforeinput',
    'input',
    'change',
    'compositionstart',
    'compositionupdate',
    'compositionend',
    'paste',
    'copy',
    'cut',
    'focusin',
    'focusout',
    'dragstart',
    'dragend',
    'dragover',
    'drop',
  ];
  const stopBridgeUiEventPropagation = (event) => {
    if (!isolateUiInShadowRoot) {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        !target.closest('[data-mavis-embedded-comment-ui="true"]')
      ) {
        return;
      }
    }
    event.stopPropagation();
  };
  // A modal sidebar can reclaim focus on the outgoing page control's
  // focusout, before focus reaches our shadow root. Isolate only transitions
  // into annotation UI; normal page-to-page focus remains owned by the site.
  const stopPageFocusOutIntoBridgeUi = (event) => {
    const next = event.relatedTarget;
    if (
      next instanceof Element &&
      next.closest('[data-mavis-embedded-comment-ui="true"]')
    ) {
      event.stopPropagation();
    }
  };
  const removeBridgeUiEventBoundary = () => {
    if (!bridgeUiEventBoundaryRoot) return;
    bridgeUiPropagationEvents.forEach((type) => {
      bridgeUiEventBoundaryRoot.removeEventListener(type, stopBridgeUiEventPropagation);
    });
    document.removeEventListener('focusout', stopPageFocusOutIntoBridgeUi, true);
    bridgeUiEventBoundaryRoot = null;
  };
  const installBridgeUiEventBoundary = (root) => {
    if (!root || bridgeUiEventBoundaryRoot === root) return;
    removeBridgeUiEventBoundary();
    bridgeUiEventBoundaryRoot = root;
    document.addEventListener('focusout', stopPageFocusOutIntoBridgeUi, true);
    bridgeUiPropagationEvents.forEach((type) => {
      root.addEventListener(type, stopBridgeUiEventPropagation);
    });
  };

  const ensureBridgeUiRoot = () => {
    if (!isolateUiInShadowRoot) {
      installBridgeUiEventBoundary(document.documentElement);
      return document.documentElement;
    }
    if (!bridgeUiHost) {
      bridgeUiHost = document.createElement('div');
      bridgeUiHost.setAttribute('data-mavis-embedded-comment-ui', 'true');
      bridgeUiHost.setAttribute('data-mavis-embedded-comment-host', 'true');
      bridgeUiHost.style.position = 'fixed';
      bridgeUiHost.style.inset = '0';
      bridgeUiHost.style.zIndex = '2147483647';
      bridgeUiHost.style.pointerEvents = 'none';
      bridgeUiRoot = bridgeUiHost.attachShadow({ mode: 'closed' });
    }
    if (!bridgeUiHost.isConnected) document.documentElement.appendChild(bridgeUiHost);
    installBridgeUiEventBoundary(bridgeUiRoot);
    return bridgeUiRoot;
  };
  const mountBridgeUi = (element) => {
    const root = ensureBridgeUiRoot();
    if (root) root.appendChild(element);
  };
  const currentActiveElement = () =>
    bridgeUiRoot && bridgeUiRoot.activeElement
      ? bridgeUiRoot.activeElement
      : document.activeElement;

  ensureBridgeUiRoot();

  if (allowSyntheticEventsForTests) {
    if (!Array.isArray(window['${EMBEDDED_COMMENT_QUEUE_NAME}'])) {
      window['${EMBEDDED_COMMENT_QUEUE_NAME}'] = [];
    }
    if (!Array.isArray(window['${EMBEDDED_COMMENT_DIAGNOSTIC_QUEUE_NAME}'])) {
      window['${EMBEDDED_COMMENT_DIAGNOSTIC_QUEUE_NAME}'] = [];
    }
  }

  const ensureComposerStyle = () => {
    const root = ensureBridgeUiRoot();
    if (!root || root.querySelector('#mavis-embedded-comment-style')) return;
    const style = document.createElement('style');
    style.id = 'mavis-embedded-comment-style';
    style.textContent =
      '[data-mavis-embedded-comment-input]::placeholder {' +
      'color: var(--mavis-comment-placeholder, GrayText); opacity: 1;}';
    root.appendChild(style);
  };
  const applyComposerPalette = (element) => {
    if (!element || !themePalette) return;
    Object.entries(composerCssVariables).forEach(([role, cssVariable]) => {
      const value = themePalette[role];
      if (typeof value === 'string' && value.trim()) {
        element.style.setProperty(cssVariable, value);
      }
    });
  };
  const applyMarkerPalette = (element) => {
    if (!element || !themePalette) return;
    Object.entries(markerCssVariables).forEach(([role, cssVariable]) => {
      const value = themePalette[role];
      if (typeof value === 'string' && value.trim()) {
        element.style.setProperty(cssVariable, value);
      }
    });
  };
  const mountComposerIcon = (button, definition, size) => {
    const svgNamespace = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(svgNamespace, 'svg');
    icon.setAttribute('width', String(size));
    icon.setAttribute('height', String(size));
    icon.setAttribute('viewBox', definition.viewBox);
    icon.setAttribute('fill', 'none');
    icon.setAttribute('aria-hidden', 'true');
    definition.paths.forEach((attributes) => {
      const path = document.createElementNS(svgNamespace, 'path');
      Object.entries(attributes).forEach(([name, value]) => path.setAttribute(name, value));
      icon.appendChild(path);
    });
    button.replaceChildren(icon);
  };

  const round = (value) => Math.round(value * 100) / 100;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  };
  const isBridgeUi = (target) => Boolean(target && target.closest && target.closest('[data-mavis-embedded-comment-ui]'));
  const isTrustedUserEvent = (event) =>
    Boolean(event && (event.isTrusted === true || allowSyntheticEventsForTests));
  const emit = (type, payload, retainInQueue) => {
    const message = { source, type, messageId: ++messageSeq, payload };
    if (allowSyntheticEventsForTests) {
      const testQueueName =
        retainInQueue || type !== 'diagnostic'
          ? '${EMBEDDED_COMMENT_QUEUE_NAME}'
          : '${EMBEDDED_COMMENT_DIAGNOSTIC_QUEUE_NAME}';
      const testQueue = window[testQueueName];
      if (Array.isArray(testQueue)) testQueue.push(message);
    }
    try {
      const bridge = globalThis.mavisEmbeddedBrowserBridge;
      if (bridge && typeof bridge.emitCommentEvent === 'function') {
        const delivery = bridge.emitCommentEvent(message);
        if (delivery && typeof delivery.catch === 'function') delivery.catch(() => {});
      }
    } catch (_) {
      // The preload-owned transport retries transient IPC failures.
    }
  };
  const post = (type, payload) => emit(type, payload, true);
  const pointerState = () =>
    pointerGesture ? (pointerGesture.dragging ? 'dragging_rect' : 'pointer_pending') : 'none';
  const focusSnapshot = () => {
    const active = currentActiveElement();
    return {
      activeTag: active && active.tagName ? active.tagName.toLowerCase() : null,
      activeIsCommentInput: active === composerInput,
      activeIsBridgeUi: isBridgeUi(active),
      documentHasFocus:
        typeof document.hasFocus === 'function' ? Boolean(document.hasFocus()) : null,
      pointerState: pointerState(),
    };
  };
  const diagnose = (event, details) => {
    emit(
      'diagnostic',
      {
        event,
        bridgeVersion,
        ts: Date.now(),
        selectionMode,
        interactionState,
        ...focusSnapshot(),
        ...(details || {}),
      },
      false,
    );
  };
  const composerMountDetails = (stage, wrapper = composer, input = composerInput) => {
    let rect = null;
    try {
      rect = wrapper && typeof wrapper.getBoundingClientRect === 'function'
        ? wrapper.getBoundingClientRect()
        : null;
    } catch (_) {
      rect = null;
    }
    return {
      stage,
      hostConnected: Boolean(bridgeUiHost && bridgeUiHost.isConnected),
      rootAvailable: isolateUiInShadowRoot
        ? Boolean(bridgeUiRoot)
        : Boolean(document.documentElement),
      uiRootConnected: isolateUiInShadowRoot
        ? Boolean(bridgeUiHost && bridgeUiHost.isConnected)
        : Boolean(document.documentElement && document.documentElement.isConnected),
      composerConnected: Boolean(wrapper && wrapper.isConnected),
      inputConnected: Boolean(input && input.isConnected),
      composerWidth: rect ? round(rect.width) : null,
      composerHeight: rect ? round(rect.height) : null,
      composerLeft: rect ? round(rect.left) : null,
      composerTop: rect ? round(rect.top) : null,
    };
  };
  const setInteractionState = (nextState, reason) => {
    if (interactionState === nextState) return;
    const previousState = interactionState;
    interactionState = nextState;
    diagnose('interaction-transition', {
      previousState,
      nextState,
      reason,
    });
  };
  const clearHover = () => {
    hovered = null;
    updateBox(hoverBox, null);
  };
  const composerHasFocus = () =>
    Boolean(composer && composerInput && currentActiveElement() === composerInput);
  const canInspectPage = () =>
    enabled && interactionState === 'idle' && !pointerGesture;
  const pointerIdFor = (event) =>
    event && typeof event.pointerId === 'number' && Number.isFinite(event.pointerId)
      ? event.pointerId
      : null;
  const matchesPointerGesture = (event) => {
    if (!pointerGesture) return false;
    const eventPointerId = pointerIdFor(event);
    return (
      pointerGesture.pointerId === null ||
      eventPointerId === null ||
      pointerGesture.pointerId === eventPointerId
    );
  };
  let lastControlPointerMoveDiagnosticAt = 0;
  const interactiveControlFor = (target) => {
    if (!(target instanceof Element)) return null;
    return target.closest(
      'input,button,select,textarea,a[href],[role="button"],[role="slider"],[contenteditable="true"]',
    );
  };
  const safeDomToken = (value) => {
    if (typeof value !== 'string') return null;
    const token = value.trim().slice(0, 80);
    return /^[a-zA-Z0-9_-]+$/.test(token) ? token : null;
  };
  const safeClassName = (target) => {
    if (!(target instanceof Element)) return null;
    return Array.from(target.classList || [])
      .map((token) => safeDomToken(token))
      .filter(Boolean)
      .slice(0, 4)
      .join(' ') || null;
  };
  const pointerHitGeometry = (event) => {
    if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return {};
    const ranges = Array.from(
      document.querySelectorAll('input[type="range"],[role="slider"]'),
    ).slice(0, 100);
    let nearest = null;
    let nearestRect = null;
    let nearestDx = null;
    let nearestDy = null;
    let nearestDistanceSquared = Infinity;
    for (const candidate of ranges) {
      const rect = candidate.getBoundingClientRect();
      const dx =
        event.clientX < rect.left
          ? event.clientX - rect.left
          : event.clientX > rect.right
            ? event.clientX - rect.right
            : 0;
      const dy =
        event.clientY < rect.top
          ? event.clientY - rect.top
          : event.clientY > rect.bottom
            ? event.clientY - rect.bottom
            : 0;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared >= nearestDistanceSquared) continue;
      nearest = candidate;
      nearestRect = rect;
      nearestDx = dx;
      nearestDy = dy;
      nearestDistanceSquared = distanceSquared;
    }
    let hit = null;
    try {
      hit = document.elementFromPoint(event.clientX, event.clientY);
    } catch (_) {
      hit = null;
    }
    const scene = document.querySelector('.scene');
    const visualViewport = window.visualViewport;
    return {
      hitTestTag: hit && hit.tagName ? hit.tagName.toLowerCase() : null,
      hitTestId: hit ? safeDomToken(hit.id) : null,
      nearestRangeId: nearest ? safeDomToken(nearest.id) : null,
      nearestRangeInputType:
        nearest instanceof HTMLInputElement ? String(nearest.type || '').toLowerCase() : null,
      pointerInsideNearestRange: nearestDistanceSquared === 0,
      nearestRangeDeltaX: nearestDx === null ? null : Math.round(nearestDx),
      nearestRangeDeltaY: nearestDy === null ? null : Math.round(nearestDy),
      nearestRangeWidth: nearestRect ? Math.round(nearestRect.width) : null,
      nearestRangeHeight: nearestRect ? Math.round(nearestRect.height) : null,
      pageInnerWidth: Math.round(window.innerWidth),
      pageInnerHeight: Math.round(window.innerHeight),
      pageDevicePixelRatio: Number(window.devicePixelRatio || 1),
      pageVisualViewportScale: visualViewport ? Number(visualViewport.scale || 1) : null,
      sceneTransform:
        scene && typeof getComputedStyle === 'function'
          ? String(getComputedStyle(scene).transform || 'none').slice(0, 120)
          : null,
    };
  };
  const diagnosePageControlEvent = (event, listenerPhase) => {
    const control = interactiveControlFor(event.target);
    const rawTarget = event.target instanceof Element ? event.target : null;
    if (isBridgeUi(control || rawTarget)) return;
    const shouldLogMiss =
      !control &&
      (event.type === 'pointerdown' || event.type === 'pointerup' || event.type === 'click');
    if (!control && !shouldLogMiss) return;
    const diagnosticTarget = control || rawTarget;
    const targetInputType =
      control instanceof HTMLInputElement ? String(control.type || 'text').toLowerCase() : null;
    const targetRole = control ? control.getAttribute('role') : null;
    const isSlider = targetInputType === 'range' || targetRole === 'slider';
    if (event.type === 'pointermove') {
      if (!isSlider) return;
      const now = Date.now();
      if (now - lastControlPointerMoveDiagnosticAt < 100) return;
      lastControlPointerMoveDiagnosticAt = now;
    }
    const eventPhase = event.eventPhase;
    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : null;
    const emitFinalState = () => {
      let targetHasPointerCapture = null;
      try {
        if (pointerId !== null && control && typeof control.hasPointerCapture === 'function') {
          targetHasPointerCapture = Boolean(control.hasPointerCapture(pointerId));
        }
      } catch (_) {
        targetHasPointerCapture = null;
      }
      diagnose('page-control-event', {
        eventType: event.type,
        listenerPhase,
        eventPhase,
        defaultPrevented: Boolean(event.defaultPrevented),
        propagationStopped: Boolean(event.cancelBubble),
        commentModeEnabled: enabled,
        targetTag:
          diagnosticTarget && diagnosticTarget.tagName
            ? diagnosticTarget.tagName.toLowerCase()
            : null,
        targetId: diagnosticTarget ? safeDomToken(diagnosticTarget.id) : null,
        targetClass: safeClassName(diagnosticTarget),
        controlDetected: Boolean(control),
        targetInputType,
        targetRole,
        targetDisabled: control && 'disabled' in control ? Boolean(control.disabled) : null,
        targetHasPointerCapture,
        button: typeof event.button === 'number' ? event.button : null,
        buttons: typeof event.buttons === 'number' ? event.buttons : null,
        pointerType: typeof event.pointerType === 'string' ? event.pointerType : null,
        ...(event.type === 'pointerdown' && listenerPhase === 'capture'
          ? pointerHitGeometry(event)
          : {}),
      });
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(emitFinalState);
    else Promise.resolve().then(emitFinalState);
  };
  const keyKind = (event) => {
    if (event.key === 'Enter') return 'enter';
    if (event.key === 'Escape') return 'escape';
    if (event.metaKey || event.ctrlKey || event.altKey) return 'modifier';
    if (typeof event.key === 'string' && event.key.length === 1) return 'printable';
    return 'other';
  };
  const inputEventDiagnostic = (event, composing) => ({
    eventType: event.type,
    eventPhase: event.eventPhase,
    defaultPrevented: event.defaultPrevented,
    isComposing: Boolean(event.isComposing),
    composing: Boolean(composing),
    inputType: typeof event.inputType === 'string' ? event.inputType : null,
    valueLength: composerInput ? composerInput.value.length : 0,
  });

  const ensureBox = (kind) => {
    const existing = kind === 'hover' ? hoverBox : activeBox;
    if (existing) return existing;
    const box = document.createElement('div');
    box.setAttribute('data-mavis-embedded-comment-ui', 'true');
    box.setAttribute('data-mavis-embedded-comment-box', kind);
    box.style.position = 'fixed';
    box.style.display = 'none';
    box.style.pointerEvents = 'none';
    box.style.boxSizing = 'border-box';
    box.style.zIndex = kind === 'hover' ? '2147483644' : '2147483645';
    box.style.border = '2px solid #0A84FF';
    box.style.background = kind === 'hover' ? 'rgba(10,132,255,0.08)' : 'rgba(10,132,255,0.16)';
    box.style.boxShadow = 'none';
    mountBridgeUi(box);
    if (kind === 'hover') hoverBox = box;
    else activeBox = box;
    return box;
  };

  const updateBox = (box, element) => {
    if (!box) return;
    if (!enabled || !element || !document.documentElement.contains(element)) {
      box.style.display = 'none';
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
  };

  const updateBoxRect = (box, rect) => {
    if (!box) return;
    if (!enabled || !rect || rect.width <= 0 || rect.height <= 0) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    box.style.left = rect.x + 'px';
    box.style.top = rect.y + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
  };

  const updateActiveBox = () => {
    if (activeElement) {
      updateBox(activeBox, activeElement);
      return;
    }
    updateBoxRect(activeBox, activeRect);
  };

  const ensureDragBox = () => {
    if (dragBox) return dragBox;
    const box = document.createElement('div');
    box.setAttribute('data-mavis-embedded-comment-ui', 'true');
    box.setAttribute('data-mavis-embedded-comment-box', 'drag');
    box.style.position = 'fixed';
    box.style.display = 'none';
    box.style.pointerEvents = 'none';
    box.style.boxSizing = 'border-box';
    box.style.zIndex = '2147483646';
    box.style.border = '2px dashed #0A84FF';
    box.style.background = 'rgba(10,132,255,0.12)';
    box.style.boxShadow = 'none';
    mountBridgeUi(box);
    dragBox = box;
    return box;
  };

  const normalizeRect = (rect) => {
    if (!rect) return null;
    const x = Number(rect.x);
    const y = Number(rect.y);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      return null;
    }
    return {
      x: round(x),
      y: round(y),
      width: round(Math.max(0, width)),
      height: round(Math.max(0, height)),
    };
  };

  const rectFromPoints = (start, end) => normalizeRect({
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  });

  const selectionRectFromPoints = (start, end) => {
    const rect = rectFromPoints(start, end);
    if (!rect) return null;
    return {
      ...rect,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    };
  };

  const rectFromDomRect = (rect) => normalizeRect({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });

  const toDocumentRect = (rect) => normalizeRect({
    x: rect.x + (window.scrollX || 0),
    y: rect.y + (window.scrollY || 0),
    width: rect.width,
    height: rect.height,
  });

  const toViewportRect = (rect) => normalizeRect({
    x: rect.x - (window.scrollX || 0),
    y: rect.y - (window.scrollY || 0),
    width: rect.width,
    height: rect.height,
  });

  const selectorFor = (element) => {
    if (element.id) return '#' + cssEscape(element.id);
    const testId = element.getAttribute('data-testid');
    if (testId) return '[data-testid="' + String(testId).replace(/"/g, '\\\\"') + '"]';
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 6) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter((item) => item.tagName === node.tagName);
      const index = siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : '';
      parts.unshift(tag + index);
      node = parent;
    }
    return parts.join(' > ') || element.tagName.toLowerCase();
  };

  const targetPathFor = (element) => {
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 8) {
      parts.unshift(node.tagName.toLowerCase());
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const cleanText = (value, max = 220) =>
    String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);

  const intersectionArea = (a, b) => {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return Math.max(0, right - left) * Math.max(0, bottom - top);
  };

  const attributesFor = (element) => {
    const attributes = {};
    ['id', 'class', 'aria-label', 'role', 'href', 'alt', 'title', 'data-testid'].forEach((attr) => {
      const value = element.getAttribute(attr);
      if (value) attributes[attr] = value;
    });
    return attributes;
  };

  const collectDomCandidates = (selectionRect) => {
    const rect = normalizeRect(selectionRect);
    if (!rect || rect.width <= 0 || rect.height <= 0) return [];
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const centerStack =
      typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(centerX, centerY)
        : [];
    const nodes = Array.from(document.body ? document.body.querySelectorAll('*') : []);
    return nodes
      .slice(0, 5000)
      .map((element) => {
        if (!(element instanceof Element) || isBridgeUi(element)) return null;
        const tagName = element.tagName.toLowerCase();
        if (tagName === 'script' || tagName === 'style' || tagName === 'noscript') return null;
        const candidateRect = rectFromDomRect(element.getBoundingClientRect());
        if (!candidateRect || candidateRect.width <= 0 || candidateRect.height <= 0) return null;
        const overlap = intersectionArea(rect, candidateRect);
        if (overlap <= 0) return null;
        const candidateArea = Math.max(1, candidateRect.width * candidateRect.height);
        const selectionArea = Math.max(1, rect.width * rect.height);
        const overlapRatio = round(overlap / Math.min(candidateArea, selectionArea));
        const centerRank = centerStack.indexOf(element);
        const containsCenter =
          centerX >= candidateRect.x &&
          centerX <= candidateRect.x + candidateRect.width &&
          centerY >= candidateRect.y &&
          centerY <= candidateRect.y + candidateRect.height;
        const text = cleanText(element.innerText || element.textContent || '', 180);
        const score = round(
          overlapRatio * 100 +
            (containsCenter ? 20 : 0) +
            (centerRank >= 0 ? Math.max(0, 12 - centerRank) : 0) +
            (text ? 4 : 0),
        );
        return {
          selector: selectorFor(element),
          tagName,
          text,
          attributes: attributesFor(element),
          rect: candidateRect,
          targetPath: targetPathFor(element),
          overlapRatio,
          containsCenter,
          score,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || b.overlapRatio - a.overlapRatio)
      .slice(0, 8);
  };

  const payloadFor = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      selectionMode: 'dom_node',
      selector: selectorFor(element),
      tagName: element.tagName.toLowerCase(),
      text: cleanText(element.innerText || element.textContent || '', 220),
      attributes: attributesFor(element),
      rect: {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
      },
      viewport: {
        width: Math.round(window.innerWidth || document.documentElement.clientWidth || 0),
        height: Math.round(window.innerHeight || document.documentElement.clientHeight || 0),
      },
      pageUrl: window.location.href || document.URL || 'about:blank',
      targetPath: targetPathFor(element),
    };
  };

  const payloadForRect = (rect) => {
    const normalized = normalizeRect(rect);
    const domCandidates = collectDomCandidates(normalized);
    const targetText = cleanText(
      domCandidates
        .map((candidate) => candidate.text)
        .filter(Boolean)
        .filter((value, index, all) => all.indexOf(value) === index)
        .join(' / '),
      220,
    );
    const primary = domCandidates[0];
    return {
      selectionMode: 'free_rect',
      selector: primary ? primary.selector : '',
      tagName: 'region',
      text: targetText,
      attributes: {},
      rect: normalized,
      viewport: {
        width: Math.round(window.innerWidth || document.documentElement.clientWidth || 0),
        height: Math.round(window.innerHeight || document.documentElement.clientHeight || 0),
      },
      pageUrl: window.location.href || document.URL || 'about:blank',
      targetPath: primary ? primary.targetPath : 'free rectangle',
      domCandidates,
    };
  };

  const getCommentViewportRect = (comment) => {
    if (comment.selectionMode === 'free_rect') {
      return toViewportRect(comment.documentRect || comment.rect);
    }
    if (!comment.element || !document.documentElement.contains(comment.element)) return null;
    return rectFromDomRect(comment.element.getBoundingClientRect());
  };

  const positionMarker = (comment) => {
    if (!comment.marker || !enabled) {
      if (comment.marker) comment.marker.style.display = 'none';
      return;
    }
    const rect = getCommentViewportRect(comment);
    if (!rect || rect.width <= 0 || rect.height <= 0 || rect.y + rect.height < 0 || rect.y > window.innerHeight) {
      comment.marker.style.display = 'none';
      return;
    }
    comment.marker.style.display = 'flex';
    const markerRect = comment.marker.getBoundingClientRect();
    const markerWidth = markerRect.width || markerSpec.size;
    const markerHeight = markerRect.height || markerSpec.size;
    const halfMarkerHeight = markerHeight / 2;
    const top = clamp(
      rect.y + rect.height - halfMarkerHeight - 2,
      8,
      Math.max(8, window.innerHeight - markerHeight - 8),
    );
    comment.marker.style.left =
      clamp(rect.x - markerWidth / 2, 8, Math.max(8, window.innerWidth - markerWidth - 8)) + 'px';
    comment.marker.style.top = top + 'px';
  };

  const createMarker = (comment) => {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.setAttribute('data-mavis-embedded-comment-ui', 'true');
    marker.setAttribute('aria-label', 'Browser comment ' + comment.commentId);
    marker.setAttribute('data-comment-marker', 'true');
    marker.setAttribute('data-comment-marker-state', 'idle');
    marker.setAttribute('data-comment-anchor-surface', 'embedded-browser');
    marker.setAttribute('data-comment-anchor-context', 'comment-' + comment.commentId);
    marker.setAttribute(
      'data-comment-anchor-selection-kind',
      comment.selectionMode === 'free_rect' ? 'free-rect' : 'dom-node',
    );
    marker.textContent = String(comment.commentId);
    marker.style.position = 'fixed';
    marker.style.zIndex = '2147483647';
    marker.style.boxSizing = 'border-box';
    marker.style.appearance = 'none';
    marker.style.width = markerSpec.width;
    marker.style.height = markerSpec.size + 'px';
    marker.style.minWidth = markerSpec.size + 'px';
    marker.style.padding = '0 ' + markerSpec.paddingInline + 'px';
    marker.style.borderStyle = 'solid';
    marker.style.borderWidth = markerSpec.borderWidth + 'px';
    marker.style.borderColor = 'var(--mavis-comment-marker-border, #ffffff)';
    marker.style.borderRadius = markerSpec.borderRadius + 'px';
    marker.style.background = 'var(--mavis-comment-marker-background, #0094fc)';
    marker.style.color = 'var(--mavis-comment-marker-text, rgba(255,255,255,0.95))';
    marker.style.boxShadow =
      markerSpec.shadow.offsetX + 'px ' +
      markerSpec.shadow.offsetY + 'px ' +
      markerSpec.shadow.blurRadius + 'px ' +
      'var(--mavis-comment-marker-shadow, rgba(10,10,10,0.08))';
    marker.style.display = 'none';
    marker.style.alignItems = 'center';
    marker.style.justifyContent = 'center';
    marker.style.font =
      markerSpec.fontWeight + ' ' +
      markerSpec.fontSize + 'px/' +
      markerSpec.lineHeight + 'px ' +
      markerSpec.fontFamily;
    marker.style.letterSpacing = markerSpec.letterSpacing + 'px';
    marker.style.textAlign = 'center';
    marker.style.cursor = markerSpec.cursor;
    applyMarkerPalette(marker);
    const tooltip = document.createElement('div');
    tooltip.setAttribute('data-mavis-embedded-comment-ui', 'true');
    tooltip.style.position = 'fixed';
    tooltip.style.zIndex = '2147483646';
    tooltip.style.display = 'none';
    tooltip.style.pointerEvents = 'none';
    tooltip.style.maxWidth = '260px';
    tooltip.style.padding = '6px 12px';
    tooltip.style.borderRadius = '999px';
    tooltip.style.background = '#ffffff';
    tooltip.style.color = '#171717';
    tooltip.style.font = '500 13px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    tooltip.style.boxShadow = '0 0 20px rgba(10,10,10,0.08)';
    tooltip.style.whiteSpace = 'nowrap';
    tooltip.style.overflow = 'hidden';
    tooltip.style.textOverflow = 'ellipsis';
    tooltip.style.pointerEvents = 'auto';
    mountBridgeUi(tooltip);
    comment.tooltip = tooltip;
    marker.addEventListener('mouseenter', () => {
      marker.setAttribute('data-comment-marker-state', 'hovered');
      if (!comment.feedback) return;
      const markerRect = marker.getBoundingClientRect();
      tooltip.textContent = comment.feedback;
      tooltip.style.display = 'block';
      const tipRect = tooltip.getBoundingClientRect();
      tooltip.style.left =
        clamp(markerRect.left, 8, Math.max(8, window.innerWidth - tipRect.width - 8)) + 'px';
      tooltip.style.top =
        clamp(markerRect.top - tipRect.height - 8, 8, Math.max(8, window.innerHeight - 8)) + 'px';
    });
    marker.addEventListener('mouseleave', () => {
      marker.setAttribute('data-comment-marker-state', 'idle');
      tooltip.style.display = 'none';
    });
    marker.addEventListener('focus', () => {
      marker.setAttribute('data-comment-marker-state', 'active');
    });
    marker.addEventListener('blur', () => {
      marker.setAttribute('data-comment-marker-state', 'idle');
    });
    marker.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      tooltip.style.display = 'none';
      openComposer(
        comment.selectionMode === 'free_rect'
          ? { selectionMode: 'free_rect', rect: getCommentViewportRect(comment) || comment.rect }
          : comment.element,
        comment,
      );
    });
    marker.style.pointerEvents = 'auto';
    mountBridgeUi(marker);
    return marker;
  };

  const removeComposer = () => {
    composerGeneration += 1;
    if (composer) composer.remove();
    composer = null;
    composerInput = null;
    composerRelayout = null;
    activeElement = null;
    activeRect = null;
    activeComment = null;
    clearHover();
    setInteractionState(enabled ? 'idle' : 'disabled', 'composer-removed');
    updateActiveBox();
  };

  const focusComposerInput = (generation = composerGeneration, reason = 'scheduled') => {
    const input = composerInput;
    const skipReason =
      generation !== composerGeneration
        ? 'stale-generation'
        : interactionState !== 'composing'
          ? 'not-composing'
          : !composer || !input || !composer.contains(input)
            ? 'missing-composer'
            : currentActiveElement() === input
              ? 'already-focused'
              : pointerGesture
                ? 'pointer-active'
                : null;
    if (skipReason) {
      diagnose('focus-attempt', { reason, result: 'skipped', skipReason });
      return;
    }
    try {
      input.focus({ preventScroll: true });
    } catch (_) {
      input.focus();
    }
    diagnose('focus-attempt', {
      reason,
      result: currentActiveElement() === input ? 'focused' : 'focus-rejected',
    });
  };

  const removeComment = (comment, event) => {
    if (!isTrustedUserEvent(event)) return;
    const originalId = comment.commentId;
    const index = comments.indexOf(comment);
    if (index >= 0) comments.splice(index, 1);
    if (comment.marker) comment.marker.remove();
    if (comment.tooltip) comment.tooltip.remove();
    if (activeComment === comment) removeComposer();
    post('comment-removed', {
      commentId: originalId,
      pageUrl: window.location.href || document.URL || 'about:blank',
    });
    const renumberedComments = [];
    comments.forEach((c, i) => {
      const newId = i + 1;
      if (c.commentId !== newId) {
        renumberedComments.push({ oldId: c.commentId, newId });
        c.commentId = newId;
      }
      if (c.marker) {
        c.marker.textContent = String(c.commentId);
        c.marker.setAttribute('aria-label', 'Browser comment ' + c.commentId);
        c.marker.setAttribute('data-comment-anchor-context', 'comment-' + c.commentId);
        positionMarker(c);
      }
    });
    commentSeq = comments.length;
    if (renumberedComments.length > 0) {
      post('comments-renumbered', {
        pageUrl: window.location.href || document.URL || 'about:blank',
        comments: renumberedComments,
      });
    }
  };

  const clearComments = () => {
    removeComposer();
    hovered = null;
    activeElement = null;
    activeRect = null;
    updateBox(hoverBox, null);
    updateActiveBox();
    if (dragBox) dragBox.style.display = 'none';
    for (const comment of comments.splice(0)) {
      if (comment.marker) comment.marker.remove();
      if (comment.tooltip) comment.tooltip.remove();
    }
    commentSeq = 0;
  };

  const positionComposer = () => {
    if (!composer) return;
    const rect = activeElement
      ? rectFromDomRect(activeElement.getBoundingClientRect())
      : normalizeRect(activeRect);
    if (!rect) return;
    if (activeElement && !document.documentElement.contains(activeElement)) return;
    const width = Math.min(
      composerSpec.width.max,
      Math.max(composerSpec.width.min, window.innerWidth - composerSpec.width.viewportInset * 2),
    );
    const left = clamp(
      rect.x + rect.width / 2 - width / 2,
      composerSpec.width.viewportInset,
      Math.max(
        composerSpec.width.viewportInset,
        window.innerWidth - width - composerSpec.width.viewportInset,
      ),
    );
    const composerHeight = composer.getBoundingClientRect().height || composerSpec.create.height;
    let top = rect.y + rect.height + composerSpec.placement.anchorGap;
    if (top + composerHeight > window.innerHeight - composerSpec.width.viewportInset) {
      top = rect.y - composerHeight - composerSpec.placement.anchorGap;
    }
    composer.style.left = left + 'px';
    composer.style.top =
      clamp(
        top,
        composerSpec.width.viewportInset,
        Math.max(
          composerSpec.width.viewportInset,
          window.innerHeight - composerHeight - composerSpec.width.viewportInset,
        ),
      ) + 'px';
    composer.style.width = width + 'px';
  };

  function openComposer(target, existingComment) {
    const rectTarget = target && target.selectionMode === 'free_rect' ? normalizeRect(target.rect) : null;
    const element = rectTarget ? null : target;
    if (!rectTarget && (!element || !document.documentElement.contains(element))) return;
    const selectionKind = rectTarget ? 'free_rect' : 'dom_node';
    diagnose('composer-mount-attempt', {
      ...composerMountDetails('starting'),
      selectionKind,
      existingComment: Boolean(existingComment),
    });
    try {
    removeComposer();
    activeElement = element;
    activeRect = rectTarget;
    activeComment = existingComment || null;
    ensureBox('selected');
    updateActiveBox();

    ensureComposerStyle();
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-mavis-embedded-comment-ui', 'true');
    wrapper.setAttribute('data-mavis-embedded-comment-composer', 'true');
    wrapper.setAttribute('data-mavis-theme', themeMode);
    const composerMode = existingComment ? 'edit' : 'create';
    const anchorContext = {
      surface: 'embedded-browser',
      contextId: existingComment
        ? 'comment-' + existingComment.commentId
        : 'pending-' + String(composerGeneration + 1),
      selectionKind: rectTarget ? 'free-rect' : 'dom-node',
    };
    wrapper.setAttribute('data-mavis-comment-mode', composerMode);
    wrapper.setAttribute('data-mavis-comment-context-id', anchorContext.contextId);
    wrapper.setAttribute('data-mavis-comment-selection-kind', anchorContext.selectionKind);
    applyComposerPalette(wrapper);
    wrapper.style.position = 'fixed';
    wrapper.style.zIndex = '2147483647';
    wrapper.style.boxSizing = 'border-box';
    // A floor rather than a fixed size: the box grows with its comment, and
    // updateComposerLayout keeps the floor in step with the current mode.
    wrapper.style.minHeight = composerSpec.create.height + 'px';
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = composerSpec.create.gap + 'px';
    wrapper.style.border =
      composerSpec.wrapper.borderWidth + 'px solid var(--mavis-comment-border, transparent)';
    wrapper.style.borderRadius = composerSpec.wrapper.borderRadius + 'px';
    wrapper.style.background = 'var(--mavis-comment-surface, Canvas)';
    wrapper.style.boxShadow =
      '0 0 ' + composerSpec.wrapper.shadowBlur + 'px var(--mavis-comment-shadow, transparent)';
    wrapper.style.padding =
      composerSpec.wrapper.padding.top + 'px ' +
      composerSpec.wrapper.padding.right + 'px ' +
      composerSpec.wrapper.padding.bottom + 'px ' +
      composerSpec.wrapper.padding.left + 'px';
    wrapper.style.pointerEvents = 'auto';

    const inputRow = document.createElement('div');
    inputRow.style.display = 'flex';
    inputRow.style.minWidth = '0';
    inputRow.style.flex = '1 1 auto';
    inputRow.style.alignItems = 'center';

    const input = document.createElement('textarea');
    input.setAttribute('data-mavis-embedded-comment-input', 'true');
    input.value = existingComment ? existingComment.feedback : '';
    input.placeholder = placeholderText;
    input.rows = 1;
    input.style.minWidth = '0';
    input.style.flex = '1 1 auto';
    input.style.width = '100%';
    input.style.height = composerSpec.create.inputHeight + 'px';
    // Ceiling for the auto-grow: past it the input scrolls and the box stops
    // growing. Expressed in whole lines so a grown box never ends mid-line.
    input.style.maxHeight =
      composerSpec.input.lineHeight * composerSpec.input.maxLines + 'px';
    input.style.boxSizing = 'border-box';
    input.style.border = '0';
    input.style.outline = String(composerSpec.input.focusOutline);
    input.style.margin = '0';
    input.style.padding = '0';
    input.style.background = 'transparent';
    input.style.color = 'var(--mavis-comment-text, CanvasText)';
    input.style.caretColor = 'var(--mavis-comment-caret, Highlight)';
    input.style.font =
      composerSpec.input.fontWeight + ' ' +
      composerSpec.input.fontSize + 'px/' +
      composerSpec.input.lineHeight + 'px ' +
      composerSpec.input.fontFamily;
    input.style.resize = 'none';
    input.style.overflow = 'hidden';
    let composing = false;

    const submit = document.createElement('button');
    submit.type = 'button';
    mountComposerIcon(submit, composerIcons.confirm, composerSpec.actionButton.iconSize);
    submit.style.width = composerSpec.actionButton.size + 'px';
    submit.style.height = composerSpec.actionButton.size + 'px';
    submit.style.flex = '0 0 ' + composerSpec.actionButton.size + 'px';
    submit.style.display = 'inline-flex';
    submit.style.alignItems = 'center';
    submit.style.justifyContent = 'center';
    submit.style.border = '0';
    submit.style.borderRadius = composerSpec.actionButton.borderRadius + 'px';
    submit.style.padding = '0';
    submit.style.background = 'var(--mavis-comment-primary-inactive, GrayText)';
    submit.style.color = 'var(--mavis-comment-primary-icon, Canvas)';
    submit.style.cursor = composerSpec.actionButton.disabledCursor;
    submit.style.transition = composerSpec.actionButton.transition;
    submit.addEventListener('mouseenter', () => {
      if (!submit.disabled) {
        submit.style.background = 'var(--mavis-comment-primary-hover, CanvasText)';
      }
    });
    submit.addEventListener('mouseleave', () => {
      submit.style.background = submit.disabled
        ? 'var(--mavis-comment-primary-inactive, GrayText)'
        : 'var(--mavis-comment-primary-bg, CanvasText)';
    });

    const close = document.createElement('button');
    close.type = 'button';
    mountComposerIcon(close, composerIcons.close, composerSpec.actionButton.iconSize);
    close.setAttribute('aria-label', 'Cancel comment');
    close.style.width = composerSpec.actionButton.size + 'px';
    close.style.height = composerSpec.actionButton.size + 'px';
    close.style.display = 'inline-flex';
    close.style.alignItems = 'center';
    close.style.justifyContent = 'center';
    close.style.border = '0';
    close.style.borderRadius = composerSpec.actionButton.borderRadius + 'px';
    close.style.padding = '0';
    close.style.background = 'var(--mavis-comment-secondary-bg, transparent)';
    close.style.color = 'var(--mavis-comment-secondary-icon, CanvasText)';
    close.style.cursor = composerSpec.actionButton.enabledCursor;
    close.style.transition = composerSpec.actionButton.transition;
    close.addEventListener('mouseenter', () => {
      close.style.background = 'var(--mavis-comment-secondary-hover, ButtonFace)';
    });
    close.addEventListener('mouseleave', () => {
      close.style.background = 'var(--mavis-comment-secondary-bg, transparent)';
    });

    const del = document.createElement('button');
    del.type = 'button';
    mountComposerIcon(del, composerIcons.delete, composerSpec.deleteButton.iconSize);
    del.setAttribute('aria-label', existingComment ? 'Delete comment' : 'Discard comment');
    del.style.width = composerSpec.deleteButton.size + 'px';
    del.style.height = composerSpec.deleteButton.size + 'px';
    del.style.display = 'inline-flex';
    del.style.alignItems = 'center';
    del.style.justifyContent = 'center';
    del.style.border = '0';
    del.style.padding = '0';
    del.style.background = 'transparent';
    del.style.color = 'var(--mavis-comment-tertiary-icon, GrayText)';
    del.style.cursor = composerSpec.actionButton.enabledCursor;
    del.style.transition = composerSpec.deleteButton.transition;
    del.addEventListener('mouseenter', () => {
      del.style.color = 'var(--mavis-comment-tertiary-hover, CanvasText)';
    });
    del.addEventListener('mouseleave', () => {
      del.style.color = 'var(--mavis-comment-tertiary-icon, GrayText)';
    });

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.alignItems = 'center';
    actions.style.gap = composerSpec.edit.actionsGap + 'px';

    const footer = document.createElement('div');
    footer.style.width = '100%';
    footer.style.height = composerSpec.edit.footerHeight + 'px';
    footer.style.display = 'none';
    footer.style.alignItems = 'center';
    footer.style.justifyContent = 'space-between';
    footer.appendChild(del);
    footer.appendChild(actions);

    inputRow.appendChild(input);
    wrapper.appendChild(inputRow);
    wrapper.appendChild(footer);

    /**
     * Sticky once the new comment has wrapped, mirroring the chat composer.
     * Recomputing it from the live height would oscillate: stacking hands the
     * input the full width, which can pull the text back onto one line, which
     * would unstack it again. Only an emptied box resets it, so the layout
     * never changes under a comment the user is still writing.
     */
    let draftHasWrapped = false;

    const applyComposerChrome = () => {
      const hasValue = input.value.trim().length > 0;
      const isEditingExistingComment = Boolean(existingComment);
      // create opens as one row and stacks the moment the comment needs a
      // second line; edit is stacked from the start.
      const stacked = isEditingExistingComment || draftHasWrapped;
      const layout = isEditingExistingComment ? composerSpec.edit : composerSpec.create;
      submit.disabled = composerSpec.behavior.disableEmptySubmit && !hasValue;
      submit.setAttribute('aria-label', hasValue ? 'Submit comment' : 'Submit comment unavailable');
      submit.style.background = hasValue
        ? 'var(--mavis-comment-primary-bg, CanvasText)'
        : 'var(--mavis-comment-primary-inactive, GrayText)';
      submit.style.cursor = hasValue
        ? composerSpec.actionButton.enabledCursor
        : composerSpec.actionButton.disabledCursor;

      // Heights are floors rather than fixed sizes, so the box can follow its
      // comment; the edit box still opens at exactly its specced size.
      wrapper.style.minHeight = layout.height + 'px';
      wrapper.style.flexDirection = stacked ? 'column' : 'row';
      wrapper.style.alignItems = stacked ? 'stretch' : 'center';
      wrapper.style.gap = (stacked ? composerSpec.edit.gap : layout.gap) + 'px';
      // Stacked layouts run text to both edges and line the actions up across
      // one row, so they take a symmetric inset; the single row keeps the
      // specced asymmetry, where the filled submit button supplies its own
      // optical margin.
      wrapper.style.padding = stacked
        ? composerSpec.wrapper.padding.top + 'px ' +
          composerSpec.wrapper.stackedPaddingX + 'px ' +
          composerSpec.wrapper.padding.bottom + 'px ' +
          composerSpec.wrapper.stackedPaddingX + 'px'
        : composerSpec.wrapper.padding.top + 'px ' +
          composerSpec.wrapper.padding.right + 'px ' +
          composerSpec.wrapper.padding.bottom + 'px ' +
          composerSpec.wrapper.padding.left + 'px';

      inputRow.style.width = stacked ? '100%' : 'auto';
      inputRow.style.minHeight = layout.inputRowHeight + 'px';
      inputRow.style.height = 'auto';
      inputRow.style.flex = stacked ? '0 0 auto' : '1 1 auto';
      // flex-start plus symmetric padding reproduces the collapsed centring
      // without shifting the first line up once a second line appears.
      inputRow.style.alignItems = 'flex-start';
      inputRow.style.padding =
        (stacked ? composerSpec.edit.inputRowPaddingY : composerSpec.create.inputRowPaddingY) +
        'px 0';
      inputRow.style.boxSizing = 'border-box';

      // Both modes wrap: text must never run off to the side, because the box
      // has nowhere to scroll horizontally. anywhere covers the case
      // pre-wrap alone does not — one unbroken run such as a pasted URL.
      input.style.whiteSpace = 'pre-wrap';
      input.style.overflowWrap = 'anywhere';
      input.style.overflowX = 'hidden';
      // Starting height for this layout; the auto-grow pass takes it over from
      // here and is what the box actually ends up at.
      input.style.height = layout.inputHeight + 'px';
      // Baseline scrollability, likewise overwritten by the auto-grow pass with
      // whatever the text actually needs. It carries the case where that pass
      // cannot measure at all: an edit box opens on a stored comment that may
      // already be taller than the field, so it has to stay scrollable.
      input.style.overflowY = isEditingExistingComment ? 'auto' : 'hidden';

      if (stacked) {
        footer.style.display = 'flex';
        if (isEditingExistingComment) {
          // Editing can be cancelled back to the stored comment, so it keeps
          // cancel beside submit.
          actions.appendChild(close);
        } else if (close.parentNode) {
          // A new comment has nothing to roll back to; the discard slot on the
          // left already covers throwing the quote away.
          close.parentNode.removeChild(close);
        }
        actions.appendChild(submit);
      } else {
        footer.style.display = 'none';
        wrapper.appendChild(submit);
      }
    };

    /**
     * Size the input to its text. Measured rather than derived from the
     * character count: wrapping depends on the resolved font, the live box
     * width and the host page's own styles, none of which are known here.
     *
     * Returns whether the new comment just crossed onto a second line, which
     * is the only thing that changes the layout.
     */
    const applyInputAutoGrow = () => {
      const isEditingExistingComment = Boolean(existingComment);
      const computed = window.getComputedStyle(input);
      const parsedLineHeight = parseFloat(computed.lineHeight);
      const lineHeight =
        isFinite(parsedLineHeight) && parsedLineHeight > 0
          ? parsedLineHeight
          : composerSpec.input.lineHeight;
      // Each box keeps the size it opens at as its floor — one line for a new
      // comment, the specced taller field for one being edited — while both
      // share the ceiling.
      const minHeight = isEditingExistingComment ? composerSpec.edit.inputHeight : lineHeight;
      const parsedMaxHeight = parseFloat(computed.maxHeight);
      const maxHeight =
        isFinite(parsedMaxHeight) && parsedMaxHeight > 0
          ? parsedMaxHeight
          : lineHeight * composerSpec.input.maxLines;

      // Collapse before measuring so deleting text shrinks the box too, and
      // hide the scrollbar so a visible one can't narrow the measured line and
      // inflate scrollHeight.
      const previousHeight = input.style.height;
      const previousOverflowY = input.style.overflowY;
      input.style.overflowY = 'hidden';
      input.style.height = '0px';
      const contentHeight = input.scrollHeight;
      if (contentHeight <= 0) {
        // No layout yet, or the box is display:none. Put back everything the
        // probe touched — leaving overflow-y hidden would strand the edit box,
        // which is scrollable from the start, without its scrollbar.
        input.style.height = previousHeight;
        input.style.overflowY = previousOverflowY;
        return false;
      }
      const next = resolveCommentInputAutoGrow({ contentHeight, minHeight, maxHeight });
      input.style.height = next.height + 'px';
      input.style.overflowY = next.overflowY;
      // Only a new comment has a layout to switch — the edit box is stacked
      // from the start.
      if (isEditingExistingComment || draftHasWrapped || !next.wrapped) return false;
      draftHasWrapped = true;
      return true;
    };

    const updateComposerLayout = () => {
      // Emptying the box returns it to the single opening line.
      if (input.value.length === 0) draftHasWrapped = false;
      applyComposerChrome();
      // Stacking changes the input's width, so the text has to be re-measured
      // against the layout it actually ends up in. This settles in one extra
      // pass: draftHasWrapped only ever flips to true here.
      if (applyInputAutoGrow()) {
        applyComposerChrome();
        applyInputAutoGrow();
      }
      positionComposer();
    };

    const commit = (event) => {
      if (!isTrustedUserEvent(event)) return;
      const feedback = composerSpec.behavior.trimOnSubmit ? input.value.trim() : input.value;
      if (!feedback) return;
      const targetRect = rectTarget || (element ? rectFromDomRect(element.getBoundingClientRect()) : null);
      if (!targetRect) {
        removeComposer();
        return;
      }
      const targetPayload = rectTarget ? payloadForRect(targetRect) : payloadFor(element);
      let comment = existingComment;
      if (!comment) {
        const nextId = comments.reduce((max, item) => Math.max(max, item.commentId), 0) + 1;
        commentSeq = nextId;
        comment = {
          commentId: nextId,
          element,
          rect: targetRect,
          documentRect: rectTarget ? toDocumentRect(targetRect) : null,
          selectionMode: targetPayload.selectionMode,
          feedback,
          marker: null,
        };
        comment.marker = createMarker(comment);
        comments.push(comment);
      } else {
        comment.feedback = feedback;
        comment.element = element;
        comment.rect = targetRect;
        comment.documentRect = rectTarget ? toDocumentRect(targetRect) : null;
        comment.selectionMode = targetPayload.selectionMode;
      }
      positionMarker(comment);
      const payload = {
        ...targetPayload,
        commentId: comment.commentId,
        feedback,
        screenshotFileName: 'browser-comment-' + comment.commentId + '.png',
      };
      removeComposer();
      post('comment-added', payload);
    };

    submit.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      commit(event);
    });
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeComposer();
    });
    del.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (existingComment) removeComment(existingComment, event);
      else removeComposer();
    });
    input.addEventListener('keydown', (event) => {
      diagnose('input-event', {
        ...inputEventDiagnostic(event, composing),
        keyKind: keyKind(event),
      });
      event.stopPropagation();
      if (event.isComposing || composing || event.keyCode === 229) return;
      const shouldSubmitOnEnter =
        composerMode === 'create'
          ? composerSpec.behavior.createEnterSubmitsWithShift
          : !(event.shiftKey && composerSpec.behavior.editShiftEnterCreatesNewline);
      if (event.key === 'Enter' && shouldSubmitOnEnter) {
        event.preventDefault();
        commit(event);
      }
      if (event.key === 'Escape' && composerSpec.behavior.escapeCancels) {
        event.preventDefault();
        removeComposer();
      }
    });
    ['keyup', 'keypress', 'paste', 'copy', 'cut'].forEach((type) => {
      input.addEventListener(type, (event) => {
        diagnose('input-event', {
          ...inputEventDiagnostic(event, composing),
          ...(event instanceof KeyboardEvent ? { keyKind: keyKind(event) } : {}),
        });
        event.stopPropagation();
      });
    });
    ['beforeinput', 'input'].forEach((type) => {
      input.addEventListener(type, (event) => {
        diagnose('input-event', inputEventDiagnostic(event, composing));
        event.stopPropagation();
        if (type === 'input') updateComposerLayout();
      });
    });
    input.addEventListener('compositionstart', (event) => {
      composing = true;
      diagnose('input-event', inputEventDiagnostic(event, composing));
      event.stopPropagation();
    });
    input.addEventListener('compositionupdate', (event) => {
      diagnose('input-event', inputEventDiagnostic(event, composing));
      event.stopPropagation();
    });
    input.addEventListener('compositionend', (event) => {
      composing = false;
      diagnose('input-event', inputEventDiagnostic(event, composing));
      event.stopPropagation();
      updateComposerLayout();
    });
    input.addEventListener('focus', () => {
      clearHover();
      setInteractionState('composing', 'composer-focused');
      diagnose('composer-focus', { valueLength: input.value.length });
    });
    updateComposerLayout();
    mountBridgeUi(wrapper);
    composer = wrapper;
    composerInput = input;
    composerRelayout = updateComposerLayout;
    // The pass above ran while the box was still detached, where scrollHeight
    // reads 0 and the measurement is skipped. A stored comment can already be
    // taller than the field it opens in, so measure again now that the box is
    // in the document at its real width — otherwise a long comment opens
    // clipped and stays that way until the next keystroke or resize.
    updateComposerLayout();
    clearHover();
    setInteractionState('composing', 'composer-opened');
    const generation = ++composerGeneration;
    diagnose('composer-open', {
      selectionKind,
      existingComment: Boolean(existingComment),
    });
    positionComposer();
    diagnose('composer-mounted', {
      ...composerMountDetails('mounted', wrapper, input),
      selectionKind,
      existingComment: Boolean(existingComment),
    });
    wrapper.addEventListener('focusout', (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && wrapper.contains(next)) return;
      diagnose('composer-focusout', {
        relatedTag:
          next && next.tagName && typeof next.tagName === 'string'
            ? next.tagName.toLowerCase()
            : null,
        relatedIsBridgeUi: isBridgeUi(next),
      });
      setInteractionState(enabled ? 'idle' : 'disabled', 'composer-focus-left');
    });
    if (composerSpec.behavior.focusOnOpen) {
      focusComposerInput(generation, 'composer-open');
      window.requestAnimationFrame(() => {
        diagnose('composer-presence', {
          ...composerMountDetails('animation-frame', wrapper, input),
          selectionKind,
        });
        focusComposerInput(generation, 'composer-open-frame');
      });
    }
    } catch (error) {
      diagnose('composer-mount-failed', {
        ...composerMountDetails('exception'),
        selectionKind,
        existingComment: Boolean(existingComment),
        errorName: error && error.name ? String(error.name).slice(0, 80) : null,
        errorMessage:
          error && error.message
            ? String(error.message).slice(0, 160)
            : String(error || 'unknown').slice(0, 160),
      });
    }
  }

  const refresh = () => {
    if (canInspectPage()) updateBox(hoverBox, hovered);
    else updateBox(hoverBox, null);
    updateActiveBox();
    comments.forEach(positionMarker);
    positionComposer();
  };

  /**
   * Resize-only companion to refresh. The composer's width is derived from
   * the viewport, and width decides where the comment wraps, so a resize can
   * change how many lines it needs. Scrolling cannot, which is why the
   * re-measure is not folded into refresh — it runs on every scroll event
   * and the measurement forces a layout.
   */
  const relayoutComposerForViewport = () => {
    if (composerRelayout) composerRelayout();
  };

  const handlePointerDown = (event) => {
    if (!isTrustedUserEvent(event)) return;
    if (!enabled || event.button !== 0 || event.isPrimary === false) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element) || isBridgeUi(target)) return;
    if (composer && interactionState === 'composing') {
      event.preventDefault();
      event.stopPropagation();
      suppressedClick = {
        target,
        expiresAt: performance.now() + 500,
      };
      setInteractionState('idle', 'composer-page-pointer');
      clearHover();
      try {
        composerInput?.blur();
      } catch (_) {
        // The state transition still releases page inspection when blur is unavailable.
      }
      diagnose('composer-deactivated', {
        targetTag: target.tagName ? target.tagName.toLowerCase() : null,
      });
      return;
    }
    if (selectionMode !== 'free_rect') return;
    event.preventDefault();
    event.stopPropagation();
    if (pointerGesture) return;
    clearHover();
    pointerGesture = {
      pointerId: pointerIdFor(event),
      start: { x: event.clientX, y: event.clientY },
      target,
      dragging: false,
    };
    setInteractionState('pointer_pending', 'pointer-down');
    diagnose('pointer-pending', {
      targetTag: target.tagName ? target.tagName.toLowerCase() : null,
    });
    try {
      if (typeof target.setPointerCapture === 'function' && typeof event.pointerId === 'number') {
        target.setPointerCapture(event.pointerId);
      }
    } catch (_) {
      // Pointer capture is optional; document-level listeners still receive the drag.
    }
  };

  const handlePointerMove = (event) => {
    if (!enabled) return;
    if (interactionState === 'composing') {
      clearHover();
      return;
    }
    if (selectionMode === 'free_rect' && pointerGesture) {
      if (!matchesPointerGesture(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const nextRect = selectionRectFromPoints(pointerGesture.start, {
        x: event.clientX,
        y: event.clientY,
      });
      if (!nextRect) return;
      if (!pointerGesture.dragging) {
        const distance = Math.hypot(
          event.clientX - pointerGesture.start.x,
          event.clientY - pointerGesture.start.y,
        );
        if (distance < freeRectActivationDistance) return;
        pointerGesture.dragging = true;
        setInteractionState('dragging_rect', 'pointer-distance-threshold');
        diagnose('pointer-drag-activated', {
          distance: round(distance),
          width: nextRect.width,
          height: nextRect.height,
        });
        clearHover();
        try {
          window.getSelection()?.removeAllRanges();
        } catch (_) {
          // Clearing a host text selection is best-effort.
        }
      }
      updateBoxRect(ensureDragBox(), nextRect);
      return;
    }
    if (!canInspectPage()) {
      clearHover();
      return;
    }
    const target = event.target;
    if (!(target instanceof Element) || isBridgeUi(target)) {
      clearHover();
      return;
    }
    hovered = target;
    updateBox(ensureBox('hover'), hovered);
  };
  const handlePointerLeave = () => {
    if (pointerGesture) return;
    clearHover();
  };
  const finishRectSelection = (event) => {
    if (!isTrustedUserEvent(event)) return;
    if (!enabled || selectionMode !== 'free_rect' || !pointerGesture) return;
    if (!matchesPointerGesture(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const gesture = pointerGesture;
    const nextRect = selectionRectFromPoints(gesture.start, {
      x: event.clientX,
      y: event.clientY,
    });
    pointerGesture = null;
    if (dragBox) dragBox.style.display = 'none';
    const eventTarget =
      event.target instanceof Element && !isBridgeUi(event.target) ? event.target : gesture.target;
    suppressedClick = {
      target: eventTarget,
      expiresAt: performance.now() + 500,
    };
    diagnose('pointer-finished', {
      dragged: Boolean(gesture.dragging),
      width: nextRect ? nextRect.width : null,
      height: nextRect ? nextRect.height : null,
    });
    if (!gesture.dragging || !nextRect) {
      const existing = comments.find((item) => item.element === eventTarget);
      openComposer(eventTarget, existing || null);
      return;
    }
    openComposer({ selectionMode: 'free_rect', rect: nextRect }, null);
  };
  const cancelRectSelection = (event) => {
    if (event && pointerGesture && !matchesPointerGesture(event)) return;
    pointerGesture = null;
    if (dragBox) dragBox.style.display = 'none';
    setInteractionState(
      enabled ? (composerHasFocus() ? 'composing' : 'idle') : 'disabled',
      'pointer-cancelled',
    );
    const generation = composerGeneration;
    window.setTimeout(() => focusComposerInput(generation, 'pointer-cancel-recovery'), 0);
  };
  const handleClick = (event) => {
    if (!isTrustedUserEvent(event)) return;
    if (!enabled) return;
    if (suppressedClick) {
      const suppression = suppressedClick;
      suppressedClick = null;
      if (performance.now() <= suppression.expiresAt && event.target === suppression.target) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    const target = event.target;
    if (!(target instanceof Element) || isBridgeUi(target)) return;
    if (interactionState === 'composing') {
      event.preventDefault();
      event.stopPropagation();
      clearHover();
      return;
    }
    if (interactionState !== 'idle') return;
    pointerGesture = null;
    event.preventDefault();
    event.stopPropagation();
    const existing = comments.find((item) => item.element === target);
    openComposer(target, existing || null);
  };
  const setEnabled = (nextEnabled) => {
    enabled = Boolean(nextEnabled);
    setInteractionState(
      enabled ? (composerHasFocus() ? 'composing' : 'idle') : 'disabled',
      enabled ? 'mode-enabled' : 'mode-disabled',
    );
    document.documentElement.style.cursor = enabled ? 'crosshair' : '';
    if (enabled) {
      document.addEventListener('pointerdown', handlePointerDown, true);
      document.addEventListener('pointermove', handlePointerMove, true);
      document.addEventListener('pointerup', finishRectSelection, true);
      document.addEventListener('pointercancel', cancelRectSelection, true);
      document.addEventListener('pointerleave', handlePointerLeave, true);
      document.addEventListener('click', handleClick, true);
    } else {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('pointermove', handlePointerMove, true);
      document.removeEventListener('pointerup', finishRectSelection, true);
      document.removeEventListener('pointercancel', cancelRectSelection, true);
      document.removeEventListener('pointerleave', handlePointerLeave, true);
      document.removeEventListener('click', handleClick, true);
      cancelRectSelection();
      hovered = null;
      updateBox(hoverBox, null);
      removeComposer();
    }
    comments.forEach(positionMarker);
    diagnose('mode-updated', { enabled, interactionState });
    post('ready', { enabled, selectionMode, bridgeVersion });
  };

  const destroyForTests = () => {
    if (!allowSyntheticEventsForTests) return false;
    setEnabled(false);
    if (testMessageHandler) window.removeEventListener('message', testMessageHandler);
    testMessageHandler = null;
    window.removeEventListener('resize', refresh);
    window.removeEventListener('resize', relayoutComposerForViewport);
    document.removeEventListener('scroll', refresh, true);
    if (bridgeUiHost) bridgeUiHost.remove();
    else {
      document
        .querySelectorAll('[data-mavis-embedded-comment-ui="true"]')
        .forEach((element) => element.remove());
    }
    removeBridgeUiEventBoundary();
    window.__mavisEmbeddedBrowserCommentBridgeInstalled = false;
    if (globalThis[controlName] === handleControl) delete globalThis[controlName];
    return true;
  };

  const handleControl = (data) => {
    if (!data || typeof data !== 'object') return false;
    if (data.type === 'destroy') return destroyForTests();
    if (data.type === 'set-enabled') {
      if (typeof data.placeholder === 'string' && data.placeholder) {
        placeholderText = data.placeholder;
      }
      const previousSelectionMode = selectionMode;
      selectionMode = data.selectionMode === 'dom_node' ? 'dom_node' : 'free_rect';
      themeMode =
        data.theme === 'light' || data.theme === 'dark' || data.theme === 'system'
          ? data.theme
          : themeMode;
      if (data.palette && typeof data.palette === 'object') {
        const nextPalette = {};
        const paletteRoles = [...Object.keys(composerCssVariables), ...Object.keys(markerCssVariables)];
        paletteRoles.forEach((role) => {
          const value = data.palette[role];
          if (typeof value === 'string' && value.trim()) nextPalette[role] = value;
        });
        if (Object.keys(composerCssVariables).every((role) => Boolean(nextPalette[role]))) {
          themePalette = nextPalette;
        }
      }
      if (composer) {
        composer.setAttribute('data-mavis-theme', themeMode);
        applyComposerPalette(composer);
      }
      comments.forEach((comment) => applyMarkerPalette(comment.marker));
      // 仅更新主题时保留进行中的选区、草稿和焦点。
      if (enabled !== Boolean(data.enabled) || previousSelectionMode !== selectionMode) {
        setEnabled(data.enabled);
      }
    }
    if (data.type === 'clear-selected') removeComposer();
    if (data.type === 'clear-comments') clearComments();
    return true;
  };
  globalThis[controlName] = handleControl;
  if (allowSyntheticEventsForTests) {
    testMessageHandler = (event) => {
      const data = event.data;
      if (!data || data.source !== source) return;
      handleControl(data);
    };
    window.addEventListener('message', testMessageHandler);
  }
  window.addEventListener('resize', refresh);
  window.addEventListener('resize', relayoutComposerForViewport);
  document.addEventListener('scroll', refresh, true);
  document.addEventListener(
    'focusin',
    (event) => {
      if (!composerInput) return;
      const target = event.target;
      diagnose('document-focusin', {
        targetTag:
          target && target.tagName && typeof target.tagName === 'string'
            ? target.tagName.toLowerCase()
            : null,
        targetIsCommentInput: target === composerInput,
        targetIsBridgeUi: isBridgeUi(target),
      });
    },
    true,
  );
  ['pointerdown', 'pointerup', 'pointercancel', 'click', 'input', 'change'].forEach((type) => {
    document.addEventListener(type, (event) => diagnosePageControlEvent(event, 'capture'), true);
    document.addEventListener(type, (event) => diagnosePageControlEvent(event, 'bubble'), false);
  });
  document.addEventListener(
    'pointermove',
    (event) => diagnosePageControlEvent(event, 'capture'),
    true,
  );
  post('ready', { enabled, selectionMode, bridgeVersion });
  return { installed: true, bridgeVersion };
})();`;
}
export let EMBEDDED_COMMENT_BRIDGE_SCRIPT = buildEmbeddedCommentBridgeScript();
export let EMBEDDED_COMMENT_BRIDGE_TEST_SCRIPT = buildEmbeddedCommentBridgeScript({
    allowSyntheticEventsForTests: true,
    isolateUiInShadowRoot: false,
});
export function normalizeCommentBridgeMessage(value) {
    const parsed = value !== null && typeof value === 'object' ? value : {};
    if (parsed.source !== EMBEDDED_COMMENT_SOURCE)
        return null;
    if (parsed.type !== 'comment-added' &&
        parsed.type !== 'comment-removed' &&
        parsed.type !== 'comments-renumbered' &&
        parsed.type !== 'diagnostic' &&
        parsed.type !== 'ready') {
        return null;
    }
    return {
        type: parsed.type,
        ...(typeof parsed.messageId === 'number' ? { messageId: parsed.messageId } : {}),
        payload: parsed.payload,
    };
}
