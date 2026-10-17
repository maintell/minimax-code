/**
 * PPT Preview WebContentsView Controller
 * Renders qlmanage-generated HTML previews in a WebContentsView overlay.
 * Follows the same singleton + overlay pattern as OpenClawViewController.
 */
import { WebContentsView } from "electron";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { IPC_CHANNELS } from "../../config/constants";
import logger from "../../utils/logger";
import { resolvePptSelectionElementFromSidecar } from "./element-map";
import { buildPPTSelectionBridgeScript } from "./selection-bridge";
const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const MAX_SELECTION_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 1000;
const MAX_TEXT_LENGTH = 4000;
const MAX_DOM_PATH_LENGTH = 1000;
const SELECTION_SCREENSHOT_PADDING = 48;
export let PPT_PREVIEW_PARTITION = 'mavis-ppt-preview';
const PPT_PREVIEW_LAYOUT_SCRIPT = `
(function() {
  var rafId = 0;
  var stage = null;
  var MAX_FIT_SCALE = 4;

  function ensureViewportMeta() {
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'viewport';
      (document.head || document.documentElement).appendChild(meta);
    }
    meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=4.0');
  }

  function ensureStage() {
    if (stage && document.body.contains(stage)) return stage;
    stage = document.getElementById('mavis-ppt-stage');
    if (stage) return stage;

    stage = document.createElement('div');
    stage.id = 'mavis-ppt-stage';
    while (document.body.firstChild) {
      stage.appendChild(document.body.firstChild);
    }
    document.body.appendChild(stage);
    return stage;
  }

  function resetLayout() {
    var currentStage = ensureStage();
    currentStage.style.transform = '';
    currentStage.style.width = '';
    document.body.style.width = '';
    document.body.style.height = '';
    document.documentElement.style.height = '';
  }

  function getSlideRects() {
    var slides = Array.prototype.slice.call(ensureStage().querySelectorAll('.slide'));
    return slides
      .map(function(slide) { return slide.getBoundingClientRect(); })
      .filter(function(rect) { return rect.width > 0 && rect.height > 0; });
  }

  function fitScaleFor(viewportWidth, contentWidth) {
    var scale = viewportWidth / Math.max(1, contentWidth);
    if (!Number.isFinite(scale) || scale <= 0) return 1;
    return Math.min(MAX_FIT_SCALE, scale);
  }

  function fitBody() {
    var currentStage = ensureStage();
    var contentWidth = Math.max(1, currentStage.scrollWidth);
    var viewportWidth = Math.max(1, window.innerWidth);
    var scale = fitScaleFor(viewportWidth, contentWidth);
    var height = Math.ceil(currentStage.scrollHeight * scale);
    currentStage.style.width = contentWidth + 'px';
    currentStage.style.transform = 'scale(' + scale + ')';
    document.body.style.width = viewportWidth + 'px';
    document.body.style.height = height + 'px';
    document.documentElement.style.height = height + 'px';
  }

  function fitNow() {
    rafId = 0;
    ensureViewportMeta();
    resetLayout();

    var currentStage = ensureStage();
    var rects = getSlideRects();
    if (!rects.length) {
      fitBody();
      return;
    }

    var stageRect = currentStage.getBoundingClientRect();
    var minLeft = rects.reduce(function(value, rect) {
      return Math.min(value, rect.left);
    }, rects[0].left);
    var maxRight = rects.reduce(function(value, rect) {
      return Math.max(value, rect.right);
    }, rects[0].right);
    var contentLeft = Math.max(0, Math.floor(minLeft - stageRect.left));
    var contentRight = Math.max(contentLeft + 1, Math.ceil(maxRight - stageRect.left));
    var contentWidth = Math.max(1, contentRight - contentLeft);
    var viewportWidth = Math.max(1, window.innerWidth);
    var scale = fitScaleFor(viewportWidth, contentWidth);
    var height = Math.ceil(currentStage.scrollHeight * scale);

    currentStage.style.width = contentRight + 'px';
    currentStage.style.transform = 'translateX(' + (-contentLeft) + 'px) scale(' + scale + ')';
    document.body.style.width = viewportWidth + 'px';
    document.body.style.height = height + 'px';
    document.documentElement.style.height = height + 'px';
  }

  function fit() {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
    }
    rafId = window.requestAnimationFrame(fitNow);
  }
  window.addEventListener('resize', fit);
  fit();
  window.setTimeout(fit, 80);
  window.setTimeout(fit, 300);
})();`;
function isAllowedPreviewResourceUrl(value, localRoot) {
    try {
        const resourceUrl = new URL(value);
        if (resourceUrl.protocol === 'data:' || resourceUrl.protocol === 'blob:')
            return true;
        if (resourceUrl.protocol === 'about:')
            return resourceUrl.toString() === 'about:blank';
        if (resourceUrl.protocol !== 'file:' || !localRoot)
            return false;
        const relativePath = path.relative(localRoot, fileURLToPath(resourceUrl));
        return (relativePath === '' ||
            (!path.isAbsolute(relativePath) &&
                relativePath !== '..' &&
                !relativePath.startsWith(`..${path.sep}`)));
    }
    catch {
        return false;
    }
}
function safePreviewError(value, fallback) {
    const message = String(value);
    if (message.length > 1024 ||
        /[/\\<\u0000-\u001f\u007f-\u009f]/u.test(message) ||
        /(?:file|data):/iu.test(message)) {
        return fallback;
    }
    return message;
}
function elapsedMs(startMs) {
    return Date.now() - startMs;
}
function isTruthyDebugValue(value) {
    return /^(1|true|yes|on)$/iu.test(String(value ?? '').trim());
}
function isPptPreviewDebugEnabled() {
    return (isTruthyDebugValue(process.env.MAVIS_PPT_DEBUG) ||
        isTruthyDebugValue(process.env.MAVIS_PPT_PREVIEW_DEBUG) ||
        isTruthyDebugValue(process.env.MAVIS_PPT_SELECTION_DEBUG));
}
function logPreviewTiming(stage, data) {
    if (!isPptPreviewDebugEnabled())
        return;
    const redacted = Object.fromEntries(Object.entries(data).map(([key, value]) => [
        key,
        typeof value === 'string' ? safePreviewError(value, '[redacted-sensitive-value]') : value,
    ]));
    logger.info({ msg: '[PPTPreviewTiming]', stage, ...redacted });
}
function logPptSelectionDebug(data) {
    if (!isPptPreviewDebugEnabled())
        return;
    logger.info(data);
}
function limitText(value, maxLength) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}
function finiteNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}
function normalizeRect(value, maxBounds) {
    if (!value || typeof value !== 'object')
        return null;
    const input = value;
    const x = finiteNumber(input.x);
    const y = finiteNumber(input.y);
    const width = finiteNumber(input.width);
    const height = finiteNumber(input.height);
    if (x === null || y === null || width === null || height === null)
        return null;
    if (width <= 0 || height <= 0)
        return null;
    const maxWidth = maxBounds?.width ?? 100000;
    const maxHeight = maxBounds?.height ?? 100000;
    const clampedX = Math.min(Math.max(0, x), Math.max(0, maxWidth - 1));
    const clampedY = Math.min(Math.max(0, y), Math.max(0, maxHeight - 1));
    const clampedWidth = Math.min(width, Math.max(1, maxWidth - clampedX));
    const clampedHeight = Math.min(height, Math.max(1, maxHeight - clampedY));
    return {
        x: Math.round(clampedX * 100) / 100,
        y: Math.round(clampedY * 100) / 100,
        width: Math.round(clampedWidth * 100) / 100,
        height: Math.round(clampedHeight * 100) / 100,
    };
}
function normalizeSize(value) {
    if (!value || typeof value !== 'object')
        return null;
    const input = value;
    const width = finiteNumber(input.width);
    const height = finiteNumber(input.height);
    if (width === null || height === null || width <= 0 || height <= 0)
        return null;
    return {
        width: Math.round(width * 100) / 100,
        height: Math.round(height * 100) / 100,
    };
}
function summarizeSelectionPayloadForDebug(payload) {
    if (!payload || typeof payload !== 'object')
        return payload;
    const input = payload;
    const selection = input.selection && typeof input.selection === 'object'
        ? input.selection
        : null;
    return {
        instruction: limitText(input.instruction, MAX_INSTRUCTION_LENGTH),
        slideIndex: input.slideIndex,
        slideNumber: input.slideNumber,
        slideSize: input.slideSize,
        selection: selection
            ? {
                kind: selection.kind,
                viewportRect: selection.viewportRect,
                slideRect: selection.slideRect,
                text: limitText(selection.text, MAX_TEXT_LENGTH),
                domPath: limitText(selection.domPath, MAX_DOM_PATH_LENGTH),
            }
            : null,
    };
}
function summarizeSelectionEventForDebug(event) {
    return {
        schema: event.schema,
        contextId: event.contextId,
        eventId: event.eventId,
        fileName: event.fileName,
        filePath: event.filePath,
        mimeType: event.mimeType,
        slideIndex: event.slideIndex,
        slideNumber: event.slideNumber,
        slideSize: event.slideSize,
        instruction: event.instruction,
        selection: event.selection,
        screenshot: {
            fileName: event.screenshotFileName,
            hasDataUrl: Boolean(event.screenshotDataUrl),
            dataUrlLength: event.screenshotDataUrl?.length ?? 0,
        },
        elementMapLookup: event.elementMapLookup,
        resolvedElement: event.resolvedElement
            ? {
                elementId: event.resolvedElement.elementId,
                confidence: event.resolvedElement.confidence,
                score: event.resolvedElement.score,
                kind: event.resolvedElement.kind,
                role: event.resolvedElement.role,
                matchReasons: event.resolvedElement.matchReasons,
            }
            : null,
        createdAtMs: event.createdAtMs,
    };
}
class PPTPreviewViewController {
    constructor() {
        this.webContentsView = null;
        this.parentWindow = null;
        this.lastRequestedBounds = {
            x: -10000,
            y: -10000,
            width: 1,
            height: 1,
        };
        this.lastRendererViewport = null;
        this.lastBounds = { x: -10000, y: -10000, width: 1, height: 1 };
        this.currentHtmlFilePath = null;
        this.pendingHtmlUrl = null;
        this.currentFilePath = null;
        this.currentFileName = null;
        this.currentMimeType = PPTX_MIME_TYPE;
        this.selectionToken = '';
        this.selectionEventSeq = 0;
        this.selectionEvents = [];
    }
    get contentView() {
        if (!this.parentWindow || this.parentWindow.isDestroyed())
            return null;
        return this.parentWindow.contentView ?? null;
    }
    /**
     * Check whether the current view is still valid (not destroyed).
     */
    isViewValid() {
        if (!this.webContentsView)
            return false;
        try {
            // Accessing webContents on a destroyed view throws
            return !this.webContentsView.webContents.isDestroyed();
        }
        catch {
            return false;
        }
    }
    isOwnedBy(sender) {
        if (!this.isViewValid() || !this.parentWindow || this.parentWindow.isDestroyed()) {
            return false;
        }
        try {
            return this.parentWindow.webContents === sender && !sender.isDestroyed();
        }
        catch {
            return false;
        }
    }
    isExpectedTopLevelNavigation(url) {
        if (url === this.pendingHtmlUrl)
            return true;
        return Boolean(this.currentHtmlFilePath && pathToFileURL(this.currentHtmlFilePath).toString() === url);
    }
    getAllowedResourceRoot() {
        if (this.pendingHtmlUrl) {
            try {
                return path.dirname(fileURLToPath(this.pendingHtmlUrl));
            }
            catch {
                return null;
            }
        }
        return this.currentHtmlFilePath ? path.dirname(this.currentHtmlFilePath) : null;
    }
    configureSecurityBoundary(view) {
        const webContents = view.webContents;
        webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const denyUnexpectedNavigation = (event, url) => {
            if (!this.isExpectedTopLevelNavigation(url))
                event.preventDefault();
        };
        webContents.on('will-navigate', denyUnexpectedNavigation);
        webContents.on('will-redirect', denyUnexpectedNavigation);
        webContents.on('will-attach-webview', (event) => event.preventDefault());
        const previewSession = webContents.session;
        previewSession.setPermissionCheckHandler(() => false);
        previewSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
            callback(false);
        });
        previewSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback({
            cancel: !isAllowedPreviewResourceUrl(details.url, this.getAllowedResourceRoot()),
        }));
    }
    bindOwnerLifecycle(window) {
        const owner = window.webContents;
        owner.once('destroyed', () => {
            if (this.parentWindow?.webContents !== owner)
                return;
            this.destroy();
        });
    }
    safeRemoveFromContentView(view) {
        if (!this.contentView)
            return;
        try {
            const children = this.contentView.children;
            if (children.includes(view)) {
                this.contentView.removeChildView(view);
            }
        }
        catch (error) {
            logger.error({
                msg: '[PPTPreview] Failed to remove from contentView',
                error: safePreviewError(error, 'PPT preview view removal failed'),
            });
        }
    }
    safeAddToContentView(view) {
        if (!this.contentView)
            return;
        try {
            const children = this.contentView.children;
            if (!children.includes(view)) {
                this.contentView.addChildView(view);
            }
        }
        catch (error) {
            logger.error({
                msg: '[PPTPreview] Failed to add to contentView',
                error: safePreviewError(error, 'PPT preview view attachment failed'),
            });
        }
    }
    getFileName() {
        if (this.currentFileName)
            return this.currentFileName;
        if (this.currentFilePath)
            return path.basename(this.currentFilePath);
        return 'presentation.pptx';
    }
    ensureSelectionToken() {
        if (!this.selectionToken) {
            this.selectionToken = randomUUID();
        }
        return this.selectionToken;
    }
    buildCaptureRect(rect) {
        const maxBounds = this.lastBounds.width > 1 && this.lastBounds.height > 1
            ? { width: this.lastBounds.width, height: this.lastBounds.height }
            : undefined;
        return normalizeRect({
            x: rect.x - SELECTION_SCREENSHOT_PADDING,
            y: rect.y - SELECTION_SCREENSHOT_PADDING,
            width: rect.width + SELECTION_SCREENSHOT_PADDING * 2,
            height: rect.height + SELECTION_SCREENSHOT_PADDING * 2,
        }, maxBounds);
    }
    getHostZoomFactor() {
        if (!this.parentWindow || this.parentWindow.isDestroyed())
            return 1;
        const factor = this.parentWindow.webContents.getZoomFactor();
        return Number.isFinite(factor) && factor > 0 ? factor : 1;
    }
    getRendererToNativeScale(viewport) {
        const contentBounds = this.parentWindow?.isDestroyed()
            ? null
            : this.parentWindow?.getContentBounds();
        const viewportHeight = finiteNumber(viewport?.visualViewport?.height) ?? finiteNumber(viewport?.height);
        if (contentBounds && viewportHeight !== null && viewportHeight > 0) {
            const viewportScale = contentBounds.height / viewportHeight;
            if (Number.isFinite(viewportScale) && viewportScale > 0.25 && viewportScale <= 1.05) {
                return viewportScale;
            }
        }
        const zoomFactor = this.getHostZoomFactor();
        if (zoomFactor !== 1)
            return 1 / zoomFactor;
        return 1;
    }
    toNativeBounds(bounds, viewport) {
        const scale = this.getRendererToNativeScale(viewport);
        if (scale === 1)
            return bounds;
        return {
            x: bounds.x * scale,
            y: bounds.y * scale,
            width: bounds.width * scale,
            height: bounds.height * scale,
        };
    }
    normalizeBounds(bounds, viewport) {
        const nativeBounds = this.toNativeBounds(bounds, viewport);
        if (nativeBounds.x < 0 || nativeBounds.y < 0) {
            return {
                x: Math.round(nativeBounds.x),
                y: Math.round(nativeBounds.y),
                width: Math.max(1, Math.round(nativeBounds.width)),
                height: Math.max(1, Math.round(nativeBounds.height)),
            };
        }
        const contentBounds = this.parentWindow?.isDestroyed()
            ? null
            : this.parentWindow?.getContentBounds();
        const maxWidth = Math.max(1, contentBounds?.width ?? nativeBounds.x + nativeBounds.width);
        const maxHeight = Math.max(1, contentBounds?.height ?? nativeBounds.y + nativeBounds.height);
        const x = Math.min(Math.max(0, Math.round(nativeBounds.x)), maxWidth - 1);
        const y = Math.min(Math.max(0, Math.round(nativeBounds.y)), maxHeight - 1);
        const width = Math.max(1, Math.min(Math.round(nativeBounds.width), maxWidth - x));
        const height = Math.max(1, Math.min(Math.round(nativeBounds.height), maxHeight - y));
        return { x, y, width, height };
    }
    async captureSelectionDataUrl(rect) {
        const view = this.webContentsView;
        if (!this.isViewValid() || !view)
            return undefined;
        const captureRect = this.buildCaptureRect(rect);
        if (!captureRect)
            return undefined;
        try {
            const image = await view.webContents.capturePage({
                x: Math.floor(captureRect.x),
                y: Math.floor(captureRect.y),
                width: Math.ceil(captureRect.width),
                height: Math.ceil(captureRect.height),
            });
            if (image.isEmpty())
                return undefined;
            return image.toDataURL();
        }
        catch (error) {
            logger.warn({
                msg: '[PPTPreview] capture selection failed',
                error: safePreviewError(error, 'PPT preview selection capture failed'),
            });
            return undefined;
        }
    }
    normalizeSelectionEventPayload(payload) {
        if (!payload || typeof payload !== 'object')
            return null;
        const input = payload;
        const selection = input.selection;
        if (!selection || typeof selection !== 'object')
            return null;
        const instruction = limitText(input.instruction, MAX_INSTRUCTION_LENGTH);
        if (!instruction)
            return null;
        const slideIndexRaw = finiteNumber(input.slideIndex);
        const slideNumberRaw = finiteNumber(input.slideNumber);
        const slideIndex = slideIndexRaw !== null && slideIndexRaw >= 0 ? Math.floor(slideIndexRaw) : null;
        const slideNumber = slideNumberRaw !== null && slideNumberRaw >= 1
            ? Math.floor(slideNumberRaw)
            : slideIndex !== null
                ? slideIndex + 1
                : null;
        if (slideIndex === null || slideNumber === null)
            return null;
        const slideSize = normalizeSize(input.slideSize);
        const viewportRect = normalizeRect(selection.viewportRect, {
            width: Math.max(1, this.lastBounds.width),
            height: Math.max(1, this.lastBounds.height),
        });
        const slideRect = normalizeRect(selection.slideRect);
        if (!slideSize || !viewportRect || !slideRect)
            return null;
        const createdAtMs = Date.now();
        const eventId = ++this.selectionEventSeq;
        const contextId = `ppt-selection-${eventId}-${createdAtMs}`;
        const screenshotFileName = `ppt-selection-slide-${String(slideNumber).padStart(3, '0')}-${eventId}.png`;
        const domPath = limitText(selection.domPath, MAX_DOM_PATH_LENGTH);
        const baseEvent = {
            schema: 'mavis.ppt_preview_selection.v1',
            contextId,
            eventId,
            fileName: this.getFileName(),
            ...(this.currentFilePath ? { filePath: this.currentFilePath } : {}),
            mimeType: this.currentMimeType,
            slideIndex,
            slideNumber,
            slideSize,
            selection: {
                kind: 'rect',
                viewportRect,
                slideRect,
                text: limitText(selection.text, MAX_TEXT_LENGTH),
                ...(domPath ? { domPath } : {}),
            },
            instruction,
            screenshotFileName,
            createdAtMs,
        };
        const elementResolution = resolvePptSelectionElementFromSidecar(baseEvent);
        return {
            ...baseEvent,
            ...(elementResolution.elementMapLookup.attempted
                ? { elementMapLookup: elementResolution.elementMapLookup }
                : {}),
            ...(elementResolution.resolvedElement
                ? { resolvedElement: elementResolution.resolvedElement }
                : {}),
        };
    }
    async handleSelectionBridgeEvent(sender, envelope) {
        const view = this.webContentsView;
        if (!this.isViewValid() || !view || sender !== view.webContents) {
            return { success: false, error: 'Invalid PPT preview event sender' };
        }
        if (!envelope || typeof envelope !== 'object') {
            return { success: false, error: 'Invalid PPT preview event envelope' };
        }
        const message = envelope;
        if (message.token !== this.selectionToken || message.type !== 'selection-submitted') {
            logPptSelectionDebug({
                msg: '[PPTSelectionDebug] rejected bridge envelope',
                tokenMatched: message.token === this.selectionToken,
                type: message.type,
                currentFilePath: this.currentFilePath,
                currentFileName: this.currentFileName,
            });
            return { success: false, error: 'Invalid PPT preview selection token or type' };
        }
        logPptSelectionDebug({
            msg: '[PPTSelectionDebug] bridge envelope received',
            type: message.type,
            currentFilePath: this.currentFilePath,
            currentFileName: this.currentFileName,
            payload: summarizeSelectionPayloadForDebug(message.payload),
        });
        const normalized = this.normalizeSelectionEventPayload(message.payload);
        if (!normalized)
            return { success: false, error: 'Invalid PPT preview selection payload' };
        logPptSelectionDebug({
            msg: '[PPTSelectionDebug] normalized selection event',
            event: summarizeSelectionEventForDebug(normalized),
        });
        const screenshotDataUrl = await this.captureSelectionDataUrl(normalized.selection.viewportRect);
        const event = screenshotDataUrl ? { ...normalized, screenshotDataUrl } : normalized;
        this.selectionEvents.push(event);
        if (this.selectionEvents.length > MAX_SELECTION_EVENTS) {
            this.selectionEvents.splice(0, this.selectionEvents.length - MAX_SELECTION_EVENTS);
        }
        logPptSelectionDebug({
            msg: '[PPTSelectionDebug] queued selection event',
            queueLength: this.selectionEvents.length,
            event: summarizeSelectionEventForDebug(event),
        });
        if (this.parentWindow && !this.parentWindow.isDestroyed()) {
            this.parentWindow.webContents.send(IPC_CHANNELS.PPT_PREVIEW_SELECTION_EVENT, event);
            logPptSelectionDebug({
                msg: '[PPTSelectionDebug] dispatched selection event to renderer',
                eventId: event.eventId,
                contextId: event.contextId,
                fileName: event.fileName,
                slideNumber: event.slideNumber,
            });
        }
        return { success: true };
    }
    /**
     * Create the WebContentsView and attach it to the window.
     * Idempotent: returns success if already created and valid.
     */
    async create(window, bounds, viewport) {
        try {
            if (window.isDestroyed()) {
                return { success: false, error: 'Window is destroyed' };
            }
            if (this.isViewValid() && this.parentWindow && this.parentWindow !== window) {
                return { success: false, error: 'PPT preview is owned by another renderer' };
            }
            if (this.parentWindow && this.parentWindow !== window) {
                this.destroy();
            }
            this.parentWindow = window;
            // Idempotent: already created and valid
            if (this.isViewValid() && this.webContentsView) {
                const view = this.webContentsView;
                this.lastRequestedBounds = bounds;
                this.lastRendererViewport = viewport ?? null;
                const normalizedBounds = this.normalizeBounds(bounds, viewport);
                this.lastBounds = normalizedBounds;
                view.setBounds(normalizedBounds);
                return { success: true };
            }
            // Clean up stale view if exists but invalid
            if (this.webContentsView) {
                this.safeRemoveFromContentView(this.webContentsView);
                this.webContentsView = null;
            }
            // The preload is the dedicated selection-only bridge compiled next to
            // this controller. The non-persistent partition is isolated from the
            // application renderer and every other embedded surface.
            const preloadPath = path.join(__dirname, 'preload.js');
            this.webContentsView = new WebContentsView({
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    sandbox: true,
                    webSecurity: true,
                    allowRunningInsecureContent: false,
                    partition: PPT_PREVIEW_PARTITION,
                    preload: preloadPath,
                },
            });
            this.configureSecurityBoundary(this.webContentsView);
            this.bindOwnerLifecycle(window);
            this.lastRequestedBounds = bounds;
            this.lastRendererViewport = viewport ?? null;
            const normalizedBounds = this.normalizeBounds(bounds, viewport);
            this.lastBounds = normalizedBounds;
            this.webContentsView.setBounds(normalizedBounds);
            this.safeAddToContentView(this.webContentsView);
            logger.info('[PPTPreview] WebContentsView created');
            return { success: true };
        }
        catch (error) {
            const publicError = safePreviewError(error, 'PPT preview view creation failed');
            logger.error({ msg: '[PPTPreview] Failed to create view', error: publicError });
            if (this.webContentsView) {
                this.safeRemoveFromContentView(this.webContentsView);
                try {
                    this.webContentsView.webContents.close();
                }
                catch {
                    // The partially initialized WebContents may already be destroyed.
                }
            }
            this.webContentsView = null;
            this.parentWindow = null;
            return { success: false, error: publicError };
        }
    }
    /**
     * Load processed HTML into the WebContentsView.
     * @param htmlFilePath Absolute path to the processed HTML file.
     */
    async loadHTML(htmlFilePath, context = {}) {
        const startMs = Date.now();
        if (!this.isViewValid()) {
            logPreviewTiming('webcontents-load:error', {
                htmlFilePath,
                filePath: context.filePath,
                totalMs: elapsedMs(startMs),
                error: 'WebContentsView not created or destroyed',
            });
            return { success: false, error: 'WebContentsView not created or destroyed' };
        }
        const view = this.webContentsView;
        if (!view) {
            logPreviewTiming('webcontents-load:error', {
                htmlFilePath,
                filePath: context.filePath,
                totalMs: elapsedMs(startMs),
                error: 'WebContentsView not created or destroyed',
            });
            return { success: false, error: 'WebContentsView not created or destroyed' };
        }
        try {
            logPreviewTiming('webcontents-load:start', {
                htmlFilePath,
                filePath: context.filePath,
                slideCount: context.slideCount,
            });
            this.currentFilePath = context.filePath ?? null;
            this.currentFileName =
                context.fileName ?? (context.filePath ? path.basename(context.filePath) : null);
            this.currentMimeType = context.mimeType ?? PPTX_MIME_TYPE;
            this.selectionEvents = [];
            const normalizedHtmlFilePath = path.resolve(htmlFilePath);
            const fileUrl = pathToFileURL(normalizedHtmlFilePath).toString();
            if (this.currentHtmlFilePath === normalizedHtmlFilePath &&
                !view.webContents.isLoading() &&
                view.webContents.getURL() === fileUrl) {
                logger.info('[PPTPreview] Reused loaded HTML');
                logPreviewTiming('webcontents-load:skipped', {
                    htmlFilePath: normalizedHtmlFilePath,
                    filePath: context.filePath,
                    slideCount: context.slideCount,
                    totalMs: elapsedMs(startMs),
                });
                return { success: true };
            }
            this.selectionToken = randomUUID();
            this.pendingHtmlUrl = fileUrl;
            try {
                await view.webContents.loadURL(fileUrl);
                await view.webContents.executeJavaScript(PPT_PREVIEW_LAYOUT_SCRIPT, true);
            }
            finally {
                if (this.pendingHtmlUrl === fileUrl)
                    this.pendingHtmlUrl = null;
            }
            this.currentHtmlFilePath = normalizedHtmlFilePath;
            logger.info('[PPTPreview] Loaded HTML');
            logPreviewTiming('webcontents-load:success', {
                htmlFilePath: normalizedHtmlFilePath,
                filePath: context.filePath,
                slideCount: context.slideCount,
                totalMs: elapsedMs(startMs),
            });
            return { success: true };
        }
        catch (error) {
            const publicError = safePreviewError(error, 'PPT preview HTML load failed');
            logger.error({ msg: '[PPTPreview] Failed to load HTML', error: publicError });
            logPreviewTiming('webcontents-load:error', {
                htmlFilePath,
                filePath: context.filePath,
                slideCount: context.slideCount,
                totalMs: elapsedMs(startMs),
                error: publicError,
            });
            return { success: false, error: publicError };
        }
    }
    /**
     * Update view bounds. Silent no-op if view doesn't exist.
     */
    setBounds(bounds, viewport) {
        if (!this.webContentsView)
            return { success: true };
        try {
            this.lastRequestedBounds = bounds;
            this.lastRendererViewport = viewport ?? null;
            const normalizedBounds = this.normalizeBounds(bounds, viewport);
            this.lastBounds = normalizedBounds;
            this.webContentsView.setBounds(normalizedBounds);
            return { success: true, bounds: normalizedBounds };
        }
        catch (error) {
            const publicError = safePreviewError(error, 'PPT preview bounds update failed');
            logger.error({ msg: '[PPTPreview] Failed to setBounds', error: publicError });
            return { success: false, error: publicError };
        }
    }
    async getDebugState() {
        const view = this.webContentsView;
        if (!this.isViewValid() || !view) {
            return { success: false, error: 'WebContentsView not created or destroyed' };
        }
        const contentBounds = this.parentWindow?.isDestroyed()
            ? null
            : this.parentWindow?.getContentBounds();
        let viewBounds = null;
        try {
            viewBounds = view.getBounds();
        }
        catch {
            viewBounds = null;
        }
        const quickLook = await view.webContents
            .executeJavaScript(`(() => {
          const rect = (value) => value ? {
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
            top: value.top,
            right: value.right,
            bottom: value.bottom,
            left: value.left,
          } : null;
          const stage = document.getElementById('mavis-ppt-stage');
          const slides = Array.from(document.querySelectorAll('.slide')).slice(0, 5);
          const markerMatch = document.documentElement.innerHTML.match(/mavis-ppt-preview-processor:(\\d+)/);
          return {
            url: window.location.href,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            devicePixelRatio: window.devicePixelRatio,
            bodyScrollWidth: document.body ? document.body.scrollWidth : null,
            bodyScrollHeight: document.body ? document.body.scrollHeight : null,
            documentScrollWidth: document.documentElement ? document.documentElement.scrollWidth : null,
            documentScrollHeight: document.documentElement ? document.documentElement.scrollHeight : null,
            bodyRect: rect(document.body && document.body.getBoundingClientRect()),
            stageRect: rect(stage && stage.getBoundingClientRect()),
            stageStyleWidth: stage ? stage.style.width : null,
            stageTransform: stage ? window.getComputedStyle(stage).transform : null,
            slideCount: document.querySelectorAll('.slide').length,
            slideRects: slides.map((slide, index) => ({
              index,
              rect: rect(slide.getBoundingClientRect()),
              styleTop: slide.style.top || null,
              styleLeft: slide.style.left || null,
              computedMarginTop: window.getComputedStyle(slide).marginTop,
              computedMarginLeft: window.getComputedStyle(slide).marginLeft,
              computedBoxShadow: window.getComputedStyle(slide).boxShadow,
            })),
            processorMarker: markerMatch ? markerMatch[1] : null,
          };
        })();`, true)
            .catch((error) => ({
            error: safePreviewError(error, 'PPT preview frame execution failed'),
        }));
        const debug = {
            currentFilePath: this.currentFilePath,
            currentFileName: this.currentFileName,
            hostZoomFactor: this.getHostZoomFactor(),
            rendererToNativeScale: this.getRendererToNativeScale(this.lastRendererViewport ?? undefined),
            lastRequestedBounds: this.lastRequestedBounds,
            lastRendererViewport: this.lastRendererViewport,
            lastBounds: this.lastBounds,
            viewBounds,
            contentBounds,
            webContents: {
                url: view.webContents.getURL(),
                isLoading: view.webContents.isLoading(),
                isDestroyed: view.webContents.isDestroyed(),
            },
            quickLook,
        };
        if (isPptPreviewDebugEnabled()) {
            logger.info({ msg: '[PPTPreviewDebug] getDebugState', debug });
        }
        return { success: true, debug };
    }
    async setSelectionMode(options) {
        if (!this.isViewValid()) {
            return { success: false, error: 'WebContentsView not created or destroyed' };
        }
        const view = this.webContentsView;
        if (!view) {
            return { success: false, error: 'WebContentsView not created or destroyed' };
        }
        if (options.filePath) {
            this.currentFilePath = options.filePath;
            this.currentFileName = options.fileName || path.basename(options.filePath);
        }
        else if (options.fileName) {
            this.currentFileName = options.fileName;
        }
        if (options.mimeType) {
            this.currentMimeType = options.mimeType;
        }
        const token = this.ensureSelectionToken();
        try {
            await view.webContents.executeJavaScript(buildPPTSelectionBridgeScript({
                enabled: options.enabled,
                token,
                placeholder: options.placeholder,
            }), true);
            return { success: true };
        }
        catch (error) {
            const publicError = safePreviewError(error, 'PPT preview selection mode failed');
            logger.warn({ msg: '[PPTPreview] set selection mode failed', error: publicError });
            return { success: false, error: publicError };
        }
    }
    async clearSelection() {
        this.selectionEvents = [];
        const view = this.webContentsView;
        if (!this.isViewValid() || !view)
            return { success: true };
        try {
            await view.webContents.executeJavaScript('window.__mavisPptSelectionBridge && window.__mavisPptSelectionBridge.clear && window.__mavisPptSelectionBridge.clear(); true;', true);
            return { success: true };
        }
        catch (error) {
            const publicError = safePreviewError(error, 'PPT preview selection clear failed');
            logger.warn({ msg: '[PPTPreview] clear selection failed', error: publicError });
            return { success: false, error: publicError };
        }
    }
    getSelectionEvents() {
        const events = this.selectionEvents;
        this.selectionEvents = [];
        return { success: true, events };
    }
    async captureSelection(rect) {
        const normalized = normalizeRect(rect, {
            width: Math.max(1, this.lastBounds.width),
            height: Math.max(1, this.lastBounds.height),
        });
        if (!normalized)
            return { success: false, error: 'Invalid selection rect' };
        const dataUrl = await this.captureSelectionDataUrl(normalized);
        if (!dataUrl)
            return { success: false, error: 'Capture returned empty image' };
        return { success: true, dataUrl };
    }
    /**
     * Capture the current rendered frame before the native view is parked
     * off-screen for DOM overlays.
     */
    async captureFrame() {
        const view = this.webContentsView;
        if (!this.isViewValid() || !view) {
            return { success: false, error: 'WebContentsView not created or destroyed' };
        }
        try {
            const image = await view.webContents.capturePage();
            if (image.isEmpty()) {
                return { success: false, error: 'Capture returned an empty frame' };
            }
            return { success: true, dataUrl: image.toDataURL() };
        }
        catch (error) {
            const publicError = safePreviewError(error, 'PPT preview frame capture failed');
            logger.error({ msg: '[PPTPreview] Failed to capture frame', error: publicError });
            return { success: false, error: publicError };
        }
    }
    /**
     * Bring view to front by re-adding to contentView.
     */
    bringToFront() {
        if (!this.webContentsView || !this.contentView)
            return;
        this.safeRemoveFromContentView(this.webContentsView);
        this.safeAddToContentView(this.webContentsView);
    }
    /**
     * Destroy the view and clean up.
     */
    destroy() {
        try {
            if (this.webContentsView) {
                this.safeRemoveFromContentView(this.webContentsView);
                try {
                    this.webContentsView.webContents.close();
                }
                catch {
                    // webContents may already be destroyed
                }
                this.webContentsView = null;
            }
            this.parentWindow = null;
            this.selectionEvents = [];
            this.selectionToken = '';
            this.currentHtmlFilePath = null;
            this.pendingHtmlUrl = null;
            this.currentFilePath = null;
            this.currentFileName = null;
            logger.info('[PPTPreview] View destroyed');
            return { success: true };
        }
        catch (error) {
            const publicError = safePreviewError(error, 'PPT preview destroy failed');
            logger.error({ msg: '[PPTPreview] Failed to destroy', error: publicError });
            this.webContentsView = null;
            this.parentWindow = null;
            this.pendingHtmlUrl = null;
            return { success: false, error: publicError };
        }
    }
}
// Module-level singleton
let controllerInstance = null;
export function getPPTPreviewViewController() {
    if (!controllerInstance) {
        controllerInstance = new PPTPreviewViewController();
    }
    return controllerInstance;
}
