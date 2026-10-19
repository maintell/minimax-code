// Source of truth for the Mavis-owned PDF.js parent bridge. Keep the Web and
// native static copies byte-for-byte synchronized; the Electron contract test enforces
// that relationship without modifying the vendored viewer.mjs bundle.
const BRIDGE_SCHEMA = 'mavis.pdf_viewer_bridge.v1';
const BRIDGE_VERSION = 1;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/u;
const APPLICATION_POLL_MS = 25;

function isPositiveSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isTrustedParentOrigin(origin) {
  if (typeof origin !== 'string' || origin === 'null') return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash || url.search) return false;
  if (url.protocol === 'app:') {
    return Boolean(url.hostname) && !url.port && (url.pathname === '' || url.pathname === '/');
  }
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
    url.origin === origin
  );
}

function isConnectMessage(value, token) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (
    value.schema === BRIDGE_SCHEMA &&
    value.version === BRIDGE_VERSION &&
    value.type === 'connect' &&
    value.token === token
  );
}

export function createPdfViewerBridge({ token, parent }) {
  if (!TOKEN_PATTERN.test(token) || !parent || typeof parent.postMessage !== 'function') {
    throw new TypeError('Invalid PDF viewer bridge configuration');
  }

  let application = null;
  let eventBus = null;
  let applicationGeneration = 0;
  let initializedApplication = null;
  let observedFirstPagePromise = null;
  let applicationInitialized = false;
  let documentLoaded = false;
  let firstPageResolved = false;
  let documentLoadedListener = null;
  let documentErrorListener = null;
  let trustedParentOrigin = null;
  let terminalMessage = null;
  let disposed = false;

  const postTerminal = () => {
    if (disposed || !terminalMessage || !trustedParentOrigin) return;
    parent.postMessage(terminalMessage, trustedParentOrigin);
  };

  const settleReady = (pageCount, generation) => {
    if (
      disposed ||
      terminalMessage ||
      generation !== applicationGeneration ||
      !isPositiveSafeInteger(pageCount)
    ) {
      return;
    }
    terminalMessage = {
      schema: BRIDGE_SCHEMA,
      version: BRIDGE_VERSION,
      type: 'ready',
      token,
      pageCount,
    };
    postTerminal();
  };

  const settleError = (reason, generation) => {
    if (disposed || terminalMessage || generation !== applicationGeneration) return;
    terminalMessage = {
      schema: BRIDGE_SCHEMA,
      version: BRIDGE_VERSION,
      type: 'error',
      token,
      reason,
    };
    postTerminal();
  };

  const maybeSettleReady = (generation) => {
    if (
      disposed ||
      terminalMessage ||
      generation !== applicationGeneration ||
      !applicationInitialized ||
      !documentLoaded ||
      !firstPageResolved
    ) {
      return;
    }
    settleReady(application.pdfDocument?.numPages, generation);
  };

  const awaitFirstPage = (generation) => {
    if (disposed || terminalMessage || generation !== applicationGeneration || !application) return;
    const pageCount = application.pdfDocument?.numPages;
    const firstPagePromise = application.pdfViewer?.firstPagePromise;
    if (!isPositiveSafeInteger(pageCount) || !firstPagePromise) return;
    if (observedFirstPagePromise === firstPagePromise) return;
    observedFirstPagePromise = firstPagePromise;
    firstPageResolved = false;
    Promise.resolve(firstPagePromise).then(
      () => {
        if (disposed || generation !== applicationGeneration || !application) return;
        firstPageResolved = true;
        maybeSettleReady(generation);
      },
      () => settleError('first-page', generation),
    );
  };

  const inspectApplication = (generation) => {
    if (disposed || terminalMessage || generation !== applicationGeneration || !application) return;
    if (initializedApplication !== application) {
      initializedApplication = application;
      const initializingApplication = application;
      Promise.resolve(initializingApplication.initializedPromise).then(
        () => {
          if (generation !== applicationGeneration || application !== initializingApplication) {
            return;
          }
          applicationInitialized = true;
          observeApplication(initializingApplication);
          awaitFirstPage(generation);
          maybeSettleReady(generation);
        },
        () => settleError('initialization', generation),
      );
    }
    if (application.pdfDocument) awaitFirstPage(generation);
    maybeSettleReady(generation);
  };

  const observeApplication = (nextApplication) => {
    if (disposed || terminalMessage || !nextApplication || typeof nextApplication !== 'object') {
      return;
    }
    if (application !== nextApplication) {
      eventBus?.off?.('documentloaded', documentLoadedListener);
      eventBus?.off?.('documenterror', documentErrorListener);
      application = nextApplication;
      eventBus = null;
      applicationGeneration += 1;
      initializedApplication = null;
      observedFirstPagePromise = null;
      applicationInitialized = false;
      documentLoaded = false;
      firstPageResolved = false;
      documentLoadedListener = null;
      documentErrorListener = null;
    }
    const nextEventBus = application.eventBus ?? null;
    if (eventBus !== nextEventBus) {
      eventBus?.off?.('documentloaded', documentLoadedListener);
      eventBus?.off?.('documenterror', documentErrorListener);
      eventBus = nextEventBus;
      documentLoadedListener = null;
      documentErrorListener = null;
      if (eventBus) {
        const generation = applicationGeneration;
        const observedApplication = application;
        documentLoadedListener = () => {
          if (
            disposed ||
            generation !== applicationGeneration ||
            application !== observedApplication
          ) {
            return;
          }
          documentLoaded = true;
          awaitFirstPage(generation);
          maybeSettleReady(generation);
        };
        documentErrorListener = () => {
          if (
            disposed ||
            generation !== applicationGeneration ||
            application !== observedApplication
          ) {
            return;
          }
          settleError('document', generation);
        };
        eventBus.on?.('documentloaded', documentLoadedListener);
        eventBus.on?.('documenterror', documentErrorListener);
      }
    }
    inspectApplication(applicationGeneration);
  };

  const receiveMessage = (event) => {
    if (
      disposed ||
      event?.source !== parent ||
      !isTrustedParentOrigin(event.origin) ||
      !isConnectMessage(event.data, token)
    ) {
      return;
    }
    if (trustedParentOrigin && trustedParentOrigin !== event.origin) return;
    trustedParentOrigin = event.origin;
    postTerminal();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    eventBus?.off?.('documentloaded', documentLoadedListener);
    eventBus?.off?.('documenterror', documentErrorListener);
    application = null;
    eventBus = null;
    documentLoadedListener = null;
    documentErrorListener = null;
  };

  return { observeApplication, receiveMessage, dispose };
}

function installBrowserBridge() {
  if (typeof window === 'undefined' || window.parent === window) return;
  const token = new URL(window.location.href).searchParams.get('bridgeToken');
  if (!token || !TOKEN_PATTERN.test(token)) return;

  const bridge = createPdfViewerBridge({ token, parent: window.parent });
  const observeCurrentApplication = () => {
    bridge.observeApplication(window.PDFViewerApplication);
  };
  const receiveMessage = (event) => bridge.receiveMessage(event);
  window.addEventListener('message', receiveMessage);
  document.addEventListener('webviewerloaded', observeCurrentApplication, true);
  const poll = window.setInterval(observeCurrentApplication, APPLICATION_POLL_MS);
  observeCurrentApplication();

  window.addEventListener(
    'pagehide',
    () => {
      window.clearInterval(poll);
      window.removeEventListener('message', receiveMessage);
      document.removeEventListener('webviewerloaded', observeCurrentApplication, true);
      bridge.dispose();
    },
    { once: true },
  );
}

installBrowserBridge();
