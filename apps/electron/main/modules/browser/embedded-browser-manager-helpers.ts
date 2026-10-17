import { serializeSemanticTreePage } from "@mavis/browser-core";
export let DEFAULT_BOUNDS = { x: -10000, y: -10000, width: 800, height: 600 };
export let OFFSCREEN_BOUNDS = { x: -10000, y: -10000, width: 800, height: 600 };
export let PENDING_COMMENT_EVENT_LIMIT = 500;
export let HIDDEN_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export let HIDDEN_LOADING_GRACE_MS = 2 * 60 * 1000;
export let HIDDEN_SWEEP_INTERVAL_MS = 60 * 1000;
export let MAX_HIDDEN_TABS = 3;
export let ENABLE_BROWSER_INPUT_DIAGNOSTICS = process.env.NODE_ENV !== 'production';
export let MAX_AGENT_SNAPSHOT_ELEMENTS = 500;
export let MAX_AGENT_SNAPSHOTS_PER_TAB = 3;
export let AGENT_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
export let DEFAULT_AGENT_SNAPSHOT_PAGE_LIMIT = 100;
export let MAX_AGENT_SNAPSHOT_PAGE_LIMIT = 200;
// Reserve room for reading/safety guidance added by the outer Browser tool.
export let MAX_AGENT_SNAPSHOT_PAGE_BYTES = 56 * 1024;
export let AGENT_BROWSER_ACTIONS = new Set([
    'inspect',
    'query',
    'navigate',
    'open_tab',
    'back',
    'forward',
    'reload',
    'click',
    'click_and_wait_for_navigation',
    'double_click',
    'drag',
    'hover',
    'fill',
    'type',
    'press_key',
    'check',
    'uncheck',
    'select_option',
    'scroll',
    'wait',
    'screenshot',
    'upload_files',
    'paste',
]);
export function asRecord(value) {
    return value !== null && typeof value === 'object' ? value : {};
}
export function asString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}
export function asNumber(value, fallback = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
export function asBoolean(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
}
export function asStringArray(value) {
    if (Array.isArray(value)) {
        return value.filter((item) => typeof item === 'string' && item.length > 0);
    }
    return typeof value === 'string' && value.length > 0 ? [value] : [];
}
export function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function normalizeBrowserTarget(target) {
    const raw = asRecord(target);
    const tabId = finiteNumber(raw.tabId);
    return {
        ...(tabId !== null && tabId > 0 ? { tabId: Math.floor(tabId) } : {}),
        ...(typeof raw.sessionId === 'string'
            ? { sessionId: raw.sessionId }
            : raw.sessionId === null
                ? { sessionId: null }
                : {}),
    };
}
export function nowMs() {
    return Date.now();
}
export function safeError(error) {
    return error instanceof Error ? error.message : String(error);
}
export function presentationLoadError(existing, result, requestedUrl) {
    const loadResult = asRecord(result);
    if (loadResult.success !== false || existing)
        return existing;
    return {
        code: 0,
        description: safeError(loadResult.error ?? 'Presentation navigation failed'),
        url: requestedUrl,
        ts: nowMs(),
    };
}
export function assertBrowserTabBelongsToSession(tab, requestedSessionId) {
    if (tab.sessionId === requestedSessionId)
        return;
    throw new Error([
        'Embedded browser target mismatch',
        `requestedSessionId=${requestedSessionId}`,
        `requestedTabId=${tab.tabId}`,
        `actualSessionId=${tab.sessionId ?? 'legacy'}`,
    ].join(' '));
}
export function urlHost(value) {
    if (!value)
        return null;
    try {
        return new URL(value).host || null;
    }
    catch {
        return null;
    }
}
export function requireStringArg(args, key) {
    const value = asString(args[key]).trim();
    if (!value)
        throw new Error(`${key} is required`);
    return value;
}
export function requireTextArg(args, key) {
    const value = args[key];
    if (typeof value !== 'string')
        throw new Error(`${key} must be a string`);
    return value;
}
export function asCommentRenumberMap(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .map((item) => {
        const record = asRecord(item);
        const oldId = asNumber(record.oldId);
        const newId = asNumber(record.newId);
        return oldId > 0 && newId > 0 ? { oldId, newId } : null;
    })
        .filter((item) => Boolean(item));
}
export function shortcutModifier() {
    return process.platform === 'darwin' ? 'Meta' : 'Control';
}
export function normalizeUrl(url) {
    const trimmed = url.trim();
    if (!trimmed)
        return '';
    if (/^(https?|file|data|about):/iu.test(trimmed))
        return trimmed;
    if (/^localhost(:\d+)?([/?#]|$)/iu.test(trimmed))
        return `http://${trimmed}`;
    if (/^\d{1,3}(?:\.\d{1,3}){3}(:\d+)?([/?#]|$)/u.test(trimmed)) {
        return `http://${trimmed}`;
    }
    if (/^[\w.-]+\.[a-z]{2,}(:\d+)?([/?#]|$)/iu.test(trimmed))
        return `https://${trimmed}`;
    if (/^[a-z0-9-]+$/iu.test(trimmed))
        return `https://www.${trimmed}.com`;
    return `https://www.baidu.com/s?wd=${encodeURIComponent(trimmed)}`;
}
export function isMainDocumentNavigation(args) {
    const details = asRecord(args[1]);
    if ('isMainFrame' in details || 'isSameDocument' in details) {
        return details.isMainFrame !== false && details.isSameDocument !== true;
    }
    const isInPlace = args[2];
    const isMainFrame = args[3];
    return isMainFrame !== false && isInPlace !== true;
}
export function normalizeCommentSelectionMode(value) {
    return value === 'free_rect' ? 'free_rect' : 'dom_node';
}
function asStringRecord(value) {
    const record = asRecord(value);
    return Object.fromEntries(Object.entries(record)
        .slice(0, 32)
        .filter((entry) => typeof entry[1] === 'string')
        .map(([key, item]) => [key.slice(0, 100), item.slice(0, 500)]));
}
function normalizeDomCandidates(value) {
    if (!Array.isArray(value))
        return [];
    return value.slice(0, 8).map((candidate) => {
        const record = asRecord(candidate);
        const rect = asRecord(record.rect);
        return {
            selector: asString(record.selector).slice(0, 1000),
            tagName: asString(record.tagName, 'element').slice(0, 100),
            text: asString(record.text).slice(0, 180),
            attributes: asStringRecord(record.attributes),
            rect: {
                x: asNumber(rect.x),
                y: asNumber(rect.y),
                width: asNumber(rect.width),
                height: asNumber(rect.height),
            },
            targetPath: asString(record.targetPath).slice(0, 2000),
            overlapRatio: asNumber(record.overlapRatio),
            containsCenter: asBoolean(record.containsCenter),
            score: asNumber(record.score),
        };
    });
}
export function normalizeCommentPayload(value) {
    const payload = asRecord(value);
    const rect = asRecord(payload.rect);
    const viewport = asRecord(payload.viewport);
    const commentId = asNumber(payload.commentId);
    const feedback = asString(payload.feedback).trim().slice(0, 4000);
    if (!commentId || !feedback)
        return null;
    const domCandidates = normalizeDomCandidates(payload.domCandidates);
    return {
        selectionMode: normalizeCommentSelectionMode(payload.selectionMode),
        selector: asString(payload.selector).slice(0, 1000),
        tagName: asString(payload.tagName, 'element').slice(0, 100),
        text: asString(payload.text).slice(0, 220),
        attributes: asStringRecord(payload.attributes),
        rect: {
            x: asNumber(rect.x),
            y: asNumber(rect.y),
            width: asNumber(rect.width),
            height: asNumber(rect.height),
        },
        viewport: {
            width: asNumber(viewport.width),
            height: asNumber(viewport.height),
        },
        pageUrl: asString(payload.pageUrl, 'about:blank').slice(0, 4000),
        targetPath: asString(payload.targetPath).slice(0, 2000),
        commentId,
        feedback,
        ...(domCandidates.length > 0 ? { domCandidates } : {}),
    };
}
export function agentElementPriority(element) {
    if (element.isInViewport && element.isInteractable)
        return 0;
    if (element.isInViewport)
        return 1;
    if (element.isInteractable)
        return 2;
    return 3;
}
export function agentSnapshotSummary(result) {
    const source = asRecord(result);
    const summary = { success: source.success !== false };
    if (typeof source.url === 'string')
        summary.url = source.url.slice(0, 4000);
    if (typeof source.title === 'string')
        summary.title = source.title.slice(0, 1000);
    if (typeof source.error === 'string')
        summary.error = source.error.slice(0, 2000);
    if (typeof source.duration === 'number' && Number.isFinite(source.duration)) {
        summary.duration = source.duration;
    }
    return summary;
}
export function agentSnapshotElement(ref, frameRef, element) {
    return {
        ref,
        tag: element.tag.slice(0, 80),
        type: element.type.slice(0, 120),
        text: element.text.slice(0, 300),
        selector: element.selector.slice(0, 500),
        attributes: Object.fromEntries(Object.entries(element.attributes)
            .slice(0, 20)
            .map(([key, value]) => [key.slice(0, 120), value.slice(0, 300)])),
        ...(element.coordinateSpace !== 'unavailable' ? { rect: { ...element.boundingBox } } : {}),
        inViewport: element.isInViewport,
        actionable: element.isInteractable,
        frame: frameRef,
    };
}
export function buildAgentSnapshotPage(snapshot, offset, totalElements, elements, continuationKind = 'inspect', options = {}) {
    const nextOffset = offset + elements.length;
    const truncated = nextOffset < totalElements;
    let semanticTree = null;
    if (options.includeSemanticTree !== false &&
        continuationKind === 'inspect' &&
        snapshot.semanticTree &&
        snapshot.semanticTargetRefs) {
        try {
            semanticTree = serializeSemanticTreePage(snapshot.semanticTree, snapshot.semanticTargetRefs, new Set(elements.map((element) => asString(element.ref)).filter(Boolean)));
        }
        catch {
            // Semantic context is additive. A malformed tree must not break legacy inspect output.
            semanticTree = null;
        }
    }
    return {
        ...snapshot.summary,
        snapshotId: snapshot.snapshotId,
        offset,
        totalElements,
        returnedElements: elements.length,
        ...(truncated ? { nextOffset } : {}),
        ...(truncated
            ? {
                continuation: continuationKind === 'inspect'
                    ? {
                        action: 'inspect',
                        input: { snapshotId: snapshot.snapshotId, offset: nextOffset },
                    }
                    : {
                        action: 'query',
                        input: {
                            kind: 'editable',
                            snapshotId: snapshot.snapshotId,
                            offset: nextOffset,
                        },
                    },
            }
            : {}),
        truncated,
        elements,
        ...(semanticTree && semanticTree.roots.length > 0 ? { semanticTree } : {}),
        ...(options.includeSemanticTree === false && snapshot.semanticTree
            ? { semanticTreeOmitted: { reason: 'result_budget' } }
            : {}),
    };
}
