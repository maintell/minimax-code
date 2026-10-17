import { BaseWindow } from "electron";
import { getCategoryLogger } from "../../utils/logger";
import { OFFSCREEN_BOUNDS } from "./embedded-browser-manager-helpers";
const browserInputDiagnosticLogger = getCategoryLogger('archon', 'browser-input');
export let BACKGROUND_BROWSER_RENDER_BOUNDS = {
    x: 0,
    y: 0,
    width: 1280,
    height: 720,
};
export class BackgroundBrowserRenderError extends Error {
    constructor(code, message) {
        super(`${code}: ${message}`);
        this.code = code;
        this.name = 'BackgroundBrowserRenderError';
    }
}

const DEFAULT_MAX_QUEUED_REQUESTS = 4;
const DEFAULT_MAX_QUEUED_PER_TARGET = 1;
const DEFAULT_OPERATION_TIMEOUT_MS = 60000;
const DEFAULT_SLOT_COUNT = 2;
const MAX_SLOT_COUNT = 4;
function createBackgroundWindow(slotIndex) {
    const window = new BaseWindow({
        title: `Mavis Browser Background Render Host ${slotIndex + 1}`,
        x: -10000,
        y: -10000,
        width: BACKGROUND_BROWSER_RENDER_BOUNDS.width,
        height: BACKGROUND_BROWSER_RENDER_BOUNDS.height,
        show: false,
        opacity: 0,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        focusable: false,
        skipTaskbar: true,
        hiddenInMissionControl: true,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
    });
    // A fully hidden BaseWindow has no display surface on macOS. Keep one
    // transparent, input-ignoring host shown without activation so the attached
    // WebContentsView remains compositor-backed without leaking desktop UI.
    window.setIgnoreMouseEvents(true);
    window.showInactive();
    return window;
}
/**
 * Owns a small pool of non-focusable, off-desktop compositor surfaces shared by
 * session-scoped Browser tabs. Each tab keeps its own WebContents state; a slot
 * only provides temporary compositor ownership while an action is running.
 * Operations for the same tab remain serialized even when another slot is idle.
 */
export class BackgroundBrowserRenderHost {
    constructor(options = {}) {
        this.options = options;
        this.queue = [];
        this.pendingByTarget = new Map();
        this.ownershipByTarget = new WeakMap();
        this.lastScheduledKey = null;
        this.disposed = false;
        this.slots = Array.from({ length: this.slotCount() }, (_, index) => ({
            index,
            window: null,
            activeRequest: null,
        }));
    }
    run(target, operation, runOptions = {}) {
        if (this.disposed)
            return Promise.reject(this.unavailableError());
        if (runOptions.signal?.aborted)
            return Promise.reject(this.abortedError());
        if (this.isForegroundOwned(target))
            return Promise.reject(this.foregroundClaimError());
        const idleSlot = this.findIdleSlot();
        const mustQueue = this.isTargetActive(target) || idleSlot === null;
        if (mustQueue && this.queue.length >= this.maxQueuedRequests()) {
            return Promise.reject(this.busyError('the shared background render queue is full'));
        }
        if (mustQueue &&
            this.queue.filter((request) => request.target === target).length >= this.maxQueuedPerTarget()) {
            return Promise.reject(this.busyError('this Browser tab already has a queued action'));
        }
        const controller = new AbortController();
        const webContentsId = this.targetWebContentsId(target);
        const requestedAt = Date.now();
        let request;
        const execution = new Promise((resolve, reject) => {
            request = {
                target,
                schedulingKey: runOptions.schedulingKey ?? `target:${webContentsId ?? 'unknown'}`,
                operation,
                controller,
                externalSignal: runOptions.signal,
                operationTimeoutMs: Math.max(1, runOptions.operationTimeoutMs ??
                    this.options.operationTimeoutMs ??
                    DEFAULT_OPERATION_TIMEOUT_MS),
                renderBounds: this.normalizeRenderBounds(runOptions.bounds),
                started: false,
                settled: false,
                resolve,
                reject,
            };
        });
        this.bindExternalAbort(request);
        browserInputDiagnosticLogger.info({
            msg: '[EmbeddedBrowserOperation] render-host-requested',
            webContentsId,
            activeRequestCount: this.activeRequestCount(),
            slotCount: this.slots.length,
            queueLength: this.queue.length,
        });
        const completion = execution.then(() => undefined, () => undefined);
        this.trackTarget(target, completion);
        if (!mustQueue && idleSlot) {
            this.startRequest(request, idleSlot);
        }
        else {
            const queueTimeoutMs = Math.max(1, runOptions.queueTimeoutMs ?? this.options.queueTimeoutMs ?? request.operationTimeoutMs);
            request.queueTimer = setTimeout(() => {
                if (!this.removeQueuedRequest(request))
                    return;
                request.controller.abort('background-render-queue-timeout');
                browserInputDiagnosticLogger.warn({
                    msg: '[EmbeddedBrowserOperation] render-host-queue-timeout',
                    webContentsId,
                    durationMs: Date.now() - requestedAt,
                    queueLength: this.queue.length,
                });
                this.settleRequest(request, 'reject', new BackgroundBrowserRenderError('BACKGROUND_RENDER_QUEUE_TIMEOUT', `waited ${queueTimeoutMs}ms for a background render slot`));
            }, queueTimeoutMs);
            request.queueTimer.unref?.();
            this.queue.push(request);
            browserInputDiagnosticLogger.info({
                msg: '[EmbeddedBrowserOperation] render-host-enqueued',
                webContentsId,
                schedulingKey: request.schedulingKey,
                queueLength: this.queue.length,
            });
            this.startAvailableRequests();
        }
        return execution;
    }
    async waitForTarget(target) {
        const pending = Array.from(this.pendingByTarget.get(target) ?? []);
        if (pending.length === 0)
            return;
        await Promise.all(pending);
    }
    async claimForeground(target) {
        const startedAt = Date.now();
        const pendingCount = this.pendingByTarget.get(target)?.size ?? 0;
        browserInputDiagnosticLogger.info({
            msg: '[EmbeddedBrowserOperation] render-host-claim-foreground',
            phase: 'start',
            webContentsId: this.targetWebContentsId(target),
            pendingCount,
        });
        this.cancelTargetRequestsForForeground(target);
        this.setTargetOwnership(target, 'foreground');
        await this.waitForTarget(target);
        browserInputDiagnosticLogger.info({
            msg: '[EmbeddedBrowserOperation] render-host-claim-foreground',
            phase: 'complete',
            webContentsId: this.targetWebContentsId(target),
            pendingCount,
            durationMs: Date.now() - startedAt,
        });
    }
    releaseForeground(target) {
        if (!this.isForegroundOwned(target))
            return;
        this.setTargetOwnership(target, 'none');
    }
    destroy() {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const request of this.queue.splice(0)) {
            request.controller.abort('background-render-host-destroyed');
            this.settleRequest(request, 'reject', this.unavailableError());
        }
        const windows = new Set();
        for (const slot of this.slots) {
            slot.activeRequest?.controller.abort('background-render-host-destroyed');
            if (slot.window)
                windows.add(slot.window);
            slot.window = null;
        }
        for (const hostWindow of windows) {
            if (!hostWindow.isDestroyed())
                hostWindow.destroy();
        }
    }
    ensureWindow(slot) {
        if (slot.window && !slot.window.isDestroyed())
            return slot.window;
        const hostWindow = (this.options.createWindow ?? createBackgroundWindow)(slot.index);
        slot.window = hostWindow;
        hostWindow.on('closed', () => {
            if (slot.window === hostWindow)
                slot.window = null;
        });
        return hostWindow;
    }
    startRequest(request, slot) {
        if (request.settled) {
            this.startAvailableRequests();
            return;
        }
        // A request can sit behind another tab on the shared compositor. Recheck
        // ownership at dequeue time so a foreground reveal that happened while it
        // waited cannot be undone by a stale background attachment.
        if (this.isForegroundOwned(request.target)) {
            request.controller.abort('background-render-target-claimed-by-foreground');
            this.settleRequest(request, 'reject', this.foregroundClaimError());
            this.startAvailableRequests();
            return;
        }
        if (request.queueTimer)
            clearTimeout(request.queueTimer);
        request.queueTimer = undefined;
        request.started = true;
        request.ownershipGeneration = this.setTargetOwnership(request.target, 'background');
        slot.activeRequest = request;
        this.lastScheduledKey = request.schedulingKey;
        const startedAt = Date.now();
        browserInputDiagnosticLogger.info({
            msg: '[EmbeddedBrowserOperation] render-host-active',
            phase: 'start',
            webContentsId: this.targetWebContentsId(request.target),
            schedulingKey: request.schedulingKey,
            slotIndex: slot.index,
            queueLength: this.queue.length,
        });
        void (async () => {
            let attached = false;
            try {
                if (this.disposed)
                    throw this.unavailableError();
                if (request.controller.signal.aborted)
                    throw this.abortedError();
                const hostWindow = this.ensureWindow(slot);
                hostWindow.setBounds({
                    x: -10000,
                    y: -10000,
                    width: request.renderBounds.width,
                    height: request.renderBounds.height,
                });
                request.target.attachToParent(hostWindow, request.renderBounds);
                attached = true;
                const webContents = request.target.getWebContents();
                if (webContents && !webContents.isDestroyed()) {
                    try {
                        webContents.invalidate();
                    }
                    catch {
                        // The renderer may navigate or exit while it is being attached.
                    }
                }
                const result = await this.runActiveOperation(request);
                if (request.controller.signal.aborted)
                    throw this.abortedError();
                this.settleRequest(request, 'resolve', result);
            }
            catch (error) {
                this.settleRequest(request, 'reject', error);
            }
            finally {
                // Negative bounds detach the view while preserving the WebContents and
                // its authenticated DOM/form state for the next action or foreground reveal.
                if (attached && this.isBackgroundOwner(request)) {
                    request.target.setBounds(OFFSCREEN_BOUNDS);
                }
                if (this.isBackgroundOwner(request)) {
                    this.setTargetOwnership(request.target, 'none');
                }
                if (slot.activeRequest === request)
                    slot.activeRequest = null;
                this.cleanupRequest(request);
                browserInputDiagnosticLogger.info({
                    msg: '[EmbeddedBrowserOperation] render-host-active',
                    phase: 'settled',
                    webContentsId: this.targetWebContentsId(request.target),
                    schedulingKey: request.schedulingKey,
                    slotIndex: slot.index,
                    durationMs: Date.now() - startedAt,
                    aborted: request.controller.signal.aborted,
                    queueLength: this.queue.length,
                });
                this.startAvailableRequests();
            }
        })();
    }
    startAvailableRequests() {
        if (this.disposed)
            return;
        for (const slot of this.slots) {
            if (slot.activeRequest)
                continue;
            const next = this.takeNextRunnableRequest();
            if (!next)
                return;
            this.startRequest(next, slot);
        }
    }
    takeNextRunnableRequest() {
        const runnableIndexes = [];
        for (let index = 0; index < this.queue.length; index += 1) {
            const request = this.queue[index];
            if (!request || request.settled)
                continue;
            if (this.isForegroundOwned(request.target)) {
                this.queue.splice(index, 1);
                index -= 1;
                request.controller.abort('background-render-target-claimed-by-foreground');
                this.settleRequest(request, 'reject', this.foregroundClaimError());
                continue;
            }
            if (!this.isTargetActive(request.target))
                runnableIndexes.push(index);
        }
        if (runnableIndexes.length === 0)
            return null;
        const fairIndex = runnableIndexes.find((index) => this.queue[index]?.schedulingKey !== this.lastScheduledKey);
        const selectedIndex = fairIndex ?? runnableIndexes[0];
        if (selectedIndex === undefined)
            return null;
        return this.queue.splice(selectedIndex, 1)[0] ?? null;
    }
    bindExternalAbort(request) {
        const signal = request.externalSignal;
        if (!signal)
            return;
        const abort = () => {
            browserInputDiagnosticLogger.warn({
                msg: '[EmbeddedBrowserOperation] render-host-external-abort',
                webContentsId: this.targetWebContentsId(request.target),
                started: request.started,
            });
            request.controller.abort(signal.reason);
            if (request.started || !this.removeQueuedRequest(request))
                return;
            this.settleRequest(request, 'reject', this.abortedError());
        };
        request.externalAbortListener = abort;
        signal.addEventListener('abort', abort, { once: true });
    }
    runActiveOperation(request) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer;
            const finish = (outcome, value) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                timer = undefined;
                request.controller.signal.removeEventListener('abort', onAbort);
                if (outcome === 'resolve')
                    resolve(value);
                else
                    reject(value);
            };
            const onAbort = () => finish('reject', this.abortedError());
            request.controller.signal.addEventListener('abort', onAbort, { once: true });
            timer = setTimeout(() => {
                const error = new BackgroundBrowserRenderError('BACKGROUND_RENDER_OPERATION_TIMEOUT', `active Browser action exceeded ${request.operationTimeoutMs}ms`);
                finish('reject', error);
                request.controller.abort('background-render-operation-timeout');
                const webContents = request.target.getWebContents();
                if (webContents && !webContents.isDestroyed()) {
                    try {
                        webContents.stop();
                    }
                    catch {
                        // The page may exit while the timeout is being handled.
                    }
                }
            }, request.operationTimeoutMs);
            timer.unref?.();
            void request.operation(request.controller.signal).then((value) => finish('resolve', value), (error) => finish('reject', error));
        });
    }
    cancelTargetRequestsForForeground(target) {
        for (const slot of this.slots) {
            const active = slot.activeRequest;
            if (active?.target === target) {
                active.controller.abort('background-render-target-claimed-by-foreground');
            }
        }
        for (const request of [...this.queue]) {
            if (request.target !== target || !this.removeQueuedRequest(request))
                continue;
            request.controller.abort('background-render-target-claimed-by-foreground');
            this.settleRequest(request, 'reject', this.foregroundClaimError());
        }
    }
    removeQueuedRequest(request) {
        const index = this.queue.indexOf(request);
        if (index < 0)
            return false;
        this.queue.splice(index, 1);
        return true;
    }
    settleRequest(request, outcome, value) {
        if (request.settled)
            return;
        request.settled = true;
        this.cleanupRequest(request);
        if (outcome === 'resolve')
            request.resolve(value);
        else
            request.reject(value);
    }
    cleanupRequest(request) {
        if (request.queueTimer)
            clearTimeout(request.queueTimer);
        request.queueTimer = undefined;
        if (request.externalSignal && request.externalAbortListener) {
            request.externalSignal.removeEventListener('abort', request.externalAbortListener);
        }
        request.externalAbortListener = undefined;
    }
    maxQueuedRequests() {
        return Math.max(0, this.options.maxQueuedRequests ?? DEFAULT_MAX_QUEUED_REQUESTS);
    }
    slotCount() {
        return Math.min(MAX_SLOT_COUNT, Math.max(1, Math.floor(this.options.slotCount ?? DEFAULT_SLOT_COUNT)));
    }
    activeRequestCount() {
        return this.slots.reduce((count, slot) => count + (slot.activeRequest ? 1 : 0), 0);
    }
    findIdleSlot() {
        return this.slots.find((slot) => slot.activeRequest === null) ?? null;
    }
    isTargetActive(target) {
        return this.slots.some((slot) => slot.activeRequest?.target === target);
    }
    targetWebContentsId(target) {
        const webContents = target.getWebContents();
        return webContents && !webContents.isDestroyed() ? webContents.id : null;
    }
    normalizeRenderBounds(bounds) {
        if (!bounds)
            return BACKGROUND_BROWSER_RENDER_BOUNDS;
        return {
            x: 0,
            y: 0,
            width: Math.max(1, Math.round(bounds.width)),
            height: Math.max(1, Math.round(bounds.height)),
        };
    }
    maxQueuedPerTarget() {
        return Math.max(0, this.options.maxQueuedPerTarget ?? DEFAULT_MAX_QUEUED_PER_TARGET);
    }
    abortedError() {
        return new BackgroundBrowserRenderError('ABORTED', 'Browser action was cancelled');
    }
    foregroundClaimError() {
        return new BackgroundBrowserRenderError('ABORTED', 'Browser action yielded to a foreground reveal');
    }
    isForegroundOwned(target) {
        return this.ownershipByTarget.get(target)?.owner === 'foreground';
    }
    isBackgroundOwner(request) {
        const ownership = this.ownershipByTarget.get(request.target);
        return (ownership?.owner === 'background' && ownership.generation === request.ownershipGeneration);
    }
    setTargetOwnership(target, owner) {
        const generation = (this.ownershipByTarget.get(target)?.generation ?? 0) + 1;
        this.ownershipByTarget.set(target, { generation, owner });
        return generation;
    }
    busyError(reason) {
        return new BackgroundBrowserRenderError('BACKGROUND_RENDER_BUSY', reason);
    }
    unavailableError() {
        return new BackgroundBrowserRenderError('BROWSER_UNAVAILABLE', 'Background Browser render host is unavailable');
    }
    trackTarget(target, completion) {
        const pending = this.pendingByTarget.get(target) ?? new Set();
        pending.add(completion);
        this.pendingByTarget.set(target, pending);
        void completion.finally(() => {
            pending.delete(completion);
            if (pending.size === 0)
                this.pendingByTarget.delete(target);
        });
    }
}

