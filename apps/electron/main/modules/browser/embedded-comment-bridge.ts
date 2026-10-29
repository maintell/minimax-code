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
    // Same artwork as Mic16Icon in packages/ui/src/assets/icons/misc.tsx.
    mic: {
        viewBox: '0 0 16 16',
        paths: [
            {
                d: 'M8 12.6667V14.6667',
                stroke: 'currentColor',
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round',
            },
            { d: 'M6 14.9111H10', stroke: 'currentColor', 'stroke-linecap': 'round' },
            {
                d: 'M12.6667 6.66667V8.00001C12.6667 9.23768 12.175 10.4247 11.2998 11.2998C10.4247 12.175 9.23769 12.6667 8.00001 12.6667C6.76233 12.6667 5.57535 12.175 4.70018 11.2998C3.82501 10.4247 3.33334 9.23768 3.33334 8.00001V6.66667',
                stroke: 'currentColor',
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round',
            },
            {
                d: 'M10 3.33333C10 2.22876 9.10457 1.33333 8 1.33333C6.89543 1.33333 6 2.22876 6 3.33333V8C6 9.10456 6.89543 10 8 10C9.10457 10 10 9.10456 10 8V3.33333Z',
                stroke: 'currentColor',
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round',
            },
        ],
    },
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
export let EMBEDDED_COMMENT_BRIDGE_VERSION = '2026-10-19-props-iframe-region-glass-v28';
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
  // Stable per-comment key. The mutable commentId is a display number that
  // shifts when a comment is dropped; the key never changes for the lifetime
  // of a comment and is what the host uses to address a comment across
  // renumbering events. Generated once per page load, scoped to this bridge
  // install, and never reused (legacy comments without a key are still
  // addressable by their old id+selector path).
  let keySeq = 0;
  const newCommentKey = () => {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return 'mk-' + crypto.randomUUID();
      }
    } catch (_) {
      // Older sandboxes may not expose crypto.randomUUID; fall through to a
      // monotonic + random token.
    }
    return (
      'mk-' +
      Date.now().toString(36) +
      '-' +
      (++keySeq).toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 10)
    );
  };
  let messageSeq = 0;
  let placeholderText = 'Add comment...';
  let themeMode = 'system';
  let themePalette = null;
  let selectionMode = 'free_rect';
  let interactionState = 'disabled';
  let pointerGesture = null;
  // Escape ends a drag before the button is released; the release and its
  // click still arrive later and must not reopen a DOM selection.
  let cancelledGesture = null;
  let suppressedClick = null;
  let activeComment = null;
  let composerInput = null;
  // Relayout hook for the open composer. The viewport drives the box's width,
  // and width drives wrapping, so a resize has to re-measure the comment.
  let composerRelayout = null;
  let composerGeneration = 0;
  let testMessageHandler = null;
  // Property inspector (optional bundle, see embedded-props-panel.ts).
  let propsStrings = {};
  let propsLocale = 'zh-Hans';
  let propsExpanded = false;
  // Composer width while it carries the inspector. Collapsed and expanded
  // share one width so toggling the property list never shifts the box.
  const propsComposerWidth = { collapsed: 316, expanded: 316 };
  // Scrolling property list: max is the designed height (about five rows, so
  // the panel hides little of the page), min is the least worth avoiding an
  // overlap for, and floor is the hard minimum on a tiny viewport.
  const propsScrollHeight = { max: 360, min: 240, floor: 96 };
  let draft = null;
  let composerPanel = null;
  let composerManualPos = null;
  // A dragged position carried over to a newly picked element is only kept
  // while it does not cover that element.
  let composerManualPosCarried = false;
  // Element outlined while the user points at it in the inspector's path.
  let pathPreview = null;
  let composerApi = null;
  let pageColorCache = null;
  let toastEl = null;
  let toastTimer = 0;
  // element -> original inline values/priorities for properties owned by its preview layers.
  const styleLayers = new Map();
  // Page-local sequence never rewinds when Undo restores a saved comment snapshot.
  let commentRevisionSeq = 0;
  // Comments already sent to the Agent, kept on the page as pending bubbles.
  const sentBubbles = [];
  // Voice input is the chat composer's ASR, driven from the app window: the
  // page only asks for start/stop and receives transcripts (voice-update).
  let voiceState = 'idle';
  let voicePrefix = null;
  let composerVoice = null;
  const comments = [];
  const freeRectActivationDistance = 4;
  const wheelLinePixels = 40;
  let bridgeUiHost = null;
  let bridgeUiRoot = null;
  let bridgeUiEventBoundaryRoot = null;
  // Free-rectangle input surface. Out-of-process iframes receive their own
  // pointer events, so document listeners never see a drag starting there.
  let glass = null;
  // UI events kept from the page. Gesture-end events (mouseup, touchend) are
  // deliberately absent and must still reach the document: slider and color-picker
  // drags (rc-slider, rc-color-picker) listen for mouseup / touchend on the
  // document, so stopping them here left a drag released over the panel
  // stuck to the cursor. The page never sees the matching press or click, so
  // a lone release carries no interaction, and a page drag that ends over the
  // panel is released properly too.
  const bridgeUiPropagationEvents = [
    'pointerdown',
    'pointerup',
    'pointercancel',
    'mousedown',
    'click',
    'dblclick',
    'touchstart',
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
  // Hit testing for input that lands on the glass. Hiding it for one
  // synchronous query exposes the page underneath; an iframe resolves to the
  // iframe element itself because its document belongs to another frame.
  const withGlassHidden = (read) => {
    const surface = glass;
    if (surface) surface.style.pointerEvents = 'none';
    try {
      return read();
    } finally {
      if (surface) surface.style.pointerEvents = 'auto';
    }
  };
  const elementUnderPointer = (x, y) => {
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    if (typeof document.elementFromPoint !== 'function') return null;
    try {
      const hit = withGlassHidden(() => document.elementFromPoint(x, y));
      return hit instanceof Element && !isBridgeUi(hit) ? hit : null;
    } catch (_) {
      return null;
    }
  };
  const pageTargetFor = (event) => {
    const target = event.target;
    return target instanceof Element && !isBridgeUi(target) ? target : null;
  };
  const glassTargetFor = (event) => elementUnderPointer(event.clientX, event.clientY);
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
        ? withGlassHidden(() => document.elementsFromPoint(centerX, centerY))
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
    if (!comment.marker || (!enabled && !comment.sent)) {
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
    // Whole pixels: a fractional left/top blurs the digit and reads off-center.
    comment.marker.style.left =
      Math.round(
        clamp(rect.x - markerWidth / 2, 8, Math.max(8, window.innerWidth - markerWidth - 8)),
      ) + 'px';
    comment.marker.style.top = Math.round(top) + 'px';
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
    if (comment.commentKey) marker.setAttribute('data-comment-key', comment.commentKey);
    marker.textContent = String(comment.commentId);
    marker.style.position = 'fixed';
    marker.style.zIndex = '2147483647';
    marker.style.boxSizing = 'border-box';
    marker.style.appearance = 'none';
    marker.style.width = markerSpec.width;
    marker.style.height = markerSpec.size + 'px';
    marker.style.minWidth = markerSpec.size + 'px';
    // System-font digits carry their visual weight right of the advance box
    // (measured 0.25 to 0.5px), so the label is nudged half a pixel left.
    marker.style.padding =
      '0 ' + (markerSpec.paddingInline + 0.5) + 'px 0 ' + (markerSpec.paddingInline - 0.5) + 'px';
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
    // Fallback only (no props-panel bundle). Mirrors the app tooltip spec:
    // utility_tootip surface, inverted text, 13px, 6/8 padding, 8px radius.
    tooltip.style.maxWidth = '280px';
    tooltip.style.padding = '6px 8px';
    tooltip.style.borderRadius = '8px';
    tooltip.style.background = 'rgba(10,10,10,0.95)';
    tooltip.style.color = 'rgba(255,255,255,0.95)';
    tooltip.style.font = '400 13px/18px ' + markerSpec.fontFamily;
    tooltip.style.boxShadow = 'none';
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
      const tipText = comment.sent
        ? ((comment.sentDone ? propsStrings.done : propsStrings.pending) || '') +
          ' · ' +
          comment.feedback
        : comment.feedback;
      // Prefer the design-system Tooltip rendered by the props-panel bundle;
      // the inline tip below only covers builds without that bundle.
      if (showDesignTip(markerRect, tipText)) return;
      tooltip.textContent = tipText;
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
      hideDesignTip();
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
      hideDesignTip();
      if (comment.sent) return;
      switchComposerTarget(
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

  const propsApi = () => {
    const api = globalThis.__mavisEmbeddedPropsPanel;
    return api && api.version === 1 ? api : null;
  };
  /** Marker hover tip via the design-system Tooltip; false when unavailable. */
  const showDesignTip = (markerRect, text) => {
    const api = propsApi();
    const shadowRoot = ensureBridgeUiRoot();
    if (!api || typeof api.showMarkerTip !== 'function' || !shadowRoot) return false;
    try {
      api.showMarkerTip({
        shadowRoot,
        theme: resolvedTheme(),
        anchor: {
          left: markerRect.left,
          top: markerRect.top,
          width: markerRect.width,
          height: markerRect.height,
        },
        text,
      });
      return true;
    } catch (_) {
      return false;
    }
  };
  const hideDesignTip = () => {
    const api = propsApi();
    const shadowRoot = ensureBridgeUiRoot();
    if (!api || typeof api.hideMarkerTip !== 'function' || !shadowRoot) return;
    try {
      api.hideMarkerTip(shadowRoot);
    } catch (_) {
      // The tip is cosmetic; a failed hide must not break comment removal.
    }
  };
  const fillTemplate = (template, values) => {
    let out = String(template || '');
    Object.keys(values).forEach((key) => {
      out = out.split('{{' + key + '}}').join(String(values[key]));
    });
    return out;
  };
  const changeCount = (changes) => (changes ? Object.keys(changes).length : 0);
  const draftChangeCount = () => {
    const api = propsApi();
    if (!api || !draft) return 0;
    try {
      return changeCount(api.pruneStyleChanges(draft.from, draft.changes));
    } catch (_) {
      return 0;
    }
  };
  const restorePreviewProperties = (element, layer) => {
    layer.properties.forEach((original, property) => {
      if (original.value) element.style.setProperty(property, original.value, original.priority);
      else element.style.removeProperty(property);
    });
    layer.properties.clear();
    if (!layer.hadStyleAttribute && element.style.length === 0) element.removeAttribute('style');
  };
  /** Rebuild only preview-owned properties; unrelated live page styles are never rolled back. */
  const repaintElement = (element) => {
    const api = propsApi();
    if (!api || !element) return;
    const confirmed = comments.filter(
      (c) =>
        c.element === element &&
        changeCount(c.styleChanges) > 0 &&
        !(draft && draft.comment === c),
    );
    const draftChanges =
      draft && draft.element === element && changeCount(draft.changes) > 0 ? draft.changes : null;
    let layer = styleLayers.get(element);
    if (!layer) {
      if (confirmed.length === 0 && !draftChanges) return;
      layer = { properties: new Map(), hadStyleAttribute: element.hasAttribute('style') };
      styleLayers.set(element, layer);
    }
    restorePreviewProperties(element, layer);
    if (confirmed.length === 0 && !draftChanges) {
      styleLayers.delete(element);
      return;
    }
    const captureProperties = (properties) => {
      properties.forEach((property) => {
        if (!layer.properties.has(property)) {
          layer.properties.set(property, {
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property),
          });
        }
      });
    };
    try {
      confirmed.forEach((c) => api.applyStyleChanges(element, c.styleChanges, captureProperties));
      if (draftChanges) api.applyStyleChanges(element, draftChanges, captureProperties);
    } catch (error) {
      diagnose('props-apply-failed', {
        errorMessage: String((error && error.message) || error).slice(0, 160),
      });
    }
  };
  const restoreAllPreviews = () => {
    styleLayers.forEach((layer, element) => restorePreviewProperties(element, layer));
    styleLayers.clear();
  };
  const resolvedTheme = () => {
    if (themeMode === 'light' || themeMode === 'dark') return themeMode;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_) {
      return 'light';
    }
  };
  const ancestorsOf = (element) => {
    const list = [];
    let node = element.parentElement;
    while (node && node !== document.body && node !== document.documentElement && list.length < 6) {
      list.push(node);
      node = node.parentElement;
    }
    return list;
  };
  const pageColors = () => {
    const api = propsApi();
    if (!api) return [];
    const now = Date.now();
    const url = window.location.href;
    if (!pageColorCache || now - pageColorCache.at > 30000 || pageColorCache.url !== url) {
      let colors = [];
      try {
        colors = api.collectPageColors();
      } catch (_) {
        colors = [];
      }
      pageColorCache = { at: now, url, colors };
    }
    return pageColorCache.colors;
  };
  const ensureBridgeStyle = () => {
    const root = ensureBridgeUiRoot();
    if (!root || root.querySelector('#mavis-embedded-comment-bridge-style')) return;
    const style = document.createElement('style');
    style.id = 'mavis-embedded-comment-bridge-style';
    style.textContent =
      '@keyframes mavis-comment-spin{to{transform:rotate(360deg)}}' +
      '@keyframes mavis-voice-pulse{0%,100%{opacity:1}50%{opacity:.45}}' +
      '[data-mavis-sent-state]{transition:background-color .2s,opacity .4s,transform .4s}' +
      // Pending: the marker border itself becomes a single progress ring (light
      // track + rotating accent arc) instead of a dashed border plus an outer arc.
      '[data-mavis-sent-state="pending"]::after{content:"";position:absolute;' +
      'inset:var(--mavis-sent-ring-inset,-2px);border-radius:inherit;padding:2px;' +
      'background:conic-gradient(var(--mavis-comment-marker-background,#0094fc) 0 25%,' +
      'color-mix(in srgb,var(--mavis-comment-marker-background,#0094fc) 18%,transparent) 25% 100%);' +
      '-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);' +
      '-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;' +
      'animation:mavis-comment-spin 1s linear infinite}' +
      '[data-mavis-sent-state="fading"]{opacity:0;transform:scale(.6)}';
    root.appendChild(style);
  };
  const hideToast = () => {
    window.clearTimeout(toastTimer);
    if (toastEl) toastEl.style.display = 'none';
  };
  const showToast = (text, action) => {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('data-mavis-embedded-comment-ui', 'true');
      toastEl.setAttribute('role', 'status');
      const st = toastEl.style;
      st.position = 'fixed';
      st.left = '50%';
      st.top = '14px';
      st.transform = 'translateX(-50%)';
      st.zIndex = '2147483647';
      st.display = 'none';
      st.alignItems = 'center';
      st.gap = '8px';
      st.padding = '8px 14px';
      st.borderRadius = '999px';
      st.background = 'rgba(23,23,23,0.92)';
      st.color = '#ffffff';
      st.font = '400 13px/18px -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif';
      st.boxShadow = '0 6px 24px rgba(0,0,0,0.2)';
      st.whiteSpace = 'nowrap';
      st.pointerEvents = 'auto';
    }
    if (!toastEl.isConnected) mountBridgeUi(toastEl);
    const label = document.createElement('span');
    label.textContent = text;
    toastEl.replaceChildren(label);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.style.border = '0';
      button.style.padding = '0 2px';
      button.style.background = 'transparent';
      button.style.color = '#5cb8ff';
      button.style.font = '600 13px/18px inherit';
      button.style.cursor = 'pointer';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        hideToast();
        action.run(event);
      });
      toastEl.appendChild(button);
    }
    toastEl.style.display = 'flex';
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(hideToast, action ? 5000 : 2600);
  };
  const postComment = (comment, targetPayload) => {
    const api = propsApi();
    const target =
      targetPayload ||
      (comment.selectionMode === 'free_rect'
        ? payloadForRect(getCommentViewportRect(comment) || comment.rect)
        : payloadFor(comment.element));
    let styleChanges = [];
    if (api && comment.styleFrom && changeCount(comment.styleChanges) > 0) {
      try {
        styleChanges = api.buildStyleChangeDiff(comment.styleFrom, comment.styleChanges);
      } catch (_) {
        styleChanges = [];
      }
    }
    comment.commentRevision = ++commentRevisionSeq;
    post('comment-added', {
      ...target,
      commentRevision: comment.commentRevision,
      commentId: comment.commentId,
      ...(comment.commentKey ? { commentKey: comment.commentKey } : {}),
      feedback: comment.feedback,
      screenshotFileName: 'browser-comment-' + comment.commentId + '.png',
      ...(styleChanges.length > 0 ? { styleChanges } : {}),
    });
  };
  const startComposerDrag = (event) => {
    if (!composer || !event) return;
    const rect = composer.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    const move = (moveEvent) => {
      if (!composer) return;
      const box = composer.getBoundingClientRect();
      composerManualPosCarried = false;
      composerManualPos = {
        left: clamp(
          start.left + moveEvent.clientX - start.x,
          8,
          Math.max(8, window.innerWidth - box.width - 8),
        ),
        top: clamp(
          start.top + moveEvent.clientY - start.y,
          8,
          Math.max(8, window.innerHeight - box.height - 8),
        ),
      };
      positionComposer();
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  };
  /**
   * With the property panel the whole composer is a drag surface: any press
   * on blank chrome (padding, element bar, group gaps, footer) moves it, so no
   * grip is needed. Controls, text, menus and the scrollbar keep their own
   * pointer behaviour.
   */
  const composerNoDragSelector = [
    'input',
    'textarea',
    'button',
    'select',
    'a[href]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="slider"]',
    '[role="switch"]',
    '[role="option"]',
    '[role="menuitem"]',
    '[role="radio"]',
    '.ant-slider',
    '.ant-select',
    '.ant-segmented',
    '.ant-switch',
    '.ant-input-affix-wrapper',
    '.ant-color-picker-trigger',
    '[data-mavis-no-drag]',
  ].join(',');
  const isComposerDragSurface = (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return false;
    if (target.closest(composerNoDragSelector)) return false;
    // A press on a scroll container's own scrollbar lands on the container.
    if (
      target.scrollHeight > target.clientHeight &&
      typeof event.offsetX === 'number' &&
      event.offsetX >= target.clientWidth
    ) {
      return false;
    }
    return true;
  };
  const bindComposerDragSurface = (wrapper) => {
    if (!wrapper || wrapper.getAttribute('data-mavis-drag-surface') === 'true') return;
    wrapper.setAttribute('data-mavis-drag-surface', 'true');
    wrapper.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || composer !== wrapper) return;
      if (!isComposerDragSurface(event)) return;
      // Keeps focus in the comment input and stops text selection.
      event.preventDefault();
      startComposerDrag(event);
    });
  };
  /**
   * Moving to another element while a composer is open. Property edits are
   * never dropped: they are saved as a comment first and the toast offers an
   * undo. A draft without property edits just follows the user, keeping the
   * text they typed, because that usually means the first pick was wrong.
   */
  const switchComposerTarget = (target, existing, pathLeaf) => {
    const current = composerApi;
    if (!current) {
      openComposer(target, existing || null, pathLeaf ? { pathLeaf } : undefined);
      return;
    }
    const position = composerManualPos;
    if (current.styleChangeCount() > 0) {
      const snapshot = current.snapshot();
      const saved = current.commitInternal();
      openComposer(target, existing || null, { position, pathLeaf });
      if (!saved) return;
      showToast(
        fillTemplate(propsStrings.autosaved || 'Saved comment {{index}}', {
          index: saved.commentId,
        }),
        {
          label: propsStrings.undo || 'Undo',
          run: (event) => undoAutosave(snapshot, saved, event, position),
        },
      );
      return;
    }
    const carry = !current.existingComment && !existing ? current.feedback() : '';
    openComposer(target, existing || null, { position, feedback: carry, pathLeaf });
  };
  const undoAutosave = (snapshot, saved, event, position) => {
    const current = composerApi;
    // A stale undo must not resurrect a consumed comment or overwrite a reopened edit.
    if (comments.indexOf(saved) < 0 || saved.sent || (current && current.existingComment === saved)) return;
    if (current && current.hasUncommittedChanges()) {
      current.commitInternal(true);
      // An empty existing comment is intentionally removed by commit. A failed
      // save leaves its composer alive: keep the draft instead of undoing A.
      if (composerApi === current) return;
    }
    removeComposer();
    if (snapshot.before) {
      Object.assign(saved, snapshot.before);
      repaintElement(saved.element);
      positionMarker(saved);
      postComment(saved);
      openComposer(saved.element, saved, {
        position,
        feedback: snapshot.feedback,
        changes: snapshot.changes,
      });
      return;
    }
    if (comments.indexOf(saved) >= 0) removeComment(saved, event);
    if (!snapshot.element || !document.documentElement.contains(snapshot.element)) return;
    openComposer(snapshot.element, null, {
      position,
      feedback: snapshot.feedback,
      changes: snapshot.changes,
    });
  };
  const markOneCommentSent = (comment) => {
    if (!comment.marker) return;
    ensureBridgeStyle();
    comment.sent = true;
    const marker = comment.marker;
    marker.setAttribute('data-mavis-sent-state', 'pending');
    marker.style.background = '#ffffff';
    marker.style.color = 'var(--mavis-comment-marker-background, #0094fc)';
    marker.style.borderStyle = 'solid';
    marker.style.borderColor = 'transparent';
    marker.style.setProperty(
      '--mavis-sent-ring-inset',
      '-' + (parseFloat(marker.style.borderWidth) || 0) + 'px',
    );
    marker.style.cursor = 'default';
    marker.setAttribute(
      'aria-label',
      (propsStrings.pending || 'Pending') + ' ' + comment.commentId,
    );
    sentBubbles.push(comment);
  };
  const markCommentsSent = () => {
    comments.forEach(markOneCommentSent);
  };
  const resolveSentBubbles = (status, commentKeys, commentRevisions) => {
    const rawKeys = Array.isArray(commentKeys)
      ? commentKeys.filter((entry) => typeof entry === 'string' && entry)
      : null;
    const selective = rawKeys !== null;
    const keySet = selective ? new Set(rawKeys) : null;
    // Selective mode leaves bubbles whose keys are not listed as still
    // pending; the full-sent splice(0) preserves the legacy "resolve all"
    // behaviour when no keys are provided.
    const targets = [];
    if (selective) {
      for (let i = sentBubbles.length - 1; i >= 0; i--) {
        const bubble = sentBubbles[i];
        if (bubble.commentKey && keySet.has(bubble.commentKey)) {
          const revision = commentRevisions && Object.prototype.hasOwnProperty.call(commentRevisions, bubble.commentKey)
            ? commentRevisions[bubble.commentKey]
            : undefined;
          if (revision !== undefined && (bubble.commentRevision || 0) > revision) continue;
          targets.unshift(bubble);
          sentBubbles.splice(i, 1);
        }
      }
    } else {
      targets.push(...sentBubbles.splice(0));
    }
    targets.forEach((comment) => {
      const marker = comment.marker;
      if (!marker) return;
      const fade = () => {
        marker.setAttribute('data-mavis-sent-state', 'fading');
        window.setTimeout(() => {
          marker.remove();
          if (comment.tooltip) comment.tooltip.remove();
          hideDesignTip();
        }, 450);
      };
      if (status !== 'done') {
        fade();
        return;
      }
      comment.sentDone = true;
      marker.setAttribute('data-mavis-sent-state', 'done');
      marker.style.background = '#16a34a';
      marker.style.borderStyle = 'solid';
      marker.style.borderColor = '#ffffff';
      marker.style.color = '#ffffff';
      marker.textContent = '\u2713';
      marker.setAttribute('aria-label', (propsStrings.done || 'Done') + ' ' + comment.commentId);
      window.setTimeout(fade, 1600);
    });
  };

  const removeComposer = () => {
    composerGeneration += 1;
    if (composerPanel) {
      // A tip opened from the composer's own buttons must not outlive it.
      hideDesignTip();
      const panel = composerPanel;
      composerPanel = null;
      // Defer: this can run inside one of the panel's own event handlers.
      window.setTimeout(() => {
        try {
          panel.unmount();
        } catch (_) {
          // The wrapper is already detached; nothing left to clean up.
        }
      }, 0);
    }
    if (voiceState !== 'idle') post('voice-request', { action: 'cancel' });
    voiceState = 'idle';
    voicePrefix = null;
    composerVoice = null;
    const draftElement = draft ? draft.element : null;
    draft = null;
    composerApi = null;
    composerManualPos = null;
    composerManualPosCarried = false;
    pathPreview = null;
    if (draftElement) repaintElement(draftElement);
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
    dropComment(comment);
  };

  /**
   * The chat composer removed one comment: roll back only its preview.
   *
   * Strict-key contract: when the host supplies a commentKey field — even
   * if it is empty or a non-matching value — we match strictly by key, with
   * no fallback to the mutable commentId. A stale id from before a
   * renumber must never drop a different comment. The legacy id+selector
   * path is reserved for hosts that did not include the field at all.
   */
  const removeCommentFromHost = (data) => {
    const pageUrl = window.location.href || document.URL || 'about:blank';
    if (typeof data.pageUrl === 'string' && data.pageUrl && data.pageUrl !== pageUrl) return;
    const selectorOf = (comment) => (comment.element ? selectorFor(comment.element) : '');
    if ('commentKey' in data) {
      const key = typeof data.commentKey === 'string' ? data.commentKey : '';
      if (key) {
        const keyMatch = comments.find(
          (comment) => !comment.sent && comment.commentKey === key,
        );
        if (keyMatch) dropComment(keyMatch);
      }
      return;
    }
    const id = Number(data.commentId);
    const wanted = typeof data.selector === 'string' ? data.selector : '';
    const match =
      comments.find(
        (comment) =>
          !comment.sent &&
          comment.commentId === id &&
          (!wanted || !comment.element || selectorOf(comment) === wanted),
      ) ||
      (wanted
        ? comments.find(
            (comment) => !comment.sent && comment.element && selectorOf(comment) === wanted,
          )
        : null);
    if (match) dropComment(match);
  };

  const dropComment = (comment) => {
    const originalId = comment.commentId;
    const originalKey = comment.commentKey;
    const index = comments.indexOf(comment);
    if (index >= 0) comments.splice(index, 1);
    if (comment.marker) comment.marker.remove();
    if (comment.tooltip) comment.tooltip.remove();
    hideDesignTip();
    if (activeComment === comment) removeComposer();
    repaintElement(comment.element);
    post('comment-removed', {
      commentId: originalId,
      ...(originalKey ? { commentKey: originalKey } : {}),
      pageUrl: window.location.href || document.URL || 'about:blank',
    });
    const renumberedComments = [];
    comments.forEach((c, i) => {
      const newId = i + 1;
      if (c.commentId !== newId) {
        renumberedComments.push({
          oldId: c.commentId,
          newId,
          ...(c.commentKey ? { commentKey: c.commentKey } : {}),
        });
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

  const clearComments = (sent, commentKeys, commentRevisions) => {
    const selective = Array.isArray(commentKeys);
    if (selective && commentKeys.length === 0) return;
    // Sending hands the edits to the Agent: the page goes back to its real
    // state, and (when sent) the markers stay behind as pending bubbles.
    if (!selective) {
      removeComposer();
      hideToast();
      restoreAllPreviews();
      if (sent) markCommentsSent();
      hovered = null;
      activeElement = null;
      activeRect = null;
      updateBox(hoverBox, null);
      updateActiveBox();
      if (dragBox) dragBox.style.display = 'none';
      for (const comment of comments.splice(0)) {
        if (comment.sent) continue;
        if (comment.marker) comment.marker.remove();
        if (comment.tooltip) comment.tooltip.remove();
      }
      hideDesignTip();
      commentSeq = 0;
      sentBubbles.forEach(positionMarker);
      return;
    }
    // Selective clears remove only this batch's layers. Repaint after removal
    // so other saved comments and the open, unrelated draft remain visible.
    const keySet = new Set(commentKeys);
    const affectedElements = new Set();
    for (let i = comments.length - 1; i >= 0; i--) {
      const comment = comments[i];
      if (!comment.commentKey || !keySet.has(comment.commentKey)) continue;
      const revision = commentRevisions && Object.prototype.hasOwnProperty.call(commentRevisions, comment.commentKey)
        ? commentRevisions[comment.commentKey]
        : undefined;
      // The send owns its frozen revision, not a newer save made while it was admitted.
      if (revision !== undefined && (comment.commentRevision || 0) > revision) continue;
      comments.splice(i, 1);
      affectedElements.add(comment.element);
      if (activeComment === comment) removeComposer();
      if (sent) {
        markOneCommentSent(comment);
      } else {
        if (comment.marker) comment.marker.remove();
        if (comment.tooltip) comment.tooltip.remove();
        post('comment-removed', {
          commentId: comment.commentId,
          commentKey: comment.commentKey,
          pageUrl: window.location.href || document.URL || 'about:blank',
        });
      }
    }
    affectedElements.forEach(repaintElement);
    // Renumber whatever survived so the host can rebuild its display numbers
    // from the stable keys it already tracks.
    const renumberedComments = [];
    comments.forEach((c, i) => {
      const newId = i + 1;
      if (c.commentId !== newId) {
        renumberedComments.push({
          oldId: c.commentId,
          newId,
          ...(c.commentKey ? { commentKey: c.commentKey } : {}),
        });
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
    hideDesignTip();
    sentBubbles.forEach(positionMarker);
  };

  const composerWidthFor = (el) => {
    const mode = el ? el.getAttribute('data-mavis-props') : null;
    const max =
      mode === 'expanded'
        ? propsComposerWidth.expanded
        : mode === 'collapsed'
          ? propsComposerWidth.collapsed
          : composerSpec.width.max;
    return Math.min(
      max,
      Math.max(composerSpec.width.min, window.innerWidth - composerSpec.width.viewportInset * 2),
    );
  };

  /**
   * Picks the side of the target the composer goes on, so the panel sits next
   * to the selection instead of on top of it: below, then above, then right,
   * then left - the first side with room for the whole panel wins. Failing
   * that, the roomiest side that still holds a readable property list, with
   * the list shrunk to fit. When no side holds that much, the list keeps its
   * readable height and the panel overlaps the target a little on the roomier
   * of below/above; a target taller than the viewport sends the panel to the
   * viewport edge away from the target's centre.
   */
  const composerPlacementFor = (rect, width, chrome, wanted) => {
    const inset = composerSpec.width.viewportInset;
    const gap = composerSpec.placement.anchorGap;
    const fullRoom = window.innerHeight - inset * 2;
    const rightSpace = window.innerWidth - (rect.x + rect.width + gap) - inset;
    const leftSpace = rect.x - gap - inset;
    const candidates = [
      { side: 'below', room: window.innerHeight - (rect.y + rect.height + gap) - inset },
      { side: 'above', room: rect.y - gap - inset },
      { side: 'right', room: rightSpace >= width ? fullRoom : -1 },
      { side: 'left', room: leftSpace >= width ? fullRoom : -1 },
    ];
    const whole = candidates.find((item) => item.room >= chrome + wanted);
    if (whole) return whole;
    const enough = chrome + Math.min(wanted, propsScrollHeight.min);
    const usable = candidates.filter((item) => item.room >= enough);
    if (usable.length > 0) {
      return usable.reduce((best, item) => (item.room > best.room ? item : best));
    }
    const readable = Math.min(enough, fullRoom);
    if (rect.height < window.innerHeight - inset * 2) {
      const vertical = candidates[0].room >= candidates[1].room ? candidates[0] : candidates[1];
      return { side: vertical.side, room: readable };
    }
    const centre = rect.y + rect.height / 2;
    return { side: centre > window.innerHeight / 2 ? 'top' : 'bottom', room: fullRoom };
  };

  const rectsOverlap = (a, b) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  const positionComposer = () => {
    if (!composer) return;
    const rect = activeElement
      ? rectFromDomRect(activeElement.getBoundingClientRect())
      : normalizeRect(activeRect);
    if (!rect) return;
    if (activeElement && !document.documentElement.contains(activeElement)) return;
    const inset = composerSpec.width.viewportInset;
    const gap = composerSpec.placement.anchorGap;
    const width = composerWidthFor(composer);
    composer.style.width = width + 'px';
    // The property list scrolls inside the panel, so its height is whatever
    // room the chosen side leaves. A collapsed inspector has no list to fit.
    const found = composer.querySelector('[data-mavis-props-scroll]');
    const scroller = found && found.getClientRects().length > 0 ? found : null;
    const listHeight = scroller ? scroller.getBoundingClientRect().height : 0;
    const chrome =
      (composer.getBoundingClientRect().height || composerSpec.create.height) - listHeight;
    const wanted = scroller
      ? clamp(scroller.scrollHeight, propsScrollHeight.floor, propsScrollHeight.max)
      : 0;
    const fitList = (room) => {
      if (!scroller) return;
      // important: the bundle's utility classes are important, so a plain
      // inline value would lose to the panel's own max-h class.
      scroller.style.setProperty(
        'max-height',
        Math.round(clamp(room - chrome, propsScrollHeight.floor, propsScrollHeight.max)) + 'px',
        'important',
      );
    };

    if (composerManualPos) {
      fitList(window.innerHeight - inset * 2);
      const height = composer.getBoundingClientRect().height || composerSpec.create.height;
      const left = clamp(composerManualPos.left, 8, Math.max(8, window.innerWidth - width - 8));
      const top = clamp(composerManualPos.top, 8, Math.max(8, window.innerHeight - height - 8));
      if (composerManualPosCarried && rectsOverlap({ x: left, y: top, width, height }, rect)) {
        // The spot the user dragged to would hide the newly picked element.
        composerManualPos = null;
        composerManualPosCarried = false;
      } else {
        composer.style.left = left + 'px';
        composer.style.top = top + 'px';
        return;
      }
    }

    const placement = composerPlacementFor(rect, width, chrome, wanted);
    fitList(placement.room);
    const height = composer.getBoundingClientRect().height || composerSpec.create.height;
    let left = rect.x + rect.width / 2 - width / 2;
    let top = rect.y + rect.height + gap;
    if (placement.side === 'above') {
      top = rect.y - gap - height;
    } else if (placement.side === 'right') {
      left = rect.x + rect.width + gap;
      top = rect.y;
    } else if (placement.side === 'left') {
      left = rect.x - gap - width;
      top = rect.y;
    } else if (placement.side === 'top') {
      top = inset;
    } else if (placement.side === 'bottom') {
      top = window.innerHeight - height - inset;
    }
    composer.style.left =
      clamp(left, inset, Math.max(inset, window.innerWidth - width - inset)) + 'px';
    composer.style.top =
      clamp(top, inset, Math.max(inset, window.innerHeight - height - inset)) + 'px';
  };

  function openComposer(target, existingComment, seed) {
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
    if (seed && seed.position) {
      composerManualPos = seed.position;
      composerManualPosCarried = true;
    }
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
    // Comment mode puts a crosshair on the page; the composer is ordinary UI.
    wrapper.style.cursor = 'default';

    const inputRow = document.createElement('div');
    inputRow.style.display = 'flex';
    inputRow.style.minWidth = '0';
    inputRow.style.flex = '1 1 auto';
    inputRow.style.alignItems = 'center';

    const input = document.createElement('textarea');
    input.setAttribute('data-mavis-embedded-comment-input', 'true');
    input.value =
      seed && typeof seed.feedback === 'string'
        ? seed.feedback
        : existingComment && !existingComment.feedbackIsAuto
          ? existingComment.feedback
          : '';
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
    input.style.cursor = 'text';
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

    // Mirrors the desktop IconButton (30px target, 8px radius, hover fill, 18px
    // glyph) so it matches the panel's footer buttons, which replace it
    // whenever the props panel mounts. The box bleeds into the row padding to
    // sit 5px off the edge, like the panel toggle above it.
    const deleteBox = composerSpec.actionButton.size;
    const del = document.createElement('button');
    del.type = 'button';
    mountComposerIcon(del, composerIcons.delete, 18);
    const deleteTip = () =>
      (existingComment ? propsStrings.deleteComment : propsStrings.discardComment) ||
      (existingComment ? 'Delete comment' : 'Discard comment');
    del.setAttribute('aria-label', deleteTip());
    del.style.width = deleteBox + 'px';
    del.style.height = deleteBox + 'px';
    del.style.margin = '0 0 0 ' + (5 - composerSpec.wrapper.stackedPaddingX) + 'px';
    del.style.display = 'inline-flex';
    del.style.alignItems = 'center';
    del.style.justifyContent = 'center';
    del.style.border = '0';
    del.style.borderRadius = '8px';
    del.style.padding = '0';
    del.style.background = 'transparent';
    del.style.color = 'var(--mavis-comment-tertiary-icon, GrayText)';
    del.style.cursor = composerSpec.actionButton.enabledCursor;
    del.style.transition = 'background-color 0.15s, color 0.15s';
    del.addEventListener('mouseenter', () => {
      del.style.background = 'var(--mavis-comment-secondary-hover, transparent)';
      del.style.color = 'var(--mavis-comment-tertiary-hover, CanvasText)';
      showDesignTip(del.getBoundingClientRect(), deleteTip());
    });
    del.addEventListener('mouseleave', () => {
      del.style.background = 'transparent';
      del.style.color = 'var(--mavis-comment-tertiary-icon, GrayText)';
      hideDesignTip();
    });
    del.addEventListener('pointerdown', () => hideDesignTip());

    // Only offered when the app reports voice input is available.
    let mic = null;
    if (propsStrings.voice) {
      ensureBridgeStyle();
      mic = document.createElement('button');
      mic.type = 'button';
      mountComposerIcon(mic, composerIcons.mic, 16);
      mic.setAttribute('aria-label', propsStrings.voice);
      mic.title = propsStrings.voice;
      mic.style.width = composerSpec.actionButton.size + 'px';
      mic.style.height = composerSpec.actionButton.size + 'px';
      mic.style.display = 'inline-flex';
      mic.style.alignItems = 'center';
      mic.style.justifyContent = 'center';
      mic.style.flex = '0 0 auto';
      mic.style.border = '0';
      mic.style.borderRadius = composerSpec.actionButton.borderRadius + 'px';
      mic.style.padding = '0';
      mic.style.cursor = composerSpec.actionButton.enabledCursor;
      mic.style.transition = composerSpec.actionButton.transition;
      const paintMic = (hover) => {
        const active = voiceState !== 'idle';
        mic.setAttribute('aria-pressed', active ? 'true' : 'false');
        mic.style.color = active
          ? 'var(--mavis-comment-primary-bg, Highlight)'
          : 'var(--mavis-comment-secondary-icon, CanvasText)';
        mic.style.background =
          active || hover
            ? 'var(--mavis-comment-secondary-hover, ButtonFace)'
            : 'var(--mavis-comment-secondary-bg, transparent)';
        mic.style.animation = voiceState === 'listening' ? 'mavis-voice-pulse 1.2s ease-in-out infinite' : '';
      };
      paintMic(false);
      mic.addEventListener('mouseenter', () => paintMic(true));
      mic.addEventListener('mouseleave', () => paintMic(false));
      mic.addEventListener('pointerdown', (event) => event.preventDefault());
      mic.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!isTrustedUserEvent(event)) return;
        if (voiceState === 'idle') {
          voiceState = 'pending';
          voicePrefix = input.value;
          post('voice-request', { action: 'start' });
        } else {
          post('voice-request', { action: 'stop' });
        }
        paintMic(false);
        input.focus();
      });
      composerVoice = {
        paint: () => paintMic(false),
        setText: (text) => {
          const prefix = voicePrefix === null ? '' : voicePrefix.trimEnd();
          input.value = prefix ? prefix + ' ' + text : text;
          input.dispatchEvent(new Event('input'));
        },
      };
    }

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

    // Property inspector: element picks only (a free rectangle has no single
    // element to restyle). Without the bundle the composer is unchanged.
    const panelApi = rectTarget ? null : propsApi();
    let panelToggle = null;
    let panelBody = null;
    let panelFooter = null;
    if (panelApi && element) {
      let read = null;
      try {
        read =
          existingComment && existingComment.styleFrom
            ? { values: existingComment.styleFrom, inline: Boolean(existingComment.styleInline) }
            : panelApi.readStyleValues(element);
      } catch (_) {
        read = null;
      }
      if (read) {
        // Toggle leads the input row; the element bar and property groups run
        // edge to edge between the input and the footer; "reset all" joins the
        // footer's left side.
        panelToggle = document.createElement('div');
        panelToggle.style.display = 'flex';
        panelToggle.style.flex = '0 0 auto';
        // 28px button inside a 20px text line: bleed into the row padding so
        // the line height is unchanged, and sit 5px off the box edge.
        panelToggle.style.margin =
          '-4px 6px -4px ' + (5 - composerSpec.wrapper.stackedPaddingX) + 'px';
        inputRow.insertBefore(panelToggle, input);
        panelBody = document.createElement('div');
        panelBody.style.width = 'auto';
        panelBody.style.margin = '0 -' + composerSpec.wrapper.stackedPaddingX + 'px';
        wrapper.insertBefore(panelBody, footer);
        panelFooter = document.createElement('div');
        panelFooter.style.display = 'flex';
        panelFooter.style.alignItems = 'center';
        panelFooter.style.marginRight = 'auto';
        // Once mounted it holds the delete button too (the bridge's own one
        // hides), so it takes over the same 5px-off-the-edge bleed.
        panelFooter.style.marginLeft = 5 - composerSpec.wrapper.stackedPaddingX + 'px';
        footer.insertBefore(panelFooter, actions);
        const seededChanges =
          seed && seed.changes
            ? seed.changes
            : existingComment && existingComment.styleChanges
              ? existingComment.styleChanges
              : {};
        draft = {
          element,
          comment: existingComment || null,
          from: read.values,
          inline: read.inline,
          changes: { ...seededChanges },
        };
        if (seed && seed.changes) repaintElement(element);
      }
    }

    /**
     * Sticky once the new comment has wrapped, mirroring the chat composer.
     * Recomputing it from the live height would oscillate: stacking hands the
     * input the full width, which can pull the text back onto one line, which
     * would unstack it again. Only an emptied box resets it, so the layout
     * never changes under a comment the user is still writing.
     */
    let draftHasWrapped = false;

    const applyComposerChrome = () => {
      const hasValue = input.value.trim().length > 0 || draftChangeCount() > 0;
      const isEditingExistingComment = Boolean(existingComment);
      // create opens as one row and stacks the moment the comment needs a
      // second line; edit is stacked from the start, and so is any composer
      // carrying the property inspector.
      const stacked = isEditingExistingComment || draftHasWrapped || Boolean(panelBody);
      const inspectorOpen = Boolean(panelBody) && propsExpanded;
      if (panelBody) {
        wrapper.setAttribute('data-mavis-props', inspectorOpen ? 'expanded' : 'collapsed');
        wrapper.style.width = composerWidthFor(wrapper) + 'px';
        panelBody.style.display = inspectorOpen ? 'block' : 'none';
      } else {
        wrapper.removeAttribute('data-mavis-props');
      }
      // With the inspector open the footer becomes a toolbar under a hairline,
      // running edge to edge like the property groups above it.
      footer.style.gap = '4px';
      footer.style.boxSizing = 'content-box';
      footer.style.width = inspectorOpen ? 'auto' : '100%';
      footer.style.margin = inspectorOpen
        ? '0 -' + composerSpec.wrapper.stackedPaddingX + 'px'
        : '0';
      footer.style.padding = inspectorOpen
        ? '5px 5px 0 ' + composerSpec.wrapper.stackedPaddingX + 'px'
        : '0';
      footer.style.borderTop = inspectorOpen
        ? '0.5px solid var(--mavis-comment-border, transparent)'
        : '0';
      const layout = isEditingExistingComment ? composerSpec.edit : composerSpec.create;
      // With the inspector attached the comment field opens at one line even
      // when editing: the property list already makes the panel tall, and the
      // field still grows as the comment does.
      const fieldLayout = isEditingExistingComment && !panelBody ? composerSpec.edit : composerSpec.create;
      // Submit is enabled either when the user has something to save, or when
      // they are editing an existing comment and the action is to discard it
      // (empty input + no style changes, after Reset all). New empty comments
      // are still rejected by disableEmptySubmit so we never create a comment
      // the user did not ask for.
      const canSubmit = hasValue || isEditingExistingComment;
      const willDiscard = isEditingExistingComment && !hasValue;
      submit.disabled = composerSpec.behavior.disableEmptySubmit && !canSubmit;
      submit.setAttribute(
        'aria-label',
        willDiscard
          ? 'Discard comment'
          : hasValue
            ? 'Submit comment'
            : 'Submit comment unavailable',
      );
      submit.style.background = canSubmit
        ? 'var(--mavis-comment-primary-bg, CanvasText)'
        : 'var(--mavis-comment-primary-inactive, GrayText)';
      submit.style.cursor = canSubmit
        ? composerSpec.actionButton.enabledCursor
        : composerSpec.actionButton.disabledCursor;

      // Heights are floors rather than fixed sizes, so the box can follow its
      // comment; the edit box still opens at exactly its specced size.
      // The inspector composer opens its field at one line (see fieldLayout),
      // so the edit box's 106px floor would only pad empty space under the
      // footer; it sizes to its content instead.
      wrapper.style.minHeight = panelBody ? '0px' : layout.height + 'px';
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
      inputRow.style.minHeight = fieldLayout.inputRowHeight + 'px';
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
      input.style.height = fieldLayout.inputHeight + 'px';
      // Baseline scrollability, likewise overwritten by the auto-grow pass with
      // whatever the text actually needs. It carries the case where that pass
      // cannot measure at all: an edit box opens on a stored comment that may
      // already be taller than the field, so it has to stay scrollable.
      input.style.overflowY = isEditingExistingComment ? 'auto' : 'hidden';

      if (stacked) {
        footer.style.display = 'flex';
        if (isEditingExistingComment && !panelBody) {
          // Editing can be cancelled back to the stored comment, so it keeps
          // cancel beside submit. The inspector composer drops it: next to the
          // trash it reads as a second delete, submit with nothing changed
          // already just closes, and Escape still discards the edit.
          actions.appendChild(close);
        } else if (close.parentNode) {
          // A new comment has nothing to roll back to; the discard slot on the
          // left already covers throwing the quote away.
          close.parentNode.removeChild(close);
        }
        if (mic) actions.appendChild(mic);
        actions.appendChild(submit);
      } else {
        footer.style.display = 'none';
        if (mic) wrapper.appendChild(mic);
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
      const minHeight =
        isEditingExistingComment && !panelBody ? composerSpec.edit.inputHeight : lineHeight;
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

    const commit = (event, internal, preserveDraftOnFailure) => {
      if (!internal && !isTrustedUserEvent(event)) return null;
      const typed = composerSpec.behavior.trimOnSubmit ? input.value.trim() : input.value;
      let styleChanges = {};
      if (draft && panelApi) {
        try {
          styleChanges = panelApi.pruneStyleChanges(draft.from, draft.changes);
        } catch (_) {
          if (preserveDraftOnFailure) return null;
          styleChanges = {};
        }
      }
      const styleChangeCount = changeCount(styleChanges);
      if (!typed.trim() && styleChangeCount === 0) {
        // Empty submit on an existing comment (Reset all + Enter) discards
        // it and restores the element's baseline. New comments are still
        // rejected here so we never create an empty marker the user did
        // not ask for.
        if (existingComment) {
          const removed = existingComment;
          removeComposer();
          dropComment(removed);
        }
        return null;
      }
      const feedbackIsAuto = !typed.trim();
      const feedback = feedbackIsAuto
        ? fillTemplate(propsStrings.propsOnlyFeedback || 'Adjusted {{count}} properties', {
            count: styleChangeCount,
          })
        : typed;
      const targetRect = rectTarget || (element ? rectFromDomRect(element.getBoundingClientRect()) : null);
      if (!targetRect) {
        if (!preserveDraftOnFailure) removeComposer();
        return null;
      }
      const targetPayload = rectTarget ? payloadForRect(targetRect) : payloadFor(element);
      let comment = existingComment;
      if (!comment) {
        const nextId = comments.reduce((max, item) => Math.max(max, item.commentId), 0) + 1;
        commentSeq = nextId;
        comment = {
          commentId: nextId,
          commentKey: newCommentKey(),
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
      comment.feedbackIsAuto = feedbackIsAuto;
      if (draft) {
        comment.styleFrom = draft.from;
        comment.styleInline = draft.inline;
        comment.styleChanges = styleChanges;
      }
      positionMarker(comment);
      // removeComposer drops the draft layer and repaints the confirmed one.
      removeComposer();
      postComment(comment, targetPayload);
      return comment;
    };

    const initialFeedback = input.value;
    const initialChanges = draft ? { ...draft.changes } : {};
    composerApi = {
      existingComment: existingComment || null,
      hasUncommittedChanges: () => {
        const changes = draft ? draft.changes : {};
        return input.value !== initialFeedback ||
          Object.keys(changes).length !== Object.keys(initialChanges).length ||
          Object.keys(changes).some((key) => changes[key] !== initialChanges[key]);
      },
      feedback: () => input.value,
      styleChangeCount: draftChangeCount,
      snapshot: () => ({
        element,
        feedback: input.value,
        changes: draft ? { ...draft.changes } : {},
        before: existingComment
          ? {
              feedback: existingComment.feedback,
              feedbackIsAuto: existingComment.feedbackIsAuto,
              styleFrom: existingComment.styleFrom,
              styleInline: existingComment.styleInline,
              styleChanges: existingComment.styleChanges,
            }
          : null,
      }),
      commitInternal: (preserveDraftOnFailure) => commit(null, true, preserveDraftOnFailure),
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
    // Escape from anywhere in the composer, not only the comment field: the
    // inspector composer has no cancel button, so focus sitting in one of its
    // fields still needs a way out. An open dropdown keeps Escape for itself.
    wrapper.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.target === input) return;
      if (!composerSpec.behavior.escapeCancels) return;
      const target = event.target;
      if (target instanceof Element && target.closest('[aria-expanded="true"]')) return;
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
    if (draft && panelApi && panelToggle && panelBody && panelFooter) {
      // The hierarchy is the path from the element first clicked up through
      // its ancestors. Moving up keeps that first pick as the leaf, so the
      // user can walk back down the same way instead of losing it.
      const seededLeaf = seed && seed.pathLeaf;
      let chain = [element].concat(ancestorsOf(element));
      if (
        seededLeaf &&
        seededLeaf !== element &&
        document.documentElement.contains(seededLeaf) &&
        element.contains(seededLeaf)
      ) {
        const fromLeaf = [seededLeaf].concat(ancestorsOf(seededLeaf));
        if (fromLeaf.indexOf(element) >= 0) chain = fromLeaf;
      }
      const path = chain.slice().reverse();
      const pathLeaf = chain[0];
      try {
        composerPanel = panelApi.mount({
          shadowRoot: ensureBridgeUiRoot(),
          toggleContainer: panelToggle,
          footerContainer: panelFooter,
          bodyContainer: panelBody,
          from: draft.from,
          changes: draft.changes,
          inline: draft.inline,
          propsAvailable: true,
          expanded: propsExpanded,
          label: panelApi.labelOf(element),
          path: path.map((node) => panelApi.labelOf(node)),
          pathIndex: path.indexOf(element),
          pageColors: pageColors(),
          theme: resolvedTheme(),
          locale: propsLocale,
          onChange: (changes) => {
            if (!draft) return;
            draft.changes = changes || {};
            repaintElement(draft.element);
            if (composerPanel) composerPanel.update({ changes: draft.changes });
            updateActiveBox();
            comments.forEach(positionMarker);
            if (composerRelayout) composerRelayout();
          },
          onExpandedChange: (next) => {
            propsExpanded = Boolean(next);
            post('props-preference', { expanded: propsExpanded });
            if (composerPanel) composerPanel.update({ expanded: propsExpanded });
            if (composerRelayout) composerRelayout();
          },
          onSelectPath: (index) => {
            const next = path[index];
            if (!next || next === element || !document.documentElement.contains(next)) return;
            pathPreview = null;
            clearHover();
            switchComposerTarget(next, comments.find((item) => item.element === next) || null, pathLeaf);
          },
          onHoverPath: (index) => {
            const next = typeof index === 'number' ? path[index] : null;
            pathPreview = next && next !== element ? next : null;
            clearHover();
            if (pathPreview) updateBox(ensureBox('hover'), pathPreview);
          },
          onLayout: () => {
            if (composerRelayout) composerRelayout();
          },
          deleteKind: existingComment ? 'delete' : 'discard',
          // Only reachable from the closed shadow root's own UI, so the page
          // can't script it; the panel button may fire from Enter as well.
          onDelete: () => {
            hideDesignTip();
            if (existingComment) dropComment(existingComment);
            else removeComposer();
          },
        });
        del.style.display = 'none';
        bindComposerDragSurface(wrapper);
      } catch (error) {
        diagnose('props-panel-mount-failed', {
          errorMessage: String((error && error.message) || error).slice(0, 160),
        });
        composerPanel = null;
        draft = null;
        panelToggle.remove();
        panelBody.remove();
        panelFooter.remove();
        panelToggle = null;
        panelBody = null;
        panelFooter = null;
        updateComposerLayout();
      }
    }
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
      if (next instanceof Element && next.closest('[data-mavis-props-portal]')) return;
      diagnose('composer-focusout', {
        relatedTag:
          next && next.tagName && typeof next.tagName === 'string'
            ? next.tagName.toLowerCase()
            : null,
        relatedIsBridgeUi: isBridgeUi(next),
      });
      setInteractionState(enabled ? 'idle' : 'disabled', 'composer-focus-left');
    });
    wrapper.addEventListener('focusin', () => {
      if (interactionState !== 'composing') {
        clearHover();
        setInteractionState('composing', 'composer-panel-focused');
      }
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
    sentBubbles.forEach(positionMarker);
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

  const capturePointer = (element, event) => {
    try {
      if (
        element &&
        typeof element.setPointerCapture === 'function' &&
        typeof event.pointerId === 'number'
      ) {
        element.setPointerCapture(event.pointerId);
      }
    } catch (_) {
      // Pointer capture is optional; the full-viewport glass still receives the drag.
    }
  };
  const releaseGlassPointerCapture = (pointerId) => {
    if (!glass || typeof pointerId !== 'number') return;
    try {
      if (
        typeof glass.hasPointerCapture === 'function' &&
        glass.hasPointerCapture(pointerId) &&
        typeof glass.releasePointerCapture === 'function'
      ) {
        glass.releasePointerCapture(pointerId);
      }
    } catch (_) {
      // The pointer may already be gone after a cancellation.
    }
  };
  const suppressNextClick = (target) => {
    suppressedClick = {
      target,
      expiresAt: performance.now() + 500,
    };
  };
  const consumeSuppressedClick = (event) => {
    if (!suppressedClick) return false;
    const suppression = suppressedClick;
    suppressedClick = null;
    return performance.now() <= suppression.expiresAt && event.target === suppression.target;
  };
  const consumeCancelledGesture = (event) => {
    if (!cancelledGesture) return false;
    const eventPointerId = pointerIdFor(event);
    if (
      cancelledGesture.pointerId !== null &&
      eventPointerId !== null &&
      cancelledGesture.pointerId !== eventPointerId
    ) {
      return false;
    }
    cancelledGesture = null;
    return true;
  };
  const isPrimaryPress = (event) =>
    enabled && event.button === 0 && event.isPrimary !== false;
  const settleWithoutComposer = (reason) => {
    if (interactionState !== 'composing') {
      setInteractionState(enabled ? 'idle' : 'disabled', reason);
    }
  };

  // Page listeners (DOM-node mode) and the glass (free-rectangle mode) share
  // one gesture state machine. Callers resolve the page element under the
  // pointer and the element whose click must be swallowed afterwards.
  const beginPointerInteraction = (event, target, captureElement) => {
    if (composer && interactionState === 'composing') {
      event.preventDefault();
      event.stopPropagation();
      suppressNextClick(event.target);
      setInteractionState('idle', 'composer-page-pointer');
      clearHover();
      try {
        composerInput?.blur();
      } catch (_) {
        // The state transition still releases page inspection when blur is unavailable.
      }
      diagnose('composer-deactivated', {
        targetTag: target && target.tagName ? target.tagName.toLowerCase() : null,
      });
      return;
    }
    if (selectionMode !== 'free_rect') return;
    event.preventDefault();
    event.stopPropagation();
    if (pointerGesture) return;
    cancelledGesture = null;
    clearHover();
    pointerGesture = {
      pointerId: pointerIdFor(event),
      start: { x: event.clientX, y: event.clientY },
      target,
      dragging: false,
    };
    setInteractionState('pointer_pending', 'pointer-down');
    diagnose('pointer-pending', {
      targetTag: target && target.tagName ? target.tagName.toLowerCase() : null,
    });
    capturePointer(captureElement, event);
  };

  const movePointerInteraction = (event, resolveHoverTarget) => {
    if (!enabled) return;
    if (pathPreview && event.target instanceof Element && isBridgeUi(event.target)) {
      // Pointing at the path in the panel outlines that element instead.
      hovered = null;
      updateBox(ensureBox('hover'), pathPreview);
      return;
    }
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
    const target = resolveHoverTarget();
    if (!target) {
      clearHover();
      return;
    }
    hovered = target;
    updateBox(ensureBox('hover'), hovered);
  };

  const finishPointerInteraction = (event, pointerUpTarget, clickTarget) => {
    if (!enabled || selectionMode !== 'free_rect') return;
    if (!pointerGesture) {
      // Escape already ended this drag; swallow its release and click.
      if (consumeCancelledGesture(event)) {
        event.preventDefault();
        event.stopPropagation();
        suppressNextClick(clickTarget || event.target);
      }
      return;
    }
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
    const eventTarget = pointerUpTarget || gesture.target;
    suppressNextClick(clickTarget || eventTarget);
    diagnose('pointer-finished', {
      dragged: Boolean(gesture.dragging),
      width: nextRect ? nextRect.width : null,
      height: nextRect ? nextRect.height : null,
    });
    if (!gesture.dragging || !nextRect) {
      if (eventTarget) {
        const existing = comments.find((item) => item.element === eventTarget);
        switchComposerTarget(eventTarget, existing || null);
      }
      settleWithoutComposer('pointer-finished-without-composer');
      return;
    }
    switchComposerTarget({ selectionMode: 'free_rect', rect: nextRect }, null);
    settleWithoutComposer('pointer-finished-without-composer');
  };

  const cancelRectSelection = (event) => {
    if (event && pointerGesture && !matchesPointerGesture(event)) return;
    const gesture = pointerGesture;
    pointerGesture = null;
    if (gesture) releaseGlassPointerCapture(gesture.pointerId);
    if (dragBox) dragBox.style.display = 'none';
    setInteractionState(
      enabled ? (composerHasFocus() ? 'composing' : 'idle') : 'disabled',
      'pointer-cancelled',
    );
    const generation = composerGeneration;
    window.setTimeout(() => focusComposerInput(generation, 'pointer-cancel-recovery'), 0);
  };

  const clickInteraction = (event, target) => {
    if (interactionState === 'composing') {
      event.preventDefault();
      event.stopPropagation();
      clearHover();
      return;
    }
    if (interactionState !== 'idle' || !target) return;
    pointerGesture = null;
    event.preventDefault();
    event.stopPropagation();
    const existing = comments.find((item) => item.element === target);
    switchComposerTarget(target, existing || null);
  };

  // In free-rectangle mode the glass owns bridge-UI input. Page listeners stay
  // attached for top-layer page UI (modal dialogs, popovers) that the glass
  // cannot cover, but must not process the glass's input a second time.
  const isGlassOwnedEvent = (event) => Boolean(glass) && isBridgeUi(event.target);
  const handlePointerDown = (event) => {
    if (!isTrustedUserEvent(event) || !isPrimaryPress(event)) return;
    const target = pageTargetFor(event);
    if (!target) return;
    beginPointerInteraction(event, target, target);
  };
  const handlePointerMove = (event) => {
    if (isGlassOwnedEvent(event)) return;
    movePointerInteraction(event, () => pageTargetFor(event));
  };
  const handlePointerLeave = () => {
    if (pointerGesture) return;
    clearHover();
  };
  const finishRectSelection = (event) => {
    if (!isTrustedUserEvent(event) || isGlassOwnedEvent(event)) return;
    const target = pageTargetFor(event);
    finishPointerInteraction(event, target, target);
  };
  const handlePagePointerCancel = (event) => {
    if (isGlassOwnedEvent(event)) return;
    cancelRectSelection(event);
  };
  const handleClick = (event) => {
    if (!isTrustedUserEvent(event)) return;
    if (!enabled || isGlassOwnedEvent(event)) return;
    if (consumeSuppressedClick(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = pageTargetFor(event);
    if (!target) return;
    clickInteraction(event, target);
  };

  const handleGlassPointerDown = (event) => {
    if (!isTrustedUserEvent(event) || !isPrimaryPress(event)) return;
    beginPointerInteraction(event, glassTargetFor(event), glass);
    // A focused child frame keeps receiving keys, so Escape would never reach
    // this document during the drag. Blurring the frame owner returns focus to
    // this frame without raising the window or touching other page focus.
    const active = document.activeElement;
    if (
      pointerGesture &&
      active instanceof Element &&
      (active.tagName === 'IFRAME' || active.tagName === 'FRAME') &&
      typeof active.blur === 'function'
    ) {
      try {
        active.blur();
      } catch (_) {
        // Escape cancellation is best-effort while a child frame keeps focus.
      }
    }
  };
  const handleGlassPointerMove = (event) => {
    movePointerInteraction(event, () => glassTargetFor(event));
  };
  const handleGlassPointerUp = (event) => {
    if (!isTrustedUserEvent(event)) return;
    finishPointerInteraction(event, null, glass);
  };
  const handleGlassPointerCancel = (event) => {
    if (!pointerGesture) return;
    cancelRectSelection(event);
  };
  const handleGlassClick = (event) => {
    if (!isTrustedUserEvent(event)) return;
    if (!enabled) return;
    event.preventDefault();
    event.stopPropagation();
    if (consumeSuppressedClick(event)) return;
    clickInteraction(event, glassTargetFor(event));
  };
  const wheelDeltaPixels = (event, delta, viewportSize) => {
    if (event.deltaMode === 1) return delta * wheelLinePixels;
    if (event.deltaMode === 2) return delta * viewportSize;
    return delta;
  };
  const canScrollBy = (element, dx, dy) => {
    let style = null;
    try {
      style = window.getComputedStyle(element);
    } catch (_) {
      return false;
    }
    const scrollsY =
      /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
    const scrollsX =
      /(auto|scroll|overlay)/.test(style.overflowX) && element.scrollWidth > element.clientWidth;
    const canY =
      scrollsY &&
      ((dy < 0 && element.scrollTop > 0) ||
        (dy > 0 && element.scrollTop + element.clientHeight < element.scrollHeight - 1));
    const canX =
      scrollsX &&
      ((dx < 0 && element.scrollLeft > 0) ||
        (dx > 0 && element.scrollLeft + element.clientWidth < element.scrollWidth - 1));
    return canY || canX;
  };
  // Scrolls one candidate synchronously and reports whether it moved, so a
  // wheel the forwarder cannot use still falls through to native scrolling.
  const scrollMoved = (read, scroll) => {
    try {
      const before = read();
      scroll();
      const after = read();
      return before.x !== after.x || before.y !== after.y;
    } catch (_) {
      return false;
    }
  };
  const forwardWheelToFrame = (element, dx, dy) => {
    if (!(element instanceof HTMLIFrameElement)) return false;
    let frameWindow = null;
    try {
      frameWindow = element.contentWindow;
      // Cross-origin frames throw here; their scroll position is private.
      if (!frameWindow || !frameWindow.document) return false;
    } catch (_) {
      return false;
    }
    return scrollMoved(
      () => ({ x: frameWindow.scrollX, y: frameWindow.scrollY }),
      () => frameWindow.scrollBy({ left: dx, top: dy, behavior: 'instant' }),
    );
  };
  const forwardWheelToNestedScroller = (start, dx, dy) => {
    const rootScroller = document.scrollingElement || document.documentElement;
    let node = start;
    while (node && node !== rootScroller && node !== document.documentElement) {
      const element = node;
      if (
        element instanceof Element &&
        typeof element.scrollBy === 'function' &&
        canScrollBy(element, dx, dy) &&
        scrollMoved(
          () => ({ x: element.scrollLeft, y: element.scrollTop }),
          () => element.scrollBy({ left: dx, top: dy, behavior: 'instant' }),
        )
      ) {
        return true;
      }
      if (element.parentElement) {
        node = element.parentElement;
        continue;
      }
      const root = typeof element.getRootNode === 'function' ? element.getRootNode() : null;
      node = root && root.host ? root.host : null;
    }
    return false;
  };
  // Wheel input lands on the glass. Chaining from the fixed glass reaches the
  // document scroller natively, so only nested page scrollers and same-origin
  // frames need forwarding. A cross-origin frame's content cannot be scrolled
  // from here and the wheel falls through to the document instead.
  const handleGlassWheel = (event) => {
    if (!enabled || pointerGesture || event.ctrlKey) return;
    const dx = wheelDeltaPixels(event, Number(event.deltaX) || 0, window.innerWidth);
    const dy = wheelDeltaPixels(event, Number(event.deltaY) || 0, window.innerHeight);
    if (!dx && !dy) return;
    const target = glassTargetFor(event);
    if (forwardWheelToFrame(target, dx, dy) || forwardWheelToNestedScroller(target, dx, dy)) {
      event.preventDefault();
    }
  };
  const handleSelectionKeyDown = (event) => {
    if (event.key !== 'Escape' || !pointerGesture) return;
    if (!isTrustedUserEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    cancelledGesture = { pointerId: pointerGesture.pointerId };
    diagnose('pointer-escape-cancelled', {
      dragged: Boolean(pointerGesture.dragging),
    });
    cancelRectSelection();
  };

  const glassListeners = [
    ['pointerdown', handleGlassPointerDown],
    ['pointermove', handleGlassPointerMove],
    ['pointerup', handleGlassPointerUp],
    ['pointercancel', handleGlassPointerCancel],
    ['lostpointercapture', handleGlassPointerCancel],
    ['pointerleave', handlePointerLeave],
    ['click', handleGlassClick],
  ];
  const ensureGlass = () => {
    if (!glass) {
      const surface = document.createElement('div');
      surface.setAttribute('data-mavis-embedded-comment-ui', 'true');
      surface.setAttribute('data-mavis-embedded-comment-glass', 'true');
      surface.style.position = 'fixed';
      surface.style.inset = '0';
      surface.style.zIndex = '2147483643';
      surface.style.cursor = 'crosshair';
      surface.style.touchAction = 'none';
      surface.style.userSelect = 'none';
      surface.style.pointerEvents = 'auto';
      // Chromium sends input over an out-of-process iframe straight to that
      // frame unless the parent paints there. A transparent background colour
      // paints nothing; a transparent gradient does, without changing pixels.
      surface.style.backgroundImage = 'linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0))';
      glassListeners.forEach(([type, listener]) => surface.addEventListener(type, listener));
      surface.addEventListener('wheel', handleGlassWheel, { passive: false });
      glass = surface;
    }
    if (!glass.isConnected) mountBridgeUi(glass);
    return glass;
  };
  const removeGlass = () => {
    if (!glass) return;
    const surface = glass;
    glassListeners.forEach(([type, listener]) => surface.removeEventListener(type, listener));
    surface.removeEventListener('wheel', handleGlassWheel);
    surface.remove();
    glass = null;
  };
  const setPageListeners = (attached) => {
    const method = attached ? 'addEventListener' : 'removeEventListener';
    document[method]('pointerdown', handlePointerDown, true);
    document[method]('pointermove', handlePointerMove, true);
    document[method]('pointerup', finishRectSelection, true);
    document[method]('pointercancel', handlePagePointerCancel, true);
    document[method]('pointerleave', handlePointerLeave, true);
    document[method]('click', handleClick, true);
  };
  const setEnabled = (nextEnabled) => {
    enabled = Boolean(nextEnabled);
    setInteractionState(
      enabled ? (composerHasFocus() ? 'composing' : 'idle') : 'disabled',
      enabled ? 'mode-enabled' : 'mode-disabled',
    );
    document.documentElement.style.cursor = enabled ? 'crosshair' : '';
    if (pointerGesture || !enabled) cancelRectSelection();
    cancelledGesture = null;
    // Free-rectangle mode takes input on the glass so drags can start over
    // iframes; DOM-node mode keeps the page-document listeners only.
    setPageListeners(enabled);
    if (enabled && selectionMode === 'free_rect') ensureGlass();
    else removeGlass();
    if (enabled) {
      document.addEventListener('keydown', handleSelectionKeyDown, true);
    } else {
      document.removeEventListener('keydown', handleSelectionKeyDown, true);
      hovered = null;
      updateBox(hoverBox, null);
      removeComposer();
    }
    comments.forEach(positionMarker);
    sentBubbles.forEach(positionMarker);
    diagnose('mode-updated', { enabled, interactionState });
    post('ready', { enabled, selectionMode, bridgeVersion });
  };

  const destroyForTests = () => {
    if (!allowSyntheticEventsForTests) return false;
    setEnabled(false);
    restoreAllPreviews();
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
      if (data.strings && typeof data.strings === 'object') {
        const nextStrings = {};
        Object.entries(data.strings).forEach(([key, value]) => {
          if (typeof value === 'string') nextStrings[key] = value.slice(0, 200);
        });
        propsStrings = nextStrings;
      }
      if (typeof data.locale === 'string' && data.locale) propsLocale = data.locale.slice(0, 20);
      if (typeof data.propsExpanded === 'boolean') propsExpanded = data.propsExpanded;
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
      if (composerPanel) composerPanel.update({ theme: resolvedTheme(), locale: propsLocale });
      // 仅更新主题时保留进行中的选区、草稿和焦点。
      if (enabled !== Boolean(data.enabled) || previousSelectionMode !== selectionMode) {
        setEnabled(data.enabled);
      }
    }
    if (data.type === 'clear-selected') removeComposer();
    if (data.type === 'clear-comments' || data.type === 'resolve-sent') {
      // Only an absent field opts into legacy full-page handling. Malformed
      // explicit keys fail closed, rather than widening the operation.
      const keys = 'commentKeys' in data
        ? (Array.isArray(data.commentKeys) ? data.commentKeys : []).filter(
            (entry) => typeof entry === 'string' && entry.length > 0,
          )
        : undefined;
      const revisions = data.commentRevisions;
      if ('commentRevisions' in data && (
        !keys || !revisions || typeof revisions !== 'object' || Array.isArray(revisions) ||
        Object.entries(revisions).some(([key, revision]) =>
          !keys.includes(key) || !Number.isSafeInteger(revision) || revision <= 0)
      )) return false;
      if (data.type === 'clear-comments') clearComments(data.sent === true, keys, revisions);
      else resolveSentBubbles(data.status === 'done' ? 'done' : 'cancelled', keys, revisions);
    }
    if (data.type === 'remove-comment') removeCommentFromHost(data);
    if (data.type === 'voice-update') {
      const nextState =
        data.state === 'listening' || data.state === 'transcribing' ? data.state : 'idle';
      if (composerVoice) {
        if (typeof data.text === 'string') composerVoice.setText(data.text.slice(0, 4000));
        // A final transcript can land after idle, so the prefix is kept
        // until the next start press replaces it.
        voiceState = nextState;
        composerVoice.paint();
      } else {
        voiceState = 'idle';
        voicePrefix = null;
      }
    }
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
        parsed.type !== 'ready' &&
        parsed.type !== 'props-preference' &&
        parsed.type !== 'voice-request') {
        return null;
    }
    return {
        type: parsed.type,
        ...(typeof parsed.messageId === 'number' ? { messageId: parsed.messageId } : {}),
        payload: parsed.payload,
    };
}
