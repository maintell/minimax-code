import { ipcMain } from "electron";
import { METRIC_DEFINITIONS, INGEST_NORMALIZED } from "@mavis/shared/local-runtime-logging/metric-registry";
import { IPC_CHANNELS } from "../config/constants.js";
import { incrementDesktopMetric, observeDesktopMetric } from "../modules/observability/desktop-metrics.js";
import { isRegisteredMainRenderer } from "../windows/desktopRendererWindow.js";
import { trustedHost } from "./miniAppComposer.ipc.js";
/** Points accepted per report; the renderer sends one or two at a time. */
export let MAX_UI_METRIC_POINTS = 20;
/** Longest value of a label gateway-app bounds on ingest (the model name). */
export let MAX_FREE_LABEL_LENGTH = 128;
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function isPlainRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function registeredUiDefinition(name) {
    if (typeof name !== 'string' || !name.startsWith('ui_'))
        return undefined;
    if (!hasOwn(METRIC_DEFINITIONS, name))
        return undefined;
    return METRIC_DEFINITIONS[name];
}
function allowedLabelValue(allowed, value) {
    if (typeof value !== 'string')
        return false;
    if (allowed === INGEST_NORMALIZED) {
        return value.length > 0 && value.length <= MAX_FREE_LABEL_LENGTH;
    }
    return allowed.includes(value);
}
/** Exactly the registered label keys, each value in its enum. */
function normalizeLabels(definition, raw) {
    if (!isPlainRecord(raw))
        return undefined;
    const keys = Object.keys(definition.labels);
    if (Object.keys(raw).length !== keys.length)
        return undefined;
    const labels = {};
    for (const key of keys) {
        const value = raw[key];
        if (!hasOwn(raw, key) || !allowedLabelValue(definition.labels[key], value)) {
            return undefined;
        }
        labels[key] = value;
    }
    return labels;
}
function normalizePoint(raw) {
    if (!isPlainRecord(raw))
        return undefined;
    const definition = registeredUiDefinition(raw.name);
    const value = raw.value;
    if (!definition || typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return undefined;
    }
    const labels = normalizeLabels(definition, raw.labels);
    if (!labels)
        return undefined;
    return definition.type === 'counter'
        ? { type: 'counter', name: raw.name, value, labels }
        : { type: 'histogram', name: raw.name, value, labels };
}
/**
 * Renderer reports are untrusted: keep only registered `ui_*` metrics whose
 * labels are exactly the registered keys with enumerated values, and whose
 * value is finite and non-negative. At most {@link MAX_UI_METRIC_POINTS} per
 * report; anything else is dropped point by point.
 */
export function normalizeUiMetricReport(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.slice(0, MAX_UI_METRIC_POINTS).flatMap((item) => {
        const point = normalizePoint(item);
        return point ? [point] : [];
    });
}
function reportPoint(point) {
    // Validated above against the registry, so the labels match the name.
    if (point.type === 'counter') {
        incrementDesktopMetric(point.name, point.value, point.labels);
    }
    else {
        observeDesktopMetric(point.name, point.value, point.labels);
    }
}
export function setupUiMetricsIPC() {
    const report = (event, raw) => {
        if (!trustedHost(event) || !isRegisteredMainRenderer(event.sender))
            return;
        for (const point of normalizeUiMetricReport(raw))
            reportPoint(point);
    };
    ipcMain.on(IPC_CHANNELS.OBSERVABILITY_REPORT_METRICS, report);
    return () => {
        ipcMain.removeListener(IPC_CHANNELS.OBSERVABILITY_REPORT_METRICS, report);
    };
}
