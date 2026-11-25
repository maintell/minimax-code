import { normalizeSkillUsageKey, } from '@mavis/context-manager';
const MAX_SESSIONS = 512;
const states = new Map();
const NOTHING_TOLD = { snapshot: new Map(), everTold: false };
/** The Session's state, created on demand; access refreshes its place in the LRU. */
export function skillCatalogSessionState(sessionId) {
    const existing = states.get(sessionId);
    if (existing) {
        states.delete(sessionId);
        states.set(sessionId, existing);
        return existing;
    }
    const created = {
        told: new Map(),
        everTold: false,
        addedInWindow: new Map(),
        changedInWindow: new Set(),
        historyChecked: false,
        endedByCompaction: false,
        everEffective: false,
    };
    adoptSkillCatalogSessionState(sessionId, created);
    return created;
}
/** Makes `state` the Session's, replacing any it had; the newest entry of the LRU. */
export function adoptSkillCatalogSessionState(sessionId, state) {
    states.delete(sessionId);
    if (states.size >= MAX_SESSIONS) {
        const oldest = states.keys().next().value;
        if (oldest !== undefined)
            states.delete(oldest);
    }
    states.set(sessionId, state);
}
/** The state if the Session has one; never creates it or touches the LRU. */
export function peekSkillCatalogSessionState(sessionId) {
    return states.get(sessionId);
}
/** What the updates in the history tell the model; an unconfirmed latest one makes it unknown. */
export function skillToldState(state) {
    if (!state)
        return NOTHING_TOLD;
    return state.pending && !state.pending.confirmed
        ? { snapshot: undefined, everTold: true }
        : { snapshot: state.told, everTold: state.everTold };
}
/** An unconfirmed update stops being pending: it stays a possible update in the history. */
function retirePendingNotice(state) {
    if (!state.pending || state.pending.confirmed)
        return;
    state.told = undefined;
    state.everTold = true;
}
/**
 * Stores what a committing Turn planned: a new window (taking effect when a
 * request of the Turn is answered) or none (the current one continues), the
 * update its user message carries (told once a request sends it), and what its
 * prompt shows.
 */
export function commitSkillCatalogTurn(state, turn) {
    state.unsentWindow = turn.window ? { window: turn.window, sent: false } : undefined;
    retirePendingNotice(state);
    state.pending = turn.notice ? { ...turn.notice, confirmed: false } : undefined;
    state.turn = turn.view;
}
/** The window the latest Turn planned and that has not taken effect; its hooks hold on to it. */
export function plannedSkillCatalogWindow(sessionId) {
    return states.get(sessionId)?.unsentWindow;
}
/**
 * A request of the Turn that planned `planned` was answered: that window becomes
 * the Session's, if it is still the latest Turn's plan and the Turn's request
 * hook ran for a request (a reply the host made up, or the late answer of an
 * earlier Turn, makes no window).
 */
export function receiveSkillCatalogResponse(sessionId, planned) {
    const state = states.get(sessionId);
    const unsent = state?.unsentWindow;
    if (!state || !unsent || unsent !== planned || !unsent.sent)
        return;
    state.unsentWindow = undefined;
    state.window = unsent.window;
    state.endedByCompaction = false;
    state.everEffective = true;
    state.addedInWindow.clear();
    state.changedInWindow.clear();
}
/** The update still waiting for a request to send it, if any. */
export function pendingSkillCatalogNotice(sessionId) {
    const pending = states.get(sessionId)?.pending;
    return pending && !pending.confirmed ? pending.text : undefined;
}
/** A request sent the pending update: it is now the newest update in the history. */
export function confirmSkillCatalogAnnouncement(sessionId) {
    const state = states.get(sessionId);
    const pending = state?.pending;
    if (!state || !pending || pending.confirmed)
        return;
    pending.confirmed = true;
    state.told = pending.deviation;
    state.everTold = true;
    state.newestNotice = pending.text;
    for (const [key, entry] of pending.deviation) {
        if (entry.status === 'added')
            state.addedInWindow.set(key, entry.name);
        if (entry.status === 'changed')
            state.changedInWindow.add(key);
    }
}
/**
 * The request history holds an update this process did not send (a restart, a
 * fork): the next Turn states the full deviation, superseding it. Checked on the
 * first request of a Session that has told nothing yet, and again after the
 * history was rewound. Never creates state.
 */
export function noteSkillCatalogNoticeInHistory(sessionId, hasNotice) {
    const state = states.get(sessionId);
    if (!state || state.historyChecked)
        return;
    state.historyChecked = true;
    if (state.everTold || !hasNotice())
        return;
    state.everTold = true;
    state.told = undefined;
}
/**
 * Called for the latest compaction summary of each request: a new one ends the
 * window, unless it was written before the window started (history resumed after
 * a restart). A summary without a usable time ends it. Never creates state.
 */
export function noteSkillCatalogCompaction(sessionId, summaryKey, summaryAtMs) {
    const state = states.get(sessionId);
    if (!state || state.lastSummaryKey === summaryKey)
        return;
    state.lastSummaryKey = summaryKey;
    const startedAtMs = (state.unsentWindow?.window ?? state.window)?.startedAtMs;
    const predatesWindow = startedAtMs !== undefined && summaryAtMs > 0 && summaryAtMs < startedAtMs;
    if (!predatesWindow)
        endSkillCatalogWindow(sessionId);
}
/**
 * A compaction durably replaced the history (or a host reset the segment): the
 * window ends and the next Turn starts a new one against the Skills it finds.
 * Updates may survive in the kept recent tail, so a stated deviation becomes
 * unknown and the next Turn sends an update that supersedes them; nothing to
 * supersede when the newest one said all Skills are as shown. Never creates state.
 */
export function endSkillCatalogWindow(sessionId) {
    const state = states.get(sessionId);
    if (!state)
        return;
    state.window = undefined;
    state.unsentWindow = undefined;
    retirePendingNotice(state);
    if (state.told?.size)
        state.told = undefined;
    state.addedInWindow.clear();
    state.changedInWindow.clear();
    state.pending = undefined;
    state.endedByCompaction = true;
}
/**
 * User messages that may have carried updates left the history (a rewind, a
 * retracted Turn, a repair): what the model was told becomes unknown and the
 * next Turn states the full deviation again. The latest update waits to be sent
 * again, and the next request checks the history for updates of an earlier
 * process. The window stays, so the prompt cache is unaffected. Never creates state.
 */
export function forgetSkillCatalogAnnouncements(sessionId) {
    const state = states.get(sessionId);
    if (!state)
        return;
    state.told = undefined;
    state.newestNotice = undefined;
    if (state.pending)
        state.pending.confirmed = false;
    state.historyChecked = false;
}
/** Drops everything kept for a deleted Session. */
export function disposeSkillCatalogSession(sessionId) {
    states.delete(sessionId);
}
/** Skills an update of this window announced as added, sent or still pending. */
function announcedAdded(state, key) {
    return state.addedInWindow.has(key) || state.pending?.deviation.get(key)?.status === 'added';
}
/** How the latest committed Turn's prompt shows `name`. */
export function skillCatalogListing(sessionId, name) {
    const state = states.get(sessionId);
    if (!state?.turn)
        return 'unlisted';
    const key = normalizeSkillUsageKey(name);
    const listed = state.turn.listing.get(key);
    if (listed)
        return listed;
    return !state.turn.shadow && announcedAdded(state, key) ? 'notice' : 'unlisted';
}
/**
 * `name` is in the catalog the latest Turn shows or an update of this window
 * announced it as added, but the latest live Skills lack it. Shadow mode shows
 * the live Skills, so nothing is unavailable there.
 */
export function isSkillUnavailableInWindow(sessionId, name) {
    const state = states.get(sessionId);
    if (!state?.turn || state.turn.shadow)
        return false;
    const key = normalizeSkillUsageKey(name);
    if (state.turn.live.has(key))
        return false;
    // The window the latest Turn shows: the one it planned, in effect or not.
    const window = state.unsentWindow?.window ?? state.window;
    return Boolean(window?.entries.has(key)) || announcedAdded(state, key);
}
//# sourceMappingURL=state.js.map