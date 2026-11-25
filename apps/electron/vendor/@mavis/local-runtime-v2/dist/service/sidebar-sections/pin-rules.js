import { prependSession, releaseSection, withoutSection, withoutSessionInOrders } from './state.js';
/**
 * 置顶 and 分区 are mutually exclusive: 置顶 is itself a special block, so one
 * item lives in exactly one place. The renderer enforced this in
 * `archon-sidebar/section-membership.ts`; the rule now lives here so the
 * sidebar UI, the `sidebar_pin` tool and the `sidebar.section` tools all apply
 * the same one.
 *
 * Every function is pure: it takes a state and returns the next one, so the
 * service can compose them inside one serialized write.
 */
function isSession(target) {
    return 'sessionId' in target;
}
function targetKey(target) {
    return isSession(target) ? target.sessionId : target.projectKey;
}
function assignmentsOf(state, target) {
    return isSession(target) ? state.assignments : state.projectAssignments;
}
/** The section `target` sits in right now; read it before any pin update. */
export function sectionOf(state, target) {
    return assignmentsOf(state, target)[targetKey(target)];
}
/** Moving an item into a collapsed section reveals it, as the sidebar does. */
function expand(collapsed, sectionId) {
    return collapsed[sectionId] ? withoutSection(collapsed, sectionId) : { ...collapsed };
}
/**
 * Move a chat / project into a section, or out of every section when
 * `sectionId` is null. Unpinning the item first is the caller's job: it needs
 * the pin owner, which this pure layer deliberately does not know about.
 */
export function assignTarget(state, target, sectionId) {
    if (sectionId === null) {
        if (!(targetKey(target) in assignmentsOf(state, target)))
            return state;
        if (isSession(target)) {
            return {
                ...state,
                assignments: withoutSection(state.assignments, target.sessionId),
                sessionOrder: withoutSessionInOrders(state.sessionOrder, target.sessionId),
            };
        }
        return {
            ...state,
            projectAssignments: withoutSection(state.projectAssignments, target.projectKey),
        };
    }
    if (!state.sections.some((section) => section.id === sectionId))
        return state;
    const previous = sectionOf(state, target);
    if (isSession(target)) {
        const assignments = { ...state.assignments, [target.sessionId]: sectionId };
        return {
            ...state,
            assignments,
            collapsed: expand(state.collapsed, sectionId),
            // Moving in from elsewhere puts the row on top; re-picking the same
            // section keeps the user's manual order untouched.
            sessionOrder: previous === sectionId
                ? state.sessionOrder
                : prependSession(withoutSessionInOrders(state.sessionOrder, target.sessionId), sectionId, target.sessionId, assignments),
        };
    }
    return {
        ...state,
        projectAssignments: { ...state.projectAssignments, [target.projectKey]: sectionId },
        collapsed: expand(state.collapsed, sectionId),
    };
}
/**
 * Drop the section membership of items that are pinned. Never records `pinnedFrom`.
 *
 * @internal Exported only for focused tests.
 */
export function releasePinned(state, targets) {
    const sessions = new Set(targets.filter(isSession).map((target) => target.sessionId));
    const projects = new Set(targets
        .filter((target) => !isSession(target))
        .map((target) => target.projectKey));
    if (sessions.size === 0 && projects.size === 0)
        return state;
    const assignments = Object.fromEntries(Object.entries(state.assignments).filter(([id]) => !sessions.has(id)));
    const projectAssignments = Object.fromEntries(Object.entries(state.projectAssignments).filter(([key]) => !projects.has(key)));
    if (Object.keys(assignments).length === Object.keys(state.assignments).length &&
        Object.keys(projectAssignments).length === Object.keys(state.projectAssignments).length) {
        return state;
    }
    let sessionOrder = state.sessionOrder;
    for (const sessionId of sessions) {
        sessionOrder = withoutSessionInOrders(sessionOrder, sessionId);
    }
    return { ...state, assignments, projectAssignments, sessionOrder };
}
/**
 * Record (or, with `null`, forget) the section the item sat in before a pin.
 *
 * @internal Exported only for focused tests.
 */
export function setPinnedFrom(state, target, sectionId) {
    const key = targetKey(target);
    const bucket = isSession(target) ? state.pinnedFrom.sessions : state.pinnedFrom.projects;
    const next = sectionId && state.sections.some((section) => section.id === sectionId) ? sectionId : null;
    if ((bucket[key] ?? null) === next)
        return state;
    const nextBucket = { ...bucket };
    if (next)
        nextBucket[key] = next;
    else
        delete nextBucket[key];
    return {
        ...state,
        pinnedFrom: isSession(target)
            ? { ...state.pinnedFrom, sessions: nextBucket }
            : { ...state.pinnedFrom, projects: nextBucket },
    };
}
/**
 * After an unpin succeeds, move the item back into the section it left when it
 * was pinned — if that section still exists and the item was not placed
 * elsewhere meanwhile.
 *
 * @internal Exported only for focused tests.
 */
export function restoreUnpinned(state, targets, restore = true) {
    let next = state;
    for (const target of targets) {
        const key = targetKey(target);
        const bucket = isSession(target) ? next.pinnedFrom.sessions : next.pinnedFrom.projects;
        if (!(key in bucket))
            continue;
        const sectionId = bucket[key];
        next = setPinnedFrom(next, target, null);
        if (!restore || !sectionId || sectionOf(next, target) !== undefined)
            continue;
        next = assignTarget(next, target, sectionId);
    }
    return next;
}
/**
 * A pin request succeeded. Pin: remember the section the item was in right
 * before (or forget a stale one) and leave the section. Unpin: return to the
 * remembered section unless the user dropped it somewhere explicit.
 */
export function commitPin(state, target, input) {
    if (!input.pinned)
        return restoreUnpinned(state, [target], input.restore ?? true);
    // `undefined` means the caller named no section and the item is in none
    // either: keep whatever restore target is already recorded, so a caller that
    // only drops a stale membership does not lose where the unpin goes back to.
    // `null` is the caller explicitly saying there is none, which forgets it.
    const recorded = input.sectionBefore === undefined ? state : setPinnedFrom(state, target, input.sectionBefore);
    return releasePinned(recorded, [target]);
}
/**
 * A pin request failed. The optimistic pin may already have pulled the item out
 * of its section; put it back and forget any stale restore target. A failed
 * unpin changes nothing.
 */
export function rollbackPin(state, target, sectionBefore) {
    const next = setPinnedFrom(state, target, null);
    if (!sectionBefore || sectionOf(next, target) !== undefined)
        return next;
    if (!next.sections.some((section) => section.id === sectionBefore))
        return next;
    return assignTarget(next, target, sectionBefore);
}
/** Everything a delete must also clean: assignments, collapse, order and restore targets. */
export function deleteSection(state, sectionId) {
    return {
        sections: state.sections.filter((section) => section.id !== sectionId),
        assignments: releaseSection(state.assignments, sectionId),
        projectAssignments: releaseSection(state.projectAssignments, sectionId),
        collapsed: withoutSection(state.collapsed, sectionId),
        sessionOrder: withoutSection(state.sessionOrder, sectionId),
        pinnedFrom: {
            sessions: releaseSection(state.pinnedFrom.sessions, sectionId),
            projects: releaseSection(state.pinnedFrom.projects, sectionId),
        },
        blockOrder: state.blockOrder.filter((id) => id !== sectionId),
    };
}
//# sourceMappingURL=pin-rules.js.map