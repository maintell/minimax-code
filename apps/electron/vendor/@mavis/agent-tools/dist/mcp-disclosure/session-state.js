import { serverOfToolEntry } from './search-index.js';
const MAX_SESSIONS = 512;
const states = new Map();
const NOTHING_TOLD = {
    told: { snapshot: new Map(), everTold: false },
    addedInWindow: new Map(),
    changedInWindow: new Set(),
};
/** The session's state, created on demand; access refreshes its place in the LRU. */
export function toolSearchSessionState(sessionId) {
    const existing = states.get(sessionId);
    if (existing) {
        states.delete(sessionId);
        states.set(sessionId, existing);
        return existing;
    }
    if (states.size >= MAX_SESSIONS) {
        const oldest = states.keys().next().value;
        if (oldest !== undefined)
            states.delete(oldest);
    }
    const created = {
        told: new Map(),
        everTold: false,
        addedInWindow: new Map(),
        changedInWindow: new Set(),
        historyChecked: false,
        discovered: [],
        carried: [],
    };
    states.set(sessionId, created);
    return created;
}
/** What a catalog build reads; never creates state but refreshes an existing entry. */
export function toolSearchWindowOf(sessionId) {
    if (!states.has(sessionId))
        return NOTHING_TOLD;
    const state = toolSearchSessionState(sessionId);
    return {
        ...(state.window ? { current: state.window } : {}),
        told: hasUnconfirmedNotice(state)
            ? { snapshot: undefined, everTold: true }
            : {
                snapshot: state.told,
                everTold: state.everTold,
                ...(state.toldText === undefined ? {} : { text: state.toldText }),
            },
        addedInWindow: state.addedInWindow,
        changedInWindow: state.changedInWindow,
    };
}
/** The latest notice may be in the history, though no request confirmed it. */
function hasUnconfirmedNotice(state) {
    return state.pending !== undefined && !state.pending.confirmed;
}
/** What the notices in the history say can no longer be known. */
function forgetTold(state) {
    state.told = undefined;
    state.toldText = undefined;
}
/** An unconfirmed notice stops being pending: it stays a possible notice in the history. */
function retirePendingNotice(state) {
    if (!hasUnconfirmedNotice(state))
        return;
    forgetTold(state);
    state.everTold = true;
}
/** Drops the session's state; a disposed session starts empty if it ever returns. */
export function forgetToolSearchSessionState(sessionId) {
    states.delete(sessionId);
}
/** Test seam: every Session starts empty again. */
export function forgetAllToolSearchSessionStates() {
    states.clear();
}
/**
 * Stores a Turn's window (none: Tool Search is off for its model) and the notice
 * its user message carries, which only counts once a request sends it
 * (`confirmToolSearchAnnouncement`); the notice it replaces no longer can.
 * Without a notice the deviation is what the model was already told. A new
 * window only replaces the current one once a request of the Turn is answered
 * (`receiveToolSearchResponse`): a Turn that gets no answer (cancelled before
 * its first request, rejected by the provider, or stopped before the first
 * token) wrote no prompt cache, so it freezes nothing and the next Turn plans
 * afresh. `onEffective` runs when the new window takes effect.
 */
export function commitToolSearchWindow(sessionId, window, notice, nowMs, onEffective) {
    const state = toolSearchSessionState(sessionId);
    state.unsentWindow =
        !window || state.window !== window
            ? { window, atMs: nowMs, sent: false, ...(onEffective ? { onEffective } : {}) }
            : undefined;
    retirePendingNotice(state);
    state.latestTurnCarriedNotice = notice !== undefined;
    state.pending = notice
        ? {
            text: notice.text,
            deviation: notice.availability.deviation,
            added: new Map(notice.availability.added.map((entry) => [entry.tool.def.name, serverOfToolEntry(entry)])),
            confirmed: false,
        }
        : undefined;
}
/** The window the latest Turn planned and that has not taken effect; hooks of that Turn hold on to it. */
export function plannedToolSearchWindow(sessionId) {
    return states.get(sessionId)?.unsentWindow;
}
/**
 * A request of the Turn that planned `planned` was answered: that window becomes
 * the Session's. Only when it is still the latest Turn's plan and the Turn's
 * request hook ran for a request: a reply the host made up without a provider
 * request (a `respond` decision ends the hook chain first), or the late answer
 * of an earlier Turn's request, makes no window. Its notice was confirmed on
 * send, earlier; a new window's notice states no deviation, so clearing what
 * notices announced in the old window loses nothing it recorded.
 */
export function receiveToolSearchResponse(sessionId, planned) {
    const state = states.get(sessionId);
    const unsent = state?.unsentWindow;
    if (!state || !unsent || unsent !== planned || !unsent.sent)
        return;
    state.unsentWindow = undefined;
    state.window = unsent.window;
    state.windowStartedAtMs = unsent.window ? unsent.atMs : undefined;
    state.addedInWindow.clear();
    state.changedInWindow.clear();
    try {
        unsent.onEffective?.();
    }
    catch {
        // Diagnostics must not affect the Turn.
    }
}
/** The window the latest Turn declares: the one it planned, in effect or not. */
export function toolSearchTurnWindow(sessionId) {
    const state = states.get(sessionId);
    return state?.unsentWindow ? state.unsentWindow.window : state?.window;
}
/** The notice still waiting for a request to send it, if any. */
export function pendingToolSearchNotice(sessionId) {
    const pending = states.get(sessionId)?.pending;
    return pending && !pending.confirmed ? pending.text : undefined;
}
/** A request sent the pending notice: it is now the newest notice in the history. */
export function confirmToolSearchAnnouncement(sessionId) {
    const state = states.get(sessionId);
    const pending = state?.pending;
    if (!state || !pending || pending.confirmed)
        return;
    pending.confirmed = true;
    state.told = pending.deviation;
    state.toldText = pending.text;
    state.everTold = true;
    for (const [name, server] of pending.added)
        state.addedInWindow.set(name, server);
    for (const [name, entry] of pending.deviation) {
        if (entry.status === 'changed')
            state.changedInWindow.add(name);
    }
}
/**
 * The request history holds a notice this process did not send (a restart, a
 * fork): the next Turn states the full deviation, superseding it. Checked on the
 * first request of a Session that has told nothing yet, and again after the
 * history was rewound or restored (it may bring back such a notice from before a
 * compaction). Never creates state.
 */
export function noteToolSearchNoticeInHistory(sessionId, hasNotice) {
    const state = states.get(sessionId);
    if (!state || state.historyChecked)
        return;
    state.historyChecked = true;
    if (state.everTold || !hasNotice())
        return;
    state.everTold = true;
    forgetTold(state);
}
/**
 * A compaction durably replaced the history: the window ends and the next Turn
 * plans afresh against the tools it sees then. Notices may survive in the kept
 * recent tail, so a stated deviation becomes unknown and the next Turn sends a
 * notice that supersedes them. Nothing to supersede when the newest notice said
 * all tools are as shown: the tail keeps that one or none. Each host calls it
 * where the replacement is committed (local: next to the PTC mode refresh;
 * cloud: after the context lifecycle persisted the snapshot), so the very next
 * Turn already starts a new window; the request hook (`noteCompaction`) also
 * ends it on seeing a new summary. That is the fallback for history resumed
 * after a restart, and on cloud it usually comes first, because the hook runs
 * in the compacting request's pipeline before the commit. Never creates state.
 */
export function endToolSearchWindow(sessionId) {
    const state = states.get(sessionId);
    if (!state)
        return;
    state.window = undefined;
    state.windowStartedAtMs = undefined;
    state.unsentWindow = undefined;
    retirePendingNotice(state);
    if (state.told?.size)
        forgetTold(state);
    state.addedInWindow.clear();
    state.changedInWindow.clear();
    state.pending = undefined;
}
/**
 * User messages that may have carried notices left the history (a rewind, a
 * retracted Turn, a safety recall): what the model was told becomes unknown and
 * the next Turn states the full deviation again. The latest notice waits to be
 * sent again: a retry that re-sends the same user message confirms it once more.
 * The restored history may hold a notice of an earlier process (from before a
 * compaction), so the next request checks the history again. The window and its
 * declarations stay, so the prompt cache is unaffected. Never creates state.
 */
export function forgetToolSearchAnnouncements(sessionId) {
    const state = states.get(sessionId);
    if (!state)
        return;
    forgetTold(state);
    if (state.pending)
        state.pending.confirmed = false;
    state.historyChecked = false;
}
/**
 * Only the latest Turn left the history (a safety recall restores the history
 * before it, earlier notices included): what was told changes only when that
 * Turn carried a notice, sent or not, even when a compaction during the Turn
 * already dropped it as pending. Never creates state.
 */
export function forgetLatestTurnToolSearchNotice(sessionId) {
    if (states.get(sessionId)?.latestTurnCarriedNotice)
        forgetToolSearchAnnouncements(sessionId);
}
export function recordDiscoveredTools(sessionId, names) {
    const state = toolSearchSessionState(sessionId);
    for (const name of names) {
        const at = state.discovered.indexOf(name);
        if (at !== -1)
            state.discovered.splice(at, 1);
        state.discovered.push(name);
    }
}
/**
 * Called once per newly seen compaction summary: the window ends, and
 * everything discovered so far becomes the carried set. A summary written
 * before the window started (history resumed after a restart) keeps the window;
 * a summary without a usable time ends it.
 */
export function noteCompaction(sessionId, summaryKey, summaryAtMs) {
    const state = toolSearchSessionState(sessionId);
    if (state.lastSummaryKey === summaryKey)
        return false;
    state.lastSummaryKey = summaryKey;
    // A window not yet in effect starts when its Turn planned it: the history of a
    // resumed Session can hold older summaries before its first response arrives.
    const startedAtMs = state.unsentWindow?.window
        ? state.unsentWindow.atMs
        : state.windowStartedAtMs;
    const predatesWindow = startedAtMs !== undefined && summaryAtMs > 0 && summaryAtMs < startedAtMs;
    if (!predatesWindow)
        endToolSearchWindow(sessionId);
    state.carried = [...state.discovered];
    return true;
}
//# sourceMappingURL=session-state.js.map