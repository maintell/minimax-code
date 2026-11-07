/**
 * Browser Actions
 * 浏览器工具动作实现（所有 Browser Tools 的具体实现）
 */
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import turndown from "turndown";
import { ElementMapManager, abortableDelay, withTimeout, BROWSER_TIMEOUTS, isBrowserOperationInterruption, throwIfAborted, CDPTextInputError } from "@mavis/browser-core";
import { getCategoryLogger } from "../../utils/logger";
import { isBackgroundRenderForegroundClaim } from "./background-browser-render-host";
import { CDPHelper } from "./cdp-helper";
// 页面加载超时时间 (ms)
const PAGE_LOAD_TIMEOUT = 30000;
const SCROLL_BOUNDARY_EPSILON = 1;
const HOVER_SEMANTIC_SAMPLE_DELAY_MS = 160;
const HOVER_SEMANTIC_SAMPLE_COUNT = 6;
const browserInputDiagnosticLogger = getCategoryLogger('archon', 'browser-input');
function isCountOnly(value) {
    return Boolean(value) && /^[\s\d.,+万亿千百kKmMwW]+$/u.test(value);
}
function resolveHoverSemantic(before, after, fallbackText = '') {
    const target = after?.target ?? before?.target;
    const supportingText = target?.supportingText || (isCountOnly(fallbackText.trim()) ? fallbackText.trim() : '');
    if (target?.name && !isCountOnly(target.name)) {
        const source = target.source === 'text' ? 'target-text' : target.source;
        return {
            hovered: true,
            tooltipObserved: false,
            semantic: {
                name: target.name,
                source,
                confidence: source === 'aria-label' || source === 'aria-labelledby' ? 'high' : 'medium',
                supportingText,
            },
        };
    }
    const previousFingerprints = new Set((before?.nearby ?? []).map((item) => item.fingerprint));
    const candidate = (after?.nearby ?? [])
        .filter((item) => !isCountOnly(item.text) && (item.linked || !previousFingerprints.has(item.fingerprint)))
        .sort((left, right) => Number(right.linked) - Number(left.linked) ||
        Number(right.role === 'tooltip') - Number(left.role === 'tooltip') ||
        left.distance - right.distance)[0];
    if (candidate) {
        const source = candidate.linked
            ? 'aria-describedby'
            : candidate.role === 'tooltip'
                ? 'hover-tooltip'
                : 'hover-overlay';
        return {
            hovered: true,
            tooltipObserved: true,
            semantic: {
                name: candidate.text,
                source,
                confidence: candidate.linked ? 'high' : source === 'hover-tooltip' ? 'medium' : 'low',
                supportingText,
            },
        };
    }
    return {
        hovered: true,
        tooltipObserved: false,
        semantic: { name: '', source: 'none', confidence: 'low', supportingText },
    };
}
function eventRecord(value) {
    return value !== null && typeof value === 'object' ? value : {};
}
function navigationEventUrl(args) {
    const details = eventRecord(args[1]);
    if (typeof details.url === 'string')
        return details.url;
    return typeof args[1] === 'string' ? args[1] : '';
}
function isMainFrameNavigation(args) {
    const details = eventRecord(args[1]);
    if ('isMainFrame' in details)
        return details.isMainFrame !== false;
    return args[3] !== false;
}
function urlsEquivalent(left, right) {
    if (left === right)
        return true;
    try {
        return new URL(left).href === new URL(right).href;
    }
    catch {
        return false;
    }
}
function scrollSnapshot(value) {
    if (value === null || typeof value !== 'object')
        return null;
    const candidate = value;
    if (candidate.kind !== 'document' &&
        candidate.kind !== 'element' &&
        candidate.kind !== 'unknown') {
        return null;
    }
    if (typeof candidate.ownerId !== 'string' || candidate.ownerId.length === 0)
        return null;
    if (typeof candidate.scrollable !== 'boolean')
        return null;
    const numericFields = [
        'scrollTop',
        'scrollLeft',
        'scrollHeight',
        'scrollWidth',
        'clientHeight',
        'clientWidth',
    ];
    if (numericFields.some((field) => !Number.isFinite(candidate[field])))
        return null;
    return candidate;
}
/**
 * 浏览器动作执行器
 * 所有 Browser Tools 的具体实现
 */
export class BrowserActions {
    constructor() {
        this.webContents = null;
        this.cdpHelper = null;
        this.agentCursor = null;
        this.getInputCoordinateScale = () => 1;
        this.bounds = {
            x: 0,
            y: 0,
            width: 800,
            height: 600,
        };
        this.elementMapManager = new ElementMapManager();
    }
    /**
     * 设置 WebContents 引用
     */
    setWebContents(webContents) {
        this.webContents = webContents;
        // 同时更新 CDPHelper
        if (webContents) {
            this.cdpHelper = new CDPHelper(webContents, () => this.getInputCoordinateScale());
        }
        else {
            this.cdpHelper = null;
        }
    }
    setAgentCursor(agentCursor) {
        this.agentCursor = agentCursor;
    }
    setInputCoordinateScaleProvider(provider) {
        this.getInputCoordinateScale = provider;
    }
    /**
     * 获取 CDPHelper 实例
     */
    getCDPHelper() {
        return this.cdpHelper;
    }
    getCurrentInputCoordinateScale() {
        const scale = this.getInputCoordinateScale();
        return Number.isFinite(scale) && scale > 0 ? scale : 1;
    }
    /**
     * 获取 ElementMapManager 实例
     */
    getElementMapManager() {
        return this.elementMapManager;
    }
    /**
     * 设置边界
     */
    setBounds(bounds) {
        this.bounds = bounds;
    }
    /**
     * 获取 WebContents
     */
    get wc() {
        if (!this.webContents || this.webContents.isDestroyed?.())
            return null;
        return this.webContents;
    }
    // ============================================
    // 工具方法
    // ============================================
    sleep(ms, signal) {
        return abortableDelay(ms, signal);
    }
    /**
     * 等待页面完全加载（包括 JavaScript 渲染）
     * 通过检查 document.readyState 和 DOM 内容来判断
     * @param wc WebContents 实例
     * @param timeout 超时时间（毫秒）
     */
    async waitForPageReady(wc, timeout = 5000) {
        const startTime = Date.now();
        const checkInterval = 200;
        while (Date.now() - startTime < timeout) {
            try {
                const pageState = await wc.executeJavaScript(`
          (function() {
            return {
              readyState: document.readyState,
              bodyChildCount: document.body ? document.body.childElementCount : 0,
              hasContent: document.body ? document.body.innerHTML.length > 100 : false,
              url: window.location.href
            };
          })()
        `);
                // 页面已完成加载且有实际内容
                if (pageState.readyState === 'complete' &&
                    pageState.hasContent &&
                    pageState.bodyChildCount > 0) {
                    // 额外等待一小段时间，让 JavaScript 框架完成渲染
                    await this.sleep(300);
                    return;
                }
            }
            catch {
                // 执行 JavaScript 失败，可能页面正在导航中
            }
            await this.sleep(checkInterval);
        }
        // 超时后也继续，不阻塞后续操作
    }
    /**
     * Electron's loadURL() promise can resolve before the requested main frame is
     * committed. Wait for the navigation events belonging to this request so a
     * delayed about:blank finish from controller initialization cannot be
     * reported as a successful user-facing load.
     */
    loadPresentationUrl(wc, requestedUrl, timeout = PAGE_LOAD_TIMEOUT) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let targetStarted = false;
            let targetCommitted = false;
            let committedUrl = '';
            const cleanup = () => {
                clearTimeout(timeoutId);
                wc.removeListener('did-start-navigation', onStartNavigation);
                wc.removeListener('did-redirect-navigation', onRedirectNavigation);
                wc.removeListener('did-navigate', onNavigate);
                wc.removeListener('did-finish-load', onFinishLoad);
                wc.removeListener('did-fail-load', onFailLoad);
                wc.removeListener('destroyed', onDestroyed);
            };
            const settle = (error) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                if (error === undefined)
                    resolve();
                else
                    reject(error);
            };
            const onStartNavigation = (...args) => {
                if (!isMainFrameNavigation(args))
                    return;
                const navigationUrl = navigationEventUrl(args);
                if (urlsEquivalent(navigationUrl, requestedUrl))
                    targetStarted = true;
            };
            const onRedirectNavigation = (...args) => {
                if (!targetStarted || !isMainFrameNavigation(args))
                    return;
                // A redirect still belongs to the target navigation. The final
                // did-navigate event records the URL that actually committed.
            };
            const onNavigate = (...args) => {
                const navigationUrl = navigationEventUrl(args);
                if (!targetStarted) {
                    if (!urlsEquivalent(navigationUrl, requestedUrl))
                        return;
                    targetStarted = true;
                }
                targetCommitted = true;
                committedUrl = navigationUrl;
            };
            const onFinishLoad = () => {
                if (!targetStarted || !targetCommitted)
                    return;
                const currentUrl = wc.getURL();
                if (requestedUrl !== 'about:blank' && currentUrl === 'about:blank')
                    return;
                if (committedUrl && !urlsEquivalent(currentUrl, committedUrl))
                    return;
                settle();
            };
            const onFailLoad = (...args) => {
                const errorCode = typeof args[1] === 'number' ? args[1] : 0;
                const errorDescription = typeof args[2] === 'string' ? args[2] : 'Navigation failed';
                const validatedUrl = typeof args[3] === 'string' ? args[3] : '';
                const isMainFrame = args[4] !== false;
                if (!isMainFrame || errorCode === -3)
                    return;
                if (!targetStarted && !urlsEquivalent(validatedUrl, requestedUrl))
                    return;
                targetStarted = true;
                settle(new Error(`${errorDescription} (${errorCode})`));
            };
            const onDestroyed = () => {
                settle(new Error('Browser was destroyed while loading the page'));
            };
            const timeoutId = setTimeout(() => settle(new Error('PAGE_LOAD_TIMEOUT')), timeout);
            timeoutId.unref?.();
            wc.on('did-start-navigation', onStartNavigation);
            wc.on('did-redirect-navigation', onRedirectNavigation);
            wc.on('did-navigate', onNavigate);
            wc.on('did-finish-load', onFinishLoad);
            wc.on('did-fail-load', onFailLoad);
            wc.on('destroyed', onDestroyed);
            try {
                void wc.loadURL(requestedUrl).catch((error) => {
                    const message = String(error);
                    if (targetStarted && message.includes('ERR_ABORTED'))
                        return;
                    settle(error);
                });
            }
            catch (error) {
                settle(error);
            }
        });
    }
    /**
     * 解析 normalized_position，支持对象或 JSON 字符串
     */
    parseNormalizedPosition(pos) {
        if (!pos)
            return null;
        let parsed = pos;
        if (typeof pos === 'string') {
            try {
                parsed = JSON.parse(pos);
            }
            catch {
                return null;
            }
        }
        if (parsed !== null &&
            typeof parsed === 'object' &&
            typeof parsed.x === 'number' &&
            typeof parsed.y === 'number') {
            const { x, y } = parsed;
            return { x, y };
        }
        return null;
    }
    parseViewportPosition(pos) {
        if (!pos ||
            typeof pos.x !== 'number' ||
            typeof pos.y !== 'number' ||
            !Number.isFinite(pos.x) ||
            !Number.isFinite(pos.y)) {
            return null;
        }
        return { x: pos.x, y: pos.y };
    }
    /**
     * 将归一化坐标转换为像素坐标
     */
    async normalizedToPixel(normalizedX, normalizedY) {
        const { width, height } = await this.getCssViewportSize();
        return {
            x: Math.round(normalizedX * width),
            y: Math.round(normalizedY * height),
        };
    }
    async getCssViewportSize() {
        if (!this.cdpHelper)
            throw new Error('CDP helper not available');
        return this.cdpHelper.getCssViewportSize();
    }
    async inspectScrollSnapshot(point, axis) {
        const wc = this.wc;
        if (!wc)
            return null;
        const command = { point, axis };
        const raw = await wc.executeJavaScript(`(() => {
      const command = ${JSON.stringify(command)};
      const documentScroller = document.scrollingElement || document.documentElement;
      const ownerRegistryKey = Symbol.for('mavis.browser.scroll-owner-registry');
      const ownerRegistry =
        globalThis[ownerRegistryKey] ||
        (globalThis[ownerRegistryKey] = { nextId: 1, ids: new WeakMap() });
      const ownerId = (element) => {
        if (element === documentScroller) return 'document';
        let id = ownerRegistry.ids.get(element);
        if (!id) {
          id = 'element:' + ownerRegistry.nextId++;
          ownerRegistry.ids.set(element, id);
        }
        return id;
      };
      const isScrollable = (element) => {
        if (!(element instanceof Element)) return false;
        const style = getComputedStyle(element);
        const overflow = command.axis === 'y' ? style.overflowY : style.overflowX;
        const allowsUserScroll = overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
        const hasOverflow =
          command.axis === 'y'
            ? element.scrollHeight > element.clientHeight + ${SCROLL_BOUNDARY_EPSILON}
            : element.scrollWidth > element.clientWidth + ${SCROLL_BOUNDARY_EPSILON};
        return allowsUserScroll && hasOverflow;
      };
      const resolveScrollTarget = (point) => {
        let element = point ? document.elementFromPoint(point.x, point.y) : documentScroller;
        if (element instanceof HTMLIFrameElement) return null;
        if (point) {
          while (element && element !== documentScroller && !isScrollable(element)) {
            element = element.parentElement;
          }
        }
        if (!element || (element !== documentScroller && !isScrollable(element))) {
          element = documentScroller;
        }
        return element || null;
      };
      const element = resolveScrollTarget(command.point);
      if (!element) {
        return {
          ownerId: 'unknown',
          kind: 'unknown',
          scrollable: false,
          scrollTop: 0,
          scrollLeft: 0,
          scrollHeight: 0,
          scrollWidth: 0,
          clientHeight: 0,
          clientWidth: 0,
        };
      }
      const hasScrollableExtent =
        command.axis === 'y'
          ? element.scrollHeight > element.clientHeight + ${SCROLL_BOUNDARY_EPSILON}
          : element.scrollWidth > element.clientWidth + ${SCROLL_BOUNDARY_EPSILON};
      return {
        ownerId: ownerId(element),
        kind: element === documentScroller ? 'document' : 'element',
        scrollable:
          element === documentScroller
            ? hasScrollableExtent
            : isScrollable(element),
        scrollTop: Number(element.scrollTop || 0),
        scrollLeft: Number(element.scrollLeft || 0),
        scrollHeight: Number(element.scrollHeight || 0),
        scrollWidth: Number(element.scrollWidth || 0),
        clientHeight: Number(element.clientHeight || 0),
        clientWidth: Number(element.clientWidth || 0),
      };
    })()`);
        return scrollSnapshot(raw);
    }
    async poll(fn, timeout, interval) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            if (await fn()) {
                return;
            }
            await this.sleep(interval);
        }
        throw new Error('Polling timeout');
    }
    /**
     * 启动 DOM 变化监听
     * 应在 WebContents 设置后调用
     */
    startDOMListener() {
        if (this.cdpHelper) {
            this.cdpHelper.startDOMListenerInBackground();
        }
    }
    /**
     * 停止 DOM 变化监听
     */
    stopDOMListener() {
        if (this.cdpHelper) {
            this.cdpHelper.stopDOMListener();
        }
    }
    /**
     * 在可能导致 DOM 更新的操作后更新 ElementMap
     * 1. 智能等待 DOM 稳定（通过监听 DOM 变化事件）
     * 2. 通过 CDP 获取最新的可交互元素
     * 3. 更新 ElementMapManager（会自动保存到文件）
     * 4. 返回简化版 browserState 用于上报给模型
     *
     * @param options 配置选项
     * @param options.forceUpdate 是否强制更新（忽略 isDirty 检查）
     * @param options.waitOptions 等待 DOM 稳定的配置
     */
    async updateElementMapAfterAction(options) {
        const wc = this.wc;
        if (!wc)
            return '';
        const startedAt = Date.now();
        const logPhase = (phase, extra = {}) => {
            browserInputDiagnosticLogger.info({
                msg: '[EmbeddedBrowserOperation] element-map-phase',
                phase,
                webContentsId: wc.id,
                durationMs: Date.now() - startedAt,
                ...extra,
            });
        };
        try {
            logPhase('start', { forceUpdate: options?.forceUpdate === true });
            // 智能等待 DOM 稳定
            if (this.cdpHelper) {
                await this.cdpHelper.waitForDOMStable({
                    ...options?.waitOptions,
                    ...(options?.signal ? { signal: options.signal } : {}),
                });
                logPhase('dom-stable');
                // 如果不是强制更新，且 DOM 没有变化，直接返回当前状态
                if (!options?.forceUpdate && !this.cdpHelper.needsUpdate()) {
                    return this.elementMapManager.generateBrowserStateTag();
                }
            }
            else {
                // 没有 CDP Helper 时，使用固定等待
                await this.sleep(200, options?.signal);
            }
            // 如果没有设置缓存目录，使用默认目录
            if (!this.elementMapManager.getCacheDir()) {
                const defaultDir = path.join(app.getPath('userData'), 'browser-cache', 'element-maps');
                this.elementMapManager.setCacheDir(defaultDir);
            }
            // 并行获取：可交互元素 + 页面基础信息
            const [interactiveElements, pageInfo] = await Promise.all([
                this.cdpHelper?.getInteractiveElements(options?.signal) ?? Promise.resolve([]),
                withTimeout(() => wc.executeJavaScript(`
          (function() {
            try {
              let focusedSelector = null;
              const focused = document.activeElement;
              if (focused && focused !== document.body) {
                if (focused.id) {
                  focusedSelector = '#' + focused.id;
                } else if (focused.dataset?.testid) {
                  focusedSelector = '[data-testid="' + focused.dataset.testid + '"]';
                }
              }

              return {
                url: window.location.href,
                title: document.title,
                viewport: { width: window.innerWidth, height: window.innerHeight },
                scrollPosition: { x: window.scrollX, y: window.scrollY },
                pageHeight: Math.max(
                  document.body.scrollHeight,
                  document.documentElement.scrollHeight,
                  document.body.offsetHeight,
                  document.documentElement.offsetHeight
                ),
                pageWidth: Math.max(
                  document.body.scrollWidth,
                  document.documentElement.scrollWidth,
                  document.body.offsetWidth,
                  document.documentElement.offsetWidth
                ),
                focusedElement: focusedSelector
              };
            } catch (e) {
              return {
                url: window.location.href,
                title: document.title,
                viewport: { width: window.innerWidth, height: window.innerHeight },
                scrollPosition: { x: 0, y: 0 },
                pageHeight: 0,
                pageWidth: 0,
                focusedElement: null
              };
            }
          })()
        `), BROWSER_TIMEOUTS.cdpCommand, 'Browser page info inspection', { signal: options?.signal }).catch((error) => {
                    if (isBrowserOperationInterruption(error))
                        throw error;
                    return {
                        url: wc.getURL(),
                        title: wc.getTitle(),
                        viewport: { width: 0, height: 0 },
                        scrollPosition: { x: 0, y: 0 },
                        pageHeight: 0,
                        pageWidth: 0,
                        focusedElement: null,
                    };
                }),
            ]);
            logPhase('sources-settled', { interactiveElementCount: interactiveElements.length });
            throwIfAborted(options?.signal);
            // 更新 ElementMapManager（会自动保存到文件）
            await this.elementMapManager.update(interactiveElements, pageInfo, this.cdpHelper?.getLastSemanticPageTree() ?? null);
            logPhase('complete');
            // 清除脏标记
            if (this.cdpHelper) {
                this.cdpHelper.clearDirty();
            }
            // 返回优化后的 browserState（使用层级文本格式，应用过滤）
            return this.elementMapManager.generateOptimizedBrowserStateTag();
        }
        catch (error) {
            logPhase('failed', { error: error instanceof Error ? error.message : String(error) });
            console.error('Failed to update element map after action:', error);
            if (isBrowserOperationInterruption(error))
                throw error;
            return '';
        }
    }
    // ============================================
    // 导航操作
    // ============================================
    /**
     * Load a page for the user-facing embedded Browser without eagerly building
     * the Agent ElementMap. Agent navigation keeps using navigate(), while the
     * first inspect rebuilds a fresh map after any presentation navigation.
     */
    async loadForPresentation(params) {
        const startTime = Date.now();
        const wc = this.wc;
        if (!wc) {
            return { success: false, error: 'Browser not created or destroyed', url: '', title: '' };
        }
        try {
            await this.loadPresentationUrl(wc, params.url);
            return {
                success: true,
                url: wc.getURL() || params.url,
                title: wc.getTitle() || '',
                duration: Date.now() - startTime,
            };
        }
        catch (error) {
            const errorMsg = String(error);
            const isTimeout = errorMsg.includes('PAGE_LOAD_TIMEOUT');
            const isDestroyed = wc.isDestroyed?.();
            const currentUrl = isDestroyed ? params.url : wc.getURL() || params.url;
            const currentTitle = isDestroyed ? '' : wc.getTitle() || '';
            const timeoutSeconds = PAGE_LOAD_TIMEOUT / 1000;
            const timeoutMsg = `Page load timeout (${timeoutSeconds}s). The page may still be loading. ` +
                'You can try reload() to refresh the page, or proceed with other actions if the page is already usable.';
            return {
                success: false,
                error: isTimeout ? timeoutMsg : errorMsg,
                url: currentUrl,
                title: currentTitle,
                duration: Date.now() - startTime,
            };
        }
    }
    /**
     * 导航到指定 URL
     */
    async navigate(params, options = {}) {
        const startTime = Date.now();
        const wc = this.wc;
        if (!wc) {
            return { success: false, error: 'Browser not created or destroyed', url: '', title: '' };
        }
        let timeoutId = null;
        let abortListener = null;
        const logPhase = (phase, extra = {}) => {
            browserInputDiagnosticLogger.info({
                msg: '[EmbeddedBrowserOperation] navigate-phase',
                phase,
                webContentsId: wc.id,
                durationMs: Date.now() - startTime,
                ...extra,
            });
        };
        try {
            logPhase('start');
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error('PAGE_LOAD_TIMEOUT'));
                }, PAGE_LOAD_TIMEOUT);
            });
            const abortPromise = new Promise((_, reject) => {
                if (!options.signal)
                    return;
                const onAbort = () => {
                    // A foreground reveal only reclaims the hidden render slot; the page
                    // it reveals is this navigation, so let the load continue visibly.
                    // Every other abort (caller cancel, deadline, teardown) stops it.
                    if (!isBackgroundRenderForegroundClaim(options.signal)) {
                        try {
                            wc.stop();
                        }
                        catch {
                            // WebContents can disappear while an abort is propagating.
                        }
                    }
                    reject(new Error('ABORTED: Browser action was cancelled'));
                };
                abortListener = onAbort;
                if (options.signal.aborted)
                    onAbort();
                else
                    options.signal.addEventListener('abort', onAbort, { once: true });
            });
            await Promise.race([wc.loadURL(params.url), timeoutPromise, abortPromise]);
            if (options.signal && abortListener) {
                options.signal.removeEventListener('abort', abortListener);
                abortListener = null;
            }
            logPhase('load-url-settled');
            if (timeoutId)
                clearTimeout(timeoutId);
            // 等待页面完全加载（包括 JavaScript 渲染和可能的重定向）
            // 使用更长的等待时间，因为 SPA 应用需要时间渲染
            await this.waitForPageReady(wc, 5000);
            logPhase('page-ready-settled');
            // 导航成功后更新 ElementMap 并获取 browserState
            const browserState = options.prepareElementMap === false
                ? ''
                : await this.updateElementMapAfterAction({
                    forceUpdate: true, // 导航后强制更新
                    waitOptions: {
                        timeout: 3000,
                        stableTime: 500, // 等待更长时间确保 DOM 稳定
                        minWait: 300,
                    },
                });
            logPhase('complete');
            return {
                success: true,
                url: wc?.getURL?.() || params.url,
                title: wc?.getTitle?.() || '',
                duration: Date.now() - startTime,
                browserState: browserState || undefined,
            };
        }
        catch (error) {
            if (timeoutId)
                clearTimeout(timeoutId);
            if (options.signal && abortListener) {
                options.signal.removeEventListener('abort', abortListener);
                abortListener = null;
            }
            const errorMsg = String(error);
            const isTimeout = errorMsg.includes('PAGE_LOAD_TIMEOUT');
            logPhase('load-failed', { isTimeout, error: errorMsg });
            const isDestroyed = wc?.isDestroyed?.();
            const currentUrl = isDestroyed ? params.url : wc?.getURL?.() || params.url;
            const currentTitle = isDestroyed ? '' : wc?.getTitle?.() || '';
            const timeoutSeconds = PAGE_LOAD_TIMEOUT / 1000;
            const timeoutMsg = `Page load timeout (${timeoutSeconds}s). The page may still be loading. ` +
                'You can try reload() to refresh the page, or proceed with other actions if the page is already usable.';
            // Agent navigation returns immediately on failure. inspect owns the
            // expensive DOM/DOMSnapshot/AX scan and can rebuild from a partial page.
            const browserState = options.prepareElementMap === false ? '' : await this.updateElementMapAfterAction();
            if (options.prepareElementMap !== false)
                logPhase('failure-map-settled');
            return {
                success: false,
                error: isTimeout ? timeoutMsg : errorMsg,
                url: currentUrl,
                title: currentTitle,
                duration: Date.now() - startTime,
                browserState: browserState || undefined,
            };
        }
    }
    /**
     * 后退
     */
    async goBack() {
        const wc = this.wc;
        if (!wc) {
            return { success: false, error: 'Browser not created or destroyed' };
        }
        if (wc.navigationHistory.canGoBack()) {
            wc.navigationHistory.goBack();
            // 等待导航完成后更新 ElementMap
            await this.sleep(500);
            const browserState = await this.updateElementMapAfterAction();
            return { success: true, browserState: browserState || undefined };
        }
        return { success: false, error: 'Cannot go back' };
    }
    /**
     * 前进
     */
    async goForward() {
        const wc = this.wc;
        if (!wc) {
            return { success: false, error: 'Browser not created or destroyed' };
        }
        if (wc.navigationHistory.canGoForward()) {
            wc.navigationHistory.goForward();
            // 等待导航完成后更新 ElementMap
            await this.sleep(500);
            const browserState = await this.updateElementMapAfterAction();
            return { success: true, browserState: browserState || undefined };
        }
        return { success: false, error: 'Cannot go forward' };
    }
    /**
     * 刷新
     */
    async reload() {
        const wc = this.wc;
        if (!wc) {
            return { success: false, error: 'Browser not created or destroyed' };
        }
        wc.reload();
        // 等待页面完全重新加载
        await this.waitForPageReady(wc, 5000);
        // 更新 ElementMap
        const browserState = await this.updateElementMapAfterAction({
            forceUpdate: true,
            waitOptions: {
                timeout: 3000,
                stableTime: 500,
                minWait: 300,
            },
        });
        return { success: true, browserState: browserState || undefined };
    }
    // ============================================
    // 交互操作
    // ============================================
    async resolveTargetPoint(target, scrollIntoView = true) {
        const wc = this.wc;
        if (!wc)
            throw new Error('Browser not created or destroyed');
        this.assertUnambiguousTarget(target);
        if (target.index !== undefined) {
            const element = this.elementMapManager.getElementById(target.index);
            if (!element)
                throw new Error(`Element not found with index: ${target.index}`);
            if (element.backendNodeId && this.cdpHelper) {
                if (scrollIntoView) {
                    await this.cdpHelper.scrollIntoViewByBackendNodeId(element.backendNodeId);
                }
                const box = await this.cdpHelper.getBoxModelByBackendNodeId(element.backendNodeId);
                return { x: box.centerX, y: box.centerY };
            }
            return this.normalizedToPixel(element.normalizedPosition.x, element.normalizedPosition.y);
        }
        if (target.selector) {
            const selector = target.selector;
            return wc.executeJavaScript(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
        ${scrollIntoView ? "element.scrollIntoView({ block: 'center', inline: 'center' });" : ''}
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
        }
        const position = this.parseViewportPosition(target.position);
        if (position) {
            const viewport = await this.getCssViewportSize();
            if (position.x < 0 ||
                position.y < 0 ||
                position.x >= viewport.width ||
                position.y >= viewport.height) {
                throw new Error('POSITION_OUT_OF_VIEWPORT: position must be inside the current viewport');
            }
            return position;
        }
        const normalized = this.parseNormalizedPosition(target.normalized_position);
        if (normalized)
            return this.normalizedToPixel(normalized.x, normalized.y);
        throw new Error('Target requires index, selector, position, or normalized_position');
    }
    assertUnambiguousTarget(target) {
        const hasElementTarget = target.index !== undefined || Boolean(target.selector);
        const hasAbsolutePosition = target.position !== undefined;
        const hasNormalizedPosition = target.normalized_position !== undefined;
        if (hasElementTarget && (hasAbsolutePosition || hasNormalizedPosition)) {
            throw new Error('AMBIGUOUS_TARGET: use either an element target or a coordinate position, not both');
        }
        if (hasAbsolutePosition && hasNormalizedPosition) {
            throw new Error('AMBIGUOUS_TARGET: use either position or normalized_position, not both');
        }
    }
    async inspectCoordinateHitTarget(x, y) {
        const wc = this.wc;
        if (!wc)
            return undefined;
        try {
            const hit = await wc.executeJavaScript(`(() => {
        const point = { x: ${JSON.stringify(x)}, y: ${JSON.stringify(y)} };
        let element = document.elementFromPoint(point.x, point.y);
        while (element && element.shadowRoot && typeof element.shadowRoot.elementFromPoint === 'function') {
          const deeper = element.shadowRoot.elementFromPoint(point.x, point.y);
          if (!deeper || deeper === element) break;
          element = deeper;
        }
        if (!(element instanceof Element)) return null;
        const rect = element.getBoundingClientRect();
        const text = String(element.textContent || '').replace(/\\s+/g, ' ').trim();
        const name = element.getAttribute('aria-label') || element.getAttribute('title') || text;
        return {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || '',
          name: String(name || '').slice(0, 300),
          text: text.slice(0, 300),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      })()`);
            if (!hit || typeof hit !== 'object')
                return undefined;
            return hit;
        }
        catch {
            return undefined;
        }
    }
    /**
     * 点击元素或位置
     * 支持四种方式：
     * 1. index - 使用 backendNodeId 通过 CDP 操作（推荐，最稳定）
     * 2. selector - 使用 CSS 选择器
     * 3. position - 使用当前视口内的绝对 CSS 像素坐标
     * 4. normalized_position - 使用归一化坐标（兼容旧调用）
     */
    async click(params) {
        const startTime = Date.now();
        const wc = this.wc;
        if (!wc) {
            return { success: false, error: 'Browser not created or destroyed' };
        }
        try {
            this.assertUnambiguousTarget(params);
            const clickCount = typeof params.click_count === 'string'
                ? parseInt(params.click_count, 10) || 1
                : params.click_count || 1;
            if (!this.cdpHelper) {
                return {
                    success: false,
                    error: 'CDP helper not available',
                    duration: Date.now() - startTime,
                };
            }
            // 先得到滚动后的最终 CSS 坐标，让可见光标到达，再下发真实 CDP 输入。
            const { x, y } = await this.resolveTargetPoint(params);
            const coordinateTarget = params.position !== undefined || params.normalized_position !== undefined;
            const hitTarget = coordinateTarget ? await this.inspectCoordinateHitTarget(x, y) : undefined;
            await this.agentCursor?.prepareMove({ x, y }, { animate: true });
            await this.cdpHelper.dispatchClickEvent(x, y, {
                button: params.button,
                clickCount,
                delay: params.delay,
            });
            await this.sleep(100);
            // 点击后更新 ElementMap（点击可能触发页面变化）
            const browserState = await this.updateElementMapAfterAction();
            return {
                success: true,
                duration: Date.now() - startTime,
                ...(coordinateTarget
                    ? {
                        target: {
                            resolvedPosition: { x, y },
                            ...(hitTarget ? { hitTarget, rect: hitTarget.rect } : {}),
                        },
                    }
                    : {}),
                browserState: browserState || undefined,
            };
        }
        catch (error) {
            return { success: false, error: String(error), duration: Date.now() - startTime };
        }
    }
    /**
     * 输入文本
     * 支持三种方式定位输入框：
     * 1. index - 使用 backendNodeId 通过 CDP 操作（推荐，最稳定）
     * 2. selector - 使用 CSS 选择器
     * 3. normalized_position - 使用归一化坐标
     */
    async type(params, options = {}) {
        const startTime = Date.now();
        const wc = this.wc;
        const signal = options.signal;
        if (!wc) {
            return { success: false, error: 'Browser not created or destroyed' };
        }
        try {
            throwIfAborted(signal);
            const delay = typeof params.delay === 'string' ? parseInt(params.delay, 10) : params.delay;
            let virtualEditorBaseline;
            if (params.index !== undefined ||
                Boolean(params.selector) ||
                params.normalized_position !== undefined) {
                try {
                    const point = await this.resolveTargetPoint(params);
                    throwIfAborted(signal);
                    await this.agentCursor?.prepareMove(point, { animate: true });
                    throwIfAborted(signal);
                }
                catch (error) {
                    // Cursor presentation is best-effort. The real text-input path below
                    // still owns target validation and its structured recovery errors.
                    throwIfAborted(signal);
                    if (isBrowserOperationInterruption(error))
                        throw error;
                }
            }
            // 方式1：通过 index 使用 backendNodeId（推荐）
            if (params.index !== undefined) {
                const element = this.elementMapManager.getElementById(params.index);
                if (!element) {
                    return {
                        success: false,
                        error: `Element not found with index: ${params.index}`,
                        duration: Date.now() - startTime,
                    };
                }
                if (!element.backendNodeId) {
                    // 降级到使用归一化坐标点击后输入
                    const { x, y } = await this.normalizedToPixel(element.normalizedPosition.x, element.normalizedPosition.y);
                    if (!this.cdpHelper)
                        throw new Error('CDP helper not available');
                    await this.cdpHelper.dispatchClickEvent(x, y, {
                        clickCount: params.clear ? 3 : 1,
                        ...(signal ? { signal } : {}),
                    });
                    await this.sleep(100, signal);
                    // 输入文本
                    if (delay && delay > 0) {
                        for (const char of params.text) {
                            throwIfAborted(signal);
                            wc.insertText(char);
                            await this.sleep(delay, signal);
                        }
                    }
                    else {
                        throwIfAborted(signal);
                        wc.insertText(params.text);
                    }
                }
                else if (this.cdpHelper) {
                    if (element.inputStrategy === 'focused-keyboard') {
                        virtualEditorBaseline = await this.cdpHelper.typeAtCurrentFocusByBackendNodeId(element.backendNodeId, params.text, {
                            clear: params.clear,
                            delay,
                            ...(signal ? { signal } : {}),
                        });
                    }
                    else {
                        // 使用 CDP 通过 backendNodeId 输入
                        await this.cdpHelper.typeByBackendNodeId(element.backendNodeId, params.text, {
                            clear: params.clear,
                            delay,
                            ...(signal ? { signal } : {}),
                        });
                    }
                }
                else {
                    return {
                        success: false,
                        error: 'CDP helper not available',
                        duration: Date.now() - startTime,
                    };
                }
            }
            // 方式2：通过归一化坐标
            else {
                const normalizedPos = this.parseNormalizedPosition(params.normalized_position);
                if (normalizedPos) {
                    const { x, y } = await this.normalizedToPixel(normalizedPos.x, normalizedPos.y);
                    if (!this.cdpHelper)
                        throw new Error('CDP helper not available');
                    await this.cdpHelper.dispatchClickEvent(x, y, {
                        clickCount: params.clear ? 3 : 1,
                        ...(signal ? { signal } : {}),
                    });
                    await this.sleep(100, signal);
                }
                // 方式3：通过 CSS 选择器
                else if (params.selector) {
                    throwIfAborted(signal);
                    const selectorJson = JSON.stringify(params.selector);
                    const clearScript = params.clear
                        ? "if (el.select) el.select(); else if ('value' in el) el.value = '';"
                        : '';
                    await wc.executeJavaScript(`
            (function() {
              const selector = ${selectorJson};
              const el = document.querySelector(selector);
              if (!el) throw new Error('Element not found: ' + selector);
              el.focus();
              ${clearScript}
            })();
          `);
                    throwIfAborted(signal);
                }
                // 输入文本（对于非 index 方式）
                if (delay && delay > 0) {
                    for (const char of params.text) {
                        throwIfAborted(signal);
                        wc.insertText(char);
                        await this.sleep(delay, signal);
                    }
                }
                else {
                    throwIfAborted(signal);
                    wc.insertText(params.text);
                }
            }
            // 输入后更新 ElementMap（输入可能触发页面变化，如搜索建议）
            throwIfAborted(signal);
            const browserState = await this.updateElementMapAfterAction({ signal });
            throwIfAborted(signal);
            return {
                success: true,
                duration: Date.now() - startTime,
                browserState: browserState || undefined,
                ...(virtualEditorBaseline ? { _virtualEditorBaseline: virtualEditorBaseline } : {}),
            };
        }
        catch (error) {
            if (error instanceof CDPTextInputError) {
                return {
                    success: false,
                    code: error.code,
                    error: error.message,
                    retryable: true,
                    recovery: 'Inspect the page again and choose the current visible editor ref.',
                    duration: Date.now() - startTime,
                };
            }
            return { success: false, error: String(error), duration: Date.now() - startTime };
        }
    }
    /**
     * 按下键盘按键
     */
    async pressKey(params) {
        const startTime = Date.now();
        const wc = this.wc;
        if (!wc) {
            return { success: false, error: 'Browser not created or destroyed' };
        }
        try {
            const { key } = params;
            let modifiers = [];
            if (Array.isArray(params.modifiers)) {
                modifiers = params.modifiers;
            }
            else if (typeof params.modifiers === 'string' && params.modifiers) {
                try {
                    const parsed = JSON.parse(params.modifiers);
                    modifiers = Array.isArray(parsed) ? parsed : [params.modifiers];
                }
                catch {
                    modifiers = [params.modifiers];
                }
            }
            const normalizedModifiers = modifiers.map((m) => {
                const lower = m.toLowerCase();
                if (lower === 'meta' || lower === 'command' || lower === 'cmd') {
                    return 'meta';
                }
                if (lower === 'control' || lower === 'ctrl') {
                    return 'control';
                }
                return lower;
            });
            wc.sendInputEvent({
                type: 'keyDown',
                keyCode: key,
                modifiers: normalizedModifiers,
            });
            wc.sendInputEvent({
                type: 'keyUp',
                keyCode: key,
                modifiers: normalizedModifiers,
            });
            // 按键后更新 ElementMap（按键可能触发页面变化，如 Enter 提交表单）
            const browserState = await this.updateElementMapAfterAction();
            return {
                success: true,
                duration: Date.now() - startTime,
                browserState: browserState || undefined,
            };
        }
        catch (error) {
            return { success: false, error: String(error), duration: Date.now() - startTime };
        }
    }
    /**
     * 滚动
     */
    async scroll(params) {
        const wc = this.wc;
        if (!wc) {
            return {
                success: false,
                error: 'Browser not created or destroyed',
                effect: {
                    observed: false,
                    moved: false,
                    actualDeltaX: 0,
                    actualDeltaY: 0,
                    atStart: false,
                    atEnd: false,
                },
            };
        }
        try {
            const direction = params.direction || 'down';
            const viewport = await this.getCssViewportSize();
            const defaultDistance = Math.round(viewport.height * 0.8);
            const distance = params.distance || defaultDistance;
            let scrollX = 0;
            let scrollY = 0;
            if (direction === 'left')
                scrollX = -distance;
            else if (direction === 'right')
                scrollX = distance;
            else if (direction === 'up')
                scrollY = -distance;
            else if (direction === 'down')
                scrollY = distance;
            let targetPoint = null;
            if (params.index !== undefined || params.selector) {
                const { x, y } = await this.resolveTargetPoint(params, false);
                const pointInViewport = Number.isFinite(x) &&
                    Number.isFinite(y) &&
                    x >= 0 &&
                    y >= 0 &&
                    x <= viewport.width &&
                    y <= viewport.height;
                if (!pointInViewport) {
                    return {
                        success: false,
                        error: 'Scroll target is outside the current viewport.',
                        code: 'NO_SCROLL_EFFECT',
                        retryable: true,
                        recovery: 'Inspect the current viewport and choose a visible scroll container, ref, selector, or normalized position.',
                        effect: {
                            observed: false,
                            moved: false,
                            actualDeltaX: 0,
                            actualDeltaY: 0,
                            atStart: false,
                            atEnd: false,
                        },
                    };
                }
                targetPoint = { x, y };
            }
            else {
                const normalizedPos = this.parseNormalizedPosition(params.normalized_position);
                if (normalizedPos) {
                    targetPoint = await this.normalizedToPixel(normalizedPos.x, normalizedPos.y);
                }
            }
            const axis = scrollY === 0 ? 'x' : 'y';
            const before = await this.inspectScrollSnapshot(targetPoint, axis);
            const beforeObserved = before !== null && before.kind !== 'unknown';
            const beforePosition = axis === 'y' ? (before?.scrollTop ?? 0) : (before?.scrollLeft ?? 0);
            const beforeExtent = axis === 'y' ? (before?.scrollHeight ?? 0) : (before?.scrollWidth ?? 0);
            const beforeViewport = axis === 'y' ? (before?.clientHeight ?? 0) : (before?.clientWidth ?? 0);
            const beforeAtRequestedBoundary = beforeObserved &&
                Boolean(before?.scrollable) &&
                (direction === 'down' || direction === 'right'
                    ? beforePosition + beforeViewport >= beforeExtent - SCROLL_BOUNDARY_EPSILON
                    : beforePosition <= SCROLL_BOUNDARY_EPSILON);
            let after = before;
            let usedUnobservedWheelFallback = false;
            if (!beforeAtRequestedBoundary) {
                if (targetPoint) {
                    usedUnobservedWheelFallback =
                        before?.kind === 'unknown' || (beforeObserved && !before?.scrollable);
                    const { x, y } = targetPoint;
                    if (!this.cdpHelper)
                        throw new Error('CDP helper not available');
                    await this.agentCursor?.prepareMove(targetPoint, { animate: true });
                    await this.cdpHelper.dispatchMouseMove(x, y);
                    await this.cdpHelper.dispatchMouseWheel(x, y, scrollX, scrollY);
                }
                else {
                    await wc.executeJavaScript(`window.scrollBy(${scrollX}, ${scrollY})`);
                }
                await this.sleep(150);
                after = await this.inspectScrollSnapshot(targetPoint, axis);
            }
            // 滚动后更新 ElementMap（视口内元素会变化）
            const browserState = await this.updateElementMapAfterAction();
            const observed = before !== null &&
                after !== null &&
                !usedUnobservedWheelFallback &&
                before.kind !== 'unknown' &&
                before.ownerId === after.ownerId;
            const actualDeltaX = observed && before && after ? after.scrollLeft - before.scrollLeft : 0;
            const actualDeltaY = observed && before && after ? after.scrollTop - before.scrollTop : 0;
            const moved = observed &&
                ((scrollX !== 0 &&
                    Math.sign(actualDeltaX) === Math.sign(scrollX) &&
                    Math.abs(actualDeltaX) >= SCROLL_BOUNDARY_EPSILON) ||
                    (scrollY !== 0 &&
                        Math.sign(actualDeltaY) === Math.sign(scrollY) &&
                        Math.abs(actualDeltaY) >= SCROLL_BOUNDARY_EPSILON));
            const finalSnapshot = after ?? before;
            const relevantPosition = axis === 'y' ? (finalSnapshot?.scrollTop ?? 0) : (finalSnapshot?.scrollLeft ?? 0);
            const relevantExtent = axis === 'y' ? (finalSnapshot?.scrollHeight ?? 0) : (finalSnapshot?.scrollWidth ?? 0);
            const relevantViewport = axis === 'y' ? (finalSnapshot?.clientHeight ?? 0) : (finalSnapshot?.clientWidth ?? 0);
            const atStart = observed && relevantPosition <= SCROLL_BOUNDARY_EPSILON;
            const atEnd = observed && relevantPosition + relevantViewport >= relevantExtent - SCROLL_BOUNDARY_EPSILON;
            const effect = {
                observed,
                moved,
                actualDeltaX,
                actualDeltaY,
                atStart,
                atEnd,
            };
            const requestedBoundaryReached = direction === 'down' || direction === 'right' ? atEnd : atStart;
            const finalExplicitTargetIsNotScrollable = targetPoint !== null && observed && !finalSnapshot?.scrollable;
            if (!observed) {
                return {
                    success: false,
                    error: 'Scroll input was dispatched, but its page effect could not be verified.',
                    code: 'SCROLL_EFFECT_UNVERIFIED',
                    retryable: true,
                    recovery: 'Inspect the page once and choose a newly observed scroll target or confirm the intended state before continuing.',
                    effect,
                    browserState: browserState || undefined,
                };
            }
            if (observed && !moved && (finalExplicitTargetIsNotScrollable || !requestedBoundaryReached)) {
                return {
                    success: false,
                    error: 'Scroll action produced no observable movement.',
                    code: 'NO_SCROLL_EFFECT',
                    retryable: true,
                    recovery: 'Inspect the page and choose a different scroll target, selector, ref, or normalized position.',
                    effect,
                    browserState: browserState || undefined,
                };
            }
            return { success: true, effect, browserState: browserState || undefined };
        }
        catch (error) {
            return {
                success: false,
                error: String(error),
                effect: {
                    observed: false,
                    moved: false,
                    actualDeltaX: 0,
                    actualDeltaY: 0,
                    atStart: false,
                    atEnd: false,
                },
            };
        }
    }
    /**
     * 悬停
     */
    async hover(params) {
        const wc = this.wc;
        if (!wc) {
            return {
                success: false,
                error: 'Browser not created or destroyed',
                effect: {
                    hovered: false,
                    tooltipObserved: false,
                    semantic: { name: '', source: 'none', confidence: 'low', supportingText: '' },
                },
            };
        }
        try {
            const { x, y } = await this.resolveTargetPoint(params);
            const element = params.index === undefined ? null : this.elementMapManager.getElementById(params.index);
            let before = null;
            if (element?.backendNodeId && this.cdpHelper) {
                before = await this.cdpHelper
                    .captureHoverSemanticSnapshotByBackendNodeId(element.backendNodeId)
                    .catch(() => null);
            }
            await this.agentCursor?.prepareMove({ x, y }, { animate: true });
            if (!this.cdpHelper)
                throw new Error('CDP helper not available');
            await this.cdpHelper.dispatchMouseMove(x, y);
            let after = null;
            if (element?.backendNodeId) {
                for (let sample = 0; sample < HOVER_SEMANTIC_SAMPLE_COUNT; sample += 1) {
                    await this.sleep(HOVER_SEMANTIC_SAMPLE_DELAY_MS);
                    after = await this.cdpHelper
                        .captureHoverSemanticSnapshotByBackendNodeId(element.backendNodeId)
                        .catch(() => null);
                    const effect = resolveHoverSemantic(before, after, element.text);
                    if (effect.semantic.name)
                        return { success: true, effect };
                }
            }
            return {
                success: true,
                effect: resolveHoverSemantic(before, after, element?.text),
            };
        }
        catch (error) {
            return {
                success: false,
                error: String(error),
                effect: {
                    hovered: false,
                    tooltipObserved: false,
                    semantic: { name: '', source: 'none', confidence: 'low', supportingText: '' },
                },
            };
        }
    }
    async drag(params) {
        const wc = this.wc;
        if (!wc)
            return { success: false, error: 'Browser not created or destroyed' };
        if (!this.cdpHelper)
            return { success: false, error: 'CDP helper not available' };
        try {
            await this.resolveTargetPoint(params.source);
            await this.resolveTargetPoint(params.target);
            const source = await this.resolveTargetPoint(params.source, false);
            const target = await this.resolveTargetPoint(params.target, false);
            const viewport = await this.getCssViewportSize();
            const pointInViewport = ({ x, y }) => Number.isFinite(x) &&
                Number.isFinite(y) &&
                x >= 0 &&
                y >= 0 &&
                x <= viewport.width &&
                y <= viewport.height;
            if (!pointInViewport(source) || !pointInViewport(target)) {
                return {
                    success: false,
                    code: 'ELEMENT_NOT_INTERACTABLE',
                    error: 'Drag source and target must both remain inside the current viewport.',
                };
            }
            await this.agentCursor?.prepareMove(source, { animate: true });
            const dragResult = await this.cdpHelper.dispatchDragGesture(source, target);
            await this.agentCursor?.prepareMove(target, { animate: true });
            const browserState = await this.updateElementMapAfterAction();
            return {
                success: true,
                ...dragResult,
                browserState: browserState || undefined,
            };
        }
        catch (error) {
            const code = error && typeof error === 'object' && 'code' in error
                ? error.code
                : undefined;
            return { success: false, ...(code ? { code } : {}), error: String(error) };
        }
    }
    async setChecked(params) {
        const wc = this.wc;
        if (!wc)
            return { success: false, error: 'Browser not created or destroyed' };
        try {
            if (params.index !== undefined) {
                const element = this.elementMapManager.getElementById(params.index);
                if (!element)
                    throw new Error(`Element not found with index: ${params.index}`);
                if (!element.backendNodeId || !this.cdpHelper)
                    throw new Error('CDP helper not available');
                await this.cdpHelper.setCheckedByBackendNodeId(element.backendNodeId, params.checked);
            }
            else if (params.selector) {
                await wc.executeJavaScript(`(() => {
          const element = document.querySelector(${JSON.stringify(params.selector)});
          if (!(element instanceof HTMLInputElement)) throw new Error('Checkbox not found');
          if (element.checked !== ${JSON.stringify(params.checked)}) element.click();
          return element.checked;
        })()`);
            }
            else {
                throw new Error('Checkbox target requires index or selector');
            }
            const browserState = await this.updateElementMapAfterAction();
            return { success: true, browserState: browserState || undefined };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    }
    async selectOption(params) {
        const wc = this.wc;
        if (!wc)
            return { success: false, error: 'Browser not created or destroyed' };
        try {
            if (params.index !== undefined) {
                const element = this.elementMapManager.getElementById(params.index);
                if (!element)
                    throw new Error(`Element not found with index: ${params.index}`);
                if (!element.backendNodeId || !this.cdpHelper)
                    throw new Error('CDP helper not available');
                await this.cdpHelper.selectOptionsByBackendNodeId(element.backendNodeId, params.values);
            }
            else if (params.selector) {
                await wc.executeJavaScript(`(() => {
          const element = document.querySelector(${JSON.stringify(params.selector)});
          if (!(element instanceof HTMLSelectElement)) throw new Error('Select not found');
          const values = new Set(${JSON.stringify(params.values)});
          for (const option of element.options) option.selected = values.has(option.value);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return Array.from(element.selectedOptions, (option) => option.value);
        })()`);
            }
            else {
                throw new Error('Select target requires index or selector');
            }
            const browserState = await this.updateElementMapAfterAction();
            return { success: true, browserState: browserState || undefined };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    }
    // ============================================
    // 高级操作
    // ============================================
    /**
     * 等待条件
     */
    async waitFor(params) {
        const startTime = Date.now();
        const timeout = params.timeout || 30000;
        if (params.selector) {
            const wc = this.wc;
            if (!wc) {
                return { success: false, error: 'Browser not created or destroyed' };
            }
            const state = params.state || 'visible';
            const selectorJson = JSON.stringify(params.selector);
            try {
                await this.poll(async () => {
                    const result = await wc.executeJavaScript(`
              (function() {
                const selector = ${selectorJson};
                const el = document.querySelector(selector);
                if (!el) return { exists: false, visible: false };
                const style = window.getComputedStyle(el);
                const visible = style.display !== 'none' &&
                               style.visibility !== 'hidden' &&
                               style.opacity !== '0';
                return { exists: true, visible };
              })();
            `);
                    switch (state) {
                        case 'attached':
                            return result.exists;
                        case 'detached':
                            return !result.exists;
                        case 'visible':
                            return result.exists && result.visible;
                        case 'hidden':
                            return !result.exists || !result.visible;
                        default:
                            return result.exists;
                    }
                }, timeout, 100);
                return { success: true, duration: Date.now() - startTime };
            }
            catch (error) {
                return { success: false, error: String(error), duration: Date.now() - startTime };
            }
        }
        else if (params.text) {
            const wc = this.wc;
            if (!wc)
                return { success: false, error: 'Browser not created or destroyed' };
            try {
                const text = params.text;
                await this.poll(() => wc.executeJavaScript(`String(document.body?.innerText || document.body?.textContent || '').includes(${JSON.stringify(text)})`), timeout, 100);
                return { success: true, duration: Date.now() - startTime };
            }
            catch (error) {
                return { success: false, error: String(error), duration: Date.now() - startTime };
            }
        }
        else if (params.url) {
            const wc = this.wc;
            if (!wc)
                return { success: false, error: 'Browser not created or destroyed' };
            try {
                await this.poll(() => Promise.resolve(wc.getURL().includes(params.url ?? '')), timeout, 100);
                return { success: true, duration: Date.now() - startTime };
            }
            catch (error) {
                return { success: false, error: String(error), duration: Date.now() - startTime };
            }
        }
        else if (params.load) {
            const wc = this.wc;
            if (!wc)
                return { success: false, error: 'Browser not created or destroyed' };
            try {
                await this.poll(() => Promise.resolve(!wc.isLoading()), timeout, 100);
                return { success: true, duration: Date.now() - startTime };
            }
            catch (error) {
                return { success: false, error: String(error), duration: Date.now() - startTime };
            }
        }
        else if (params.timeout) {
            await this.sleep(params.timeout);
            return { success: true, duration: Date.now() - startTime };
        }
        return { success: false, error: 'Either selector or timeout is required' };
    }
    /**
     * 执行 JavaScript
     *
     * B1: when `params.args` is supplied, the script is invoked as
     * `(script).call(null, ...JSON.stringify(args))`. Chromium's `executeJavaScript`
     * only accepts `(code, userGesture)` — it does not pass a separate args array
     * through to the page — so we serialize the args into the script source. This
     * keeps the underlying API surface stable while restoring the args-forwarding
     * contract the LLM-side schema already advertises.
     *
     * The response carries `args_echo` on both success and failure paths so the
     * caller can verify what was actually received (instead of inferring from the
     * script's return value).
     */
    async evaluate(params) {
        const startTime = Date.now();
        const wc = this.wc;
        if (!wc) {
            return {
                success: false,
                error: 'Browser not created or destroyed',
                result: null,
                args_echo: Array.isArray(params.args) ? params.args : [],
            };
        }
        const scriptArgs = Array.isArray(params.args) ? params.args : [];
        const wrapped = scriptArgs.length === 0
            ? params.script
            : // Invoke the script as a function with the supplied args. JSON.stringify
                // ensures values cross the eval boundary safely; non-serializable inputs
                // (circular refs, functions, symbols) will surface as a JSON.stringify
                // throw, which we let propagate so the LLM can learn from the error.
                `(${params.script}).call(null, ${scriptArgs.map((value) => JSON.stringify(value)).join(', ')})`;
        try {
            const result = await wc.executeJavaScript(wrapped, true /* userGesture */);
            return {
                success: true,
                result,
                args_echo: scriptArgs,
                duration: Date.now() - startTime,
            };
        }
        catch (error) {
            return {
                success: false,
                error: String(error),
                result: null,
                args_echo: scriptArgs,
                duration: Date.now() - startTime,
            };
        }
    }
    // ============================================
    // 获取信息
    // ============================================
    async inspect(_params = {}, options = {}) {
        const startTime = Date.now();
        const wc = this.wc;
        if (!wc) {
            return {
                success: false,
                error: 'Browser not created or destroyed',
                url: '',
                title: '',
                duration: Date.now() - startTime,
            };
        }
        try {
            const browserState = await this.updateElementMapAfterAction({
                forceUpdate: true,
                signal: options.signal,
            });
            return {
                success: true,
                url: wc.getURL(),
                title: wc.getTitle(),
                browserState: browserState || undefined,
                duration: Date.now() - startTime,
            };
        }
        catch (error) {
            if (isBrowserOperationInterruption(error))
                throw error;
            return {
                success: false,
                error: String(error),
                url: wc.getURL(),
                title: wc.getTitle(),
                duration: Date.now() - startTime,
            };
        }
    }
    /**
     * 截图
     * 使用 CDP Page.captureScreenshot，支持窗口最小化/不可见时截图
     */
    async screenshot(params = {}) {
        const startTime = Date.now();
        const wc = this.wc;
        if (!wc) {
            return {
                success: false,
                error: 'Screenshot unavailable: Browser not created or destroyed',
                format: 'png',
                width: 0,
                height: 0,
            };
        }
        try {
            if (!this.cdpHelper) {
                this.cdpHelper = new CDPHelper(wc);
            }
            const result = await this.cdpHelper.captureScreenshot();
            const screenshotResult = {
                success: true,
                format: 'png',
                width: result.width,
                height: result.height,
                duration: Date.now() - startTime,
            };
            // 如果提供了保存路径，则保存到文件
            if (params.file_path) {
                try {
                    const buffer = Buffer.from(result.data, 'base64');
                    const dir = path.dirname(params.file_path);
                    await fs.promises.mkdir(dir, { recursive: true });
                    await fs.promises.writeFile(params.file_path, buffer);
                    screenshotResult.file_path = params.file_path;
                }
                catch (saveError) {
                    console.error('Failed to save screenshot:', saveError);
                }
            }
            return screenshotResult;
        }
        catch (error) {
            return {
                success: false,
                error: 'Screenshot unavailable: Failed to capture page. Please use DOM analysis instead.',
                format: 'png',
                width: 0,
                height: 0,
                duration: Date.now() - startTime,
            };
        }
    }
    /**
     * 获取 DOM
     * 同时返回 HTML 和结构化数据
     */
    async getDOM(params = {}) {
        const startTime = Date.now();
        const wc = this.wc;
        if (!wc) {
            return {
                success: false,
                error: 'Browser not created or destroyed',
                url: '',
                title: '',
            };
        }
        try {
            // 等待页面基本渲染完成
            await wc.executeJavaScript(`
        new Promise((resolve) => {
          if (document.readyState === 'complete') {
            resolve();
          } else {
            window.addEventListener('load', resolve, { once: true });
            setTimeout(resolve, 5000);
          }
        })
      `);
            // 获取 HTML
            let html;
            if (params.selector) {
                const selectorJson = JSON.stringify(params.selector);
                html = await wc.executeJavaScript(`
          (function() {
            const selector = ${selectorJson};
            const el = document.querySelector(selector);
            if (!el || el.closest('[data-mavis-agent-cursor-host]')) {
              throw new Error('Element not found: ' + selector);
            }
            return el.outerHTML;
          })();
        `);
            }
            else {
                html = await wc.executeJavaScript(`
          (function() {
            const body = document.body;
            if (!body) return '<body></body>';

            const clone = body.cloneNode(true);

            clone.querySelectorAll('[data-mavis-agent-cursor-host]').forEach(el => el.remove());

            clone.querySelectorAll('script, noscript, style, link, template').forEach(el => el.remove());
            clone.querySelectorAll('svg defs, svg symbol').forEach(el => el.remove());

            const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
            const comments = [];
            while (walker.nextNode()) comments.push(walker.currentNode);
            comments.forEach(c => c.remove());

            clone.querySelectorAll('[style*="display: none"], [style*="display:none"]')
              .forEach(el => el.remove());
            clone.querySelectorAll('[style*="visibility: hidden"], [style*="visibility:hidden"]')
              .forEach(el => el.remove());
            clone.querySelectorAll('[hidden], [aria-hidden="true"]').forEach(el => el.remove());
            clone.querySelectorAll('iframe, object, embed').forEach(el => el.remove());

            clone.querySelectorAll('*').forEach(el => {
              const keepAttrs = [
                'href', 'src', 'alt', 'title',
                'type', 'name', 'id', 'class', 'for',
                'placeholder', 'value', 'checked', 'disabled', 'readonly', 'required',
                'min', 'max', 'pattern', 'maxlength', 'minlength',
                'role', 'aria-label', 'aria-labelledby', 'aria-describedby',
                'aria-expanded', 'aria-selected', 'aria-checked', 'aria-disabled',
                'aria-haspopup', 'aria-controls', 'aria-hidden',
                'data-testid', 'data-id', 'data-value', 'data-name',
                'colspan', 'rowspan', 'scope',
                'target', 'rel', 'download', 'action', 'method', 'enctype',
                'tabindex', 'contenteditable', 'lang', 'dir'
              ];
              const attrs = Array.from(el.attributes);
              attrs.forEach(attr => {
                const name = attr.name;
                if (!keepAttrs.includes(name) && !name.startsWith('aria-') && !name.startsWith('data-')) {
                  el.removeAttribute(name);
                }
              });
            });

            return clone.outerHTML;
          })();
        `);
            }
            // 构建结果
            const result = {
                success: true,
                url: wc.getURL(),
                title: wc.getTitle(),
                duration: Date.now() - startTime,
            };
            // 保存 HTML 到文件
            if (params.file_path) {
                try {
                    const dir = path.dirname(params.file_path);
                    await fs.promises.mkdir(dir, { recursive: true });
                    await fs.promises.writeFile(params.file_path, html, 'utf-8');
                    result.file_path = params.file_path;
                }
                catch (saveError) {
                    console.error('Failed to save DOM HTML:', saveError);
                }
            }
            return result;
        }
        catch (error) {
            return {
                success: false,
                error: String(error),
                url: wc.getURL(),
                title: wc.getTitle(),
                duration: Date.now() - startTime,
            };
        }
    }
    /**
     * 将 HTML 文件转换为 Markdown
     */
    async htmlToMarkdown(params) {
        const startTime = Date.now();
        try {
            const htmlContent = await fs.promises.readFile(params.file_path, 'utf-8');
            const turndownService = new turndown({
                headingStyle: 'atx',
                hr: '---',
                bulletListMarker: '-',
                codeBlockStyle: 'fenced',
                fence: '```',
                emDelimiter: '*',
                strongDelimiter: '**',
                linkStyle: 'inlined',
                linkReferenceStyle: 'full',
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            turndownService.addRule('fencedCodeBlock', {
                filter: (node) => {
                    return !!(node.nodeName === 'PRE' &&
                        node.firstChild &&
                        node.firstChild.nodeName === 'CODE');
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                replacement: (_content, node) => {
                    const codeElement = node.firstChild;
                    const className = codeElement?.getAttribute?.('class') || '';
                    const languageMatch = className.match(/language-(\w+)/);
                    const language = languageMatch ? languageMatch[1] : '';
                    const code = codeElement?.textContent || '';
                    return `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
                },
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            turndownService.addRule('table', {
                filter: 'table',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                replacement: (_content, node) => {
                    const table = node;
                    const rows = [];
                    const thead = table.querySelector?.('thead');
                    const headerRow = [];
                    if (thead) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        thead.querySelectorAll?.('th, td')?.forEach?.((cell) => {
                            headerRow.push((cell.textContent || '').trim().replace(/\|/g, '\\|'));
                        });
                    }
                    const tbody = table.querySelector?.('tbody') || table;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    tbody.querySelectorAll?.('tr')?.forEach?.((tr, index) => {
                        if (!thead && index === 0) {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            tr.querySelectorAll?.('th, td')?.forEach?.((cell) => {
                                headerRow.push((cell.textContent || '').trim().replace(/\|/g, '\\|'));
                            });
                        }
                        else {
                            const row = [];
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            tr.querySelectorAll?.('th, td')?.forEach?.((cell) => {
                                row.push((cell.textContent || '').trim().replace(/\|/g, '\\|'));
                            });
                            if (row.length > 0) {
                                rows.push(row);
                            }
                        }
                    });
                    if (headerRow.length === 0) {
                        return '';
                    }
                    let markdown = '\n| ' + headerRow.join(' | ') + ' |\n';
                    markdown += '| ' + headerRow.map(() => '---').join(' | ') + ' |\n';
                    rows.forEach((row) => {
                        while (row.length < headerRow.length) {
                            row.push('');
                        }
                        markdown += '| ' + row.slice(0, headerRow.length).join(' | ') + ' |\n';
                    });
                    return markdown + '\n';
                },
            });
            turndownService.remove(['script', 'style', 'noscript', 'iframe']);
            let markdown = turndownService.turndown(htmlContent);
            markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();
            const markdownPath = params.file_path.replace(/\.html?$/i, '.md') || params.file_path + '.md';
            const dir = path.dirname(markdownPath);
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.writeFile(markdownPath, markdown, 'utf-8');
            return {
                success: true,
                file_path: markdownPath,
                duration: Date.now() - startTime,
            };
        }
        catch (error) {
            return {
                success: false,
                error: String(error),
                duration: Date.now() - startTime,
            };
        }
    }
}

