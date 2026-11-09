/** Started or restored this recently: still foreground, so it cannot be put back to sleep at once. */
const MINIAPP_START_GRACE_MS = 60_000;
/** A Mini App stays `active` this long after the last Host request it sent ended. */
const MINIAPP_ACTIVITY_GRACE_MS = 10 * 60_000;
/** Under moderate pressure a page must have been hidden at least this long. */
const MINIAPP_MODERATE_PAGE_HIDDEN_MS = 10 * 60_000;
/** Latest user attention: recorded events, a visible tab (now), or a tab's hidden time. */
export function miniAppLastAttendedAt(pluginId, input) {
    let latest = input.recordedAttentionMs(pluginId);
    for (const tab of input.tabs) {
        if (tab.pluginId !== pluginId)
            continue;
        const attendedAt = tab.state === 'visible' ? input.nowMs : tab.hiddenAtMs;
        if (attendedAt !== undefined && (latest === undefined || attendedAt > latest)) {
            latest = attendedAt;
        }
    }
    return latest;
}
/** Highest tier each running plugin meets; only Host-observed state decides it. */
export function classifyMiniAppTiers(input) {
    return [...new Set(input.runningPluginIds)].map((pluginId) => {
        const lastAttendedAtMs = miniAppLastAttendedAt(pluginId, input);
        const startedAtMs = input.startedAtMs(pluginId);
        const protection = protectionOf(pluginId, input, startedAtMs);
        return {
            pluginId,
            tier: tierOf(protection),
            ...(protection ? { protection } : {}),
            ...(lastAttendedAtMs !== undefined ? { lastAttendedAtMs } : {}),
            ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        };
    });
}
function protectionOf(pluginId, input, startedAtMs) {
    if (input.tabs.some((tab) => tab.pluginId === pluginId && tab.state === 'visible')) {
        return 'visible';
    }
    if (input.heldForTurn(pluginId))
        return 'in_use';
    if (isInTransition(pluginId, input, startedAtMs))
        return 'transition';
    if (isActive(input.activity(pluginId), input.nowMs))
        return 'active';
    return undefined;
}
/** Serving a request now, or the last one ended less than the grace ago. */
function isActive(reading, nowMs) {
    return (reading.inFlight > 0 ||
        (reading.lastEndedAtMs !== undefined &&
            nowMs - reading.lastEndedAtMs < MINIAPP_ACTIVITY_GRACE_MS));
}
/** Starting, publishing, restarting or stopping, or started less than a minute ago. */
function isInTransition(pluginId, input, startedAtMs) {
    return (input.isStarting(pluginId) ||
        input.phaseOf(pluginId) !== 'active' ||
        (startedAtMs !== undefined && input.nowMs - startedAtMs < MINIAPP_START_GRACE_MS));
}
function tierOf(protection) {
    switch (protection) {
        case undefined:
            return 'normal';
        case 'active':
            return 'active';
        default:
            return 'foreground';
    }
}
/** Least recently attended first; never attended sorts first; ties: the earlier start first. */
function compareByAttention(left, right) {
    return (compareEarliestFirst(left.lastAttendedAtMs, right.lastAttendedAtMs) ||
        compareEarliestFirst(left.startedAtMs, right.startedAtMs) ||
        (left.pluginId < right.pluginId ? -1 : 1));
}
/** An unknown time sorts before every known one. */
function compareEarliestFirst(left, right) {
    const leftMs = left ?? Number.NEGATIVE_INFINITY;
    const rightMs = right ?? Number.NEGATIVE_INFINITY;
    if (leftMs === rightMs)
        return 0;
    return leftMs < rightMs ? -1 : 1;
}
/** Who may sleep whole to free a slot for a user's open: the `normal` tier only. */
export function admissionEvictionCandidates(tiers) {
    return tiers.filter((entry) => entry.tier === 'normal').sort(compareByAttention);
}
/**
 * Hidden pages, earliest hidden first, one per (session, plugin). Only the page's own state counts:
 * not the plugin's tier, not whether its backend runs. A session with a visible tab of the plugin
 * is not a candidate.
 */
function hiddenPageCandidates(tabs) {
    const pages = new Map();
    const visible = new Set();
    for (const tab of tabs) {
        const key = pageKey(tab);
        if (tab.state === 'visible')
            visible.add(key);
        if (tab.state !== 'hidden' || tab.hiddenAtMs === undefined)
            continue;
        const known = pages.get(key);
        if (!known || tab.hiddenAtMs < known.hiddenAtMs) {
            pages.set(key, {
                sessionId: tab.sessionId,
                pluginId: tab.pluginId,
                hiddenAtMs: tab.hiddenAtMs,
            });
        }
    }
    return [...pages.entries()]
        .filter(([key]) => !visible.has(key))
        .map(([, page]) => page)
        .sort((left, right) => left.hiddenAtMs - right.hiddenAtMs);
}
/** Ordered units the pressure loop may reclaim at `pressure`; `normal` reclaims nothing. */
export function pressureReclaimCandidates(input) {
    if (input.pressure === 'normal')
        return [];
    const pages = hiddenPageCandidates(input.tabs);
    if (input.pressure === 'moderate') {
        return pages
            .filter((page) => input.nowMs - page.hiddenAtMs >= MINIAPP_MODERATE_PAGE_HIDDEN_MS)
            .map((page) => ({ unit: 'page', page }));
    }
    return [
        ...pages.map((page) => ({ unit: 'page', page })),
        ...['normal', 'active'].flatMap((tier) => input.tiers
            .filter((entry) => entry.tier === tier)
            .sort(compareByAttention)
            .map((app) => ({ unit: 'app', app }))),
    ];
}
export function pageKey(page) {
    return `${page.sessionId}\u0000${page.pluginId}`;
}
//# sourceMappingURL=tiers.js.map