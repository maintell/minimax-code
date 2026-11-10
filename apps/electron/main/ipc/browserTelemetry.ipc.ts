import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../config/constants.js";
import { browserTelemetry } from "../modules/browser/browser-telemetry-runtime.js";
import { isRegisteredMainRenderer } from "../windows/desktopRendererWindow.js";
import { trustedHost } from "./miniAppComposer.ipc.js";
const MAX_BATCH_VALUES = 500;
const DIAGNOSTICS_TIMEOUT_MS = 1500;
const LAYOUT_COMMANDS = new Set(['show', 'setBounds', 'hide']);
const BACKENDS = new Set(['web-contents-view', 'webview']);
function finiteNumbers(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .filter((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0)
        .slice(0, MAX_BATCH_VALUES);
}
function count(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.min(Math.round(value), 1000000)
        : undefined;
}
/** Renderer batches are untrusted input: keep only bounded numeric/enum signals. */
export function normalizeBrowserTelemetryBatch(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const input = raw;
    const batch = {};
    if (typeof input.rendererBackend === 'string' && BACKENDS.has(input.rendererBackend)) {
        batch.rendererBackend =
            input.rendererBackend;
    }
    const roundtrips = finiteNumbers(input.layoutRoundtripMs);
    if (roundtrips.length)
        batch.layoutRoundtripMs = roundtrips;
    const layoutCommands = count(input.layoutCommands);
    if (layoutCommands)
        batch.layoutCommands = layoutCommands;
    if (Array.isArray(input.layoutFailures)) {
        const failures = input.layoutFailures
            .filter((item) => !!item &&
            typeof item === 'object' &&
            LAYOUT_COMMANDS.has(item.command))
            .slice(0, 20)
            .map((item) => ({ command: item.command, attempts: count(item.attempts) ?? 0 }));
        if (failures.length)
            batch.layoutFailures = failures;
    }
    if (Array.isArray(input.drags)) {
        const drags = input.drags
            .filter((item) => !!item && typeof item === 'object')
            .slice(0, 50)
            .map((item) => {
            const drag = item;
            return {
                durationMs: count(drag.durationMs) ?? 0,
                lagFrames: count(drag.lagFrames) ?? 0,
                longFrames: count(drag.longFrames) ?? 0,
            };
        });
        if (drags.length)
            batch.drags = drags;
    }
    if (input.compatibility && typeof input.compatibility === 'object') {
        const compat = input.compatibility;
        const compatibility = {
            ...(count(compat.freeze) ? { freeze: count(compat.freeze) } : {}),
            ...(count(compat.nativeMenu) ? { nativeMenu: count(compat.nativeMenu) } : {}),
            ...(count(compat.parking) ? { parking: count(compat.parking) } : {}),
        };
        if (Object.keys(compatibility).length)
            batch.compatibility = compatibility;
    }
    return batch;
}
const pendingDiagnostics = new Map();
/** Reads renderer Browser state for the feedback bundle; null when unavailable. */
export function requestBrowserRendererDiagnostics(target) {
    if (!target || target.isDestroyed())
        return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise((resolve) => {
        const timer = setTimeout(() => finish(null), DIAGNOSTICS_TIMEOUT_MS);
        const finish = (value) => {
            clearTimeout(timer);
            pendingDiagnostics.delete(requestId);
            resolve(value);
        };
        pendingDiagnostics.set(requestId, { owner: target, resolve: finish });
        try {
            target.send(IPC_CHANNELS.BROWSER_TELEMETRY_DIAGNOSTICS_REQUEST, requestId);
        }
        catch {
            finish(null);
        }
    });
}
export function setupBrowserTelemetryIPC() {
    const trusted = (event) => trustedHost(event) && isRegisteredMainRenderer(event.sender);
    const report = (event, raw) => {
        if (!trusted(event))
            return;
        const batch = normalizeBrowserTelemetryBatch(raw);
        if (batch)
            browserTelemetry.rendererBatch(batch);
    };
    const respond = (event, requestId, state) => {
        if (typeof requestId !== 'string')
            return;
        const pending = pendingDiagnostics.get(requestId);
        if (!pending || pending.owner !== event.sender)
            return;
        pending.resolve(state && typeof state === 'object' ? state : null);
    };
    ipcMain.on(IPC_CHANNELS.BROWSER_TELEMETRY_REPORT, report);
    ipcMain.on(IPC_CHANNELS.BROWSER_TELEMETRY_DIAGNOSTICS_RESPONSE, respond);
    return () => {
        ipcMain.removeListener(IPC_CHANNELS.BROWSER_TELEMETRY_REPORT, report);
        ipcMain.removeListener(IPC_CHANNELS.BROWSER_TELEMETRY_DIAGNOSTICS_RESPONSE, respond);
        for (const pending of pendingDiagnostics.values())
            pending.resolve(null);
        pendingDiagnostics.clear();
    };
}
