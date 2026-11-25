import { desktopProjectWorkspaceGroupKey } from '@mavis/shared/desktop-project-workspace-key';
import { SIDEBAR_PINNED_BLOCK_ID, SIDEBAR_SECTION_NAME_MAX_LENGTH, } from './contracts.js';
/**
 * Cleaning and ordering rules for the sections state. Every read and every
 * write goes through `sanitizeState`, so a hand-edited localStorage value, a
 * half-written Runtime row and a fresh state all behave the same way. The rules
 * mirror the renderer store's `loadPersisted`
 * (`packages/ui/src/store/sidebarSections.ts`) field for field.
 */
const EMPTY_SECTIONS_STATE = {
    sections: [],
    assignments: {},
    projectAssignments: {},
    collapsed: {},
    sessionOrder: {},
    pinnedFrom: { sessions: {}, projects: {} },
    blockOrder: [],
};
export function normalizeSectionName(name) {
    return name.replace(/\s+/g, ' ').trim().slice(0, SIDEBAR_SECTION_NAME_MAX_LENGTH);
}
/**
 * The comparison key the renderer uses for desktop projects. It is the very
 * function the sidebar UI calls, so a worktree subdirectory, a trailing slash
 * or a Windows path can never key the same project two different ways — a
 * mismatch would silently drop the project out of the section it lives in.
 */
export function projectKey(dir) {
    return desktopProjectWorkspaceGroupKey(dir.trim());
}
/** Ids currently assigned to `sectionId`. */
export function assignedIdsOf(assignments, sectionId) {
    return Object.keys(assignments).filter((id) => assignments[id] === sectionId);
}
/**
 * Keep `orderedIds` as `sectionId`'s record, but only for chats that really
 * belong to it, and never lose an assigned chat the caller omitted.
 */
export function normalizeOrderRecord(orderedIds, assignedIds) {
    const assigned = new Set(assignedIds);
    const seen = new Set();
    const kept = [];
    for (const id of orderedIds) {
        if (!assigned.has(id) || seen.has(id))
            continue;
        seen.add(id);
        kept.push(id);
    }
    for (const id of assignedIds) {
        if (!seen.has(id))
            kept.push(id);
    }
    return kept;
}
/** Remove `sessionId` from every section's order record. */
export function withoutSessionInOrders(sessionOrder, sessionId) {
    let changed = false;
    const next = {};
    for (const [sectionId, ids] of Object.entries(sessionOrder)) {
        if (!ids.includes(sessionId)) {
            next[sectionId] = ids;
            continue;
        }
        changed = true;
        const filtered = ids.filter((id) => id !== sessionId);
        if (filtered.length > 0)
            next[sectionId] = filtered;
    }
    return changed ? next : { ...sessionOrder };
}
/** Put `sessionId` at the head of `sectionId`'s record, as a right-click move does. */
export function prependSession(sessionOrder, sectionId, sessionId, assignments) {
    const rest = (sessionOrder[sectionId] ?? []).filter((id) => id !== sessionId);
    return {
        ...sessionOrder,
        [sectionId]: normalizeOrderRecord([sessionId, ...rest], assignedIdsOf(assignments, sectionId)),
    };
}
/**
 * Order one section's chats: recorded ids first, everything else after them in
 * the caller's fallback order (the sidebar uses `last_active_at` desc).
 */
export function orderIdsByRecord(fallbackIds, orderedIds) {
    if (!orderedIds || orderedIds.length === 0)
        return [...fallbackIds];
    const known = new Set(fallbackIds);
    const seen = new Set();
    const ordered = [];
    for (const id of orderedIds) {
        if (!known.has(id) || seen.has(id))
            continue;
        seen.add(id);
        ordered.push(id);
    }
    return [...ordered, ...fallbackIds.filter((id) => !seen.has(id))];
}
/**
 * Top-to-bottom order of the sidebar blocks (置顶 + sections). Recorded ids come
 * first; 置顶 without a record stays on top, and sections without a record
 * follow in creation order. Unknown ids are dropped.
 */
export function orderSidebarBlocks(sectionIds, blockOrder) {
    const known = new Set([SIDEBAR_PINNED_BLOCK_ID, ...sectionIds]);
    const seen = new Set();
    const ordered = [];
    for (const id of blockOrder ?? []) {
        if (!known.has(id) || seen.has(id))
            continue;
        seen.add(id);
        ordered.push(id);
    }
    if (!seen.has(SIDEBAR_PINNED_BLOCK_ID))
        ordered.unshift(SIDEBAR_PINNED_BLOCK_ID);
    for (const id of sectionIds) {
        if (!seen.has(id))
            ordered.push(id);
    }
    return ordered;
}
/**
 * Reorder only the blocks `named`, inside the slots they already occupy.
 *
 * `orderSidebarBlocks` rebuilds from creation order, so a caller that names
 * part of the order drags every block it left out to the end. Here a block left
 * out never moves at all: the named blocks are permuted among exactly the
 * positions they already hold, which is what "blocks you leave out keep their
 * place" means for a partial order. An id the current order does not hold is
 * dropped, and a repeat is kept once, exactly as `orderSidebarBlocks` does.
 */
export function applyNamedBlockOrder(current, named) {
    const known = new Set(current);
    const seen = new Set();
    const wanted = [];
    for (const id of named) {
        if (seen.has(id) || !known.has(id))
            continue;
        seen.add(id);
        wanted.push(id);
    }
    const next = [...current];
    let slot = 0;
    for (const [index, id] of current.entries()) {
        if (!seen.has(id))
            continue;
        const replacement = wanted[slot];
        if (replacement === undefined)
            break;
        next[index] = replacement;
        slot += 1;
    }
    return next;
}
/** Drop every reference to `sectionId` from a section-keyed map. */
export function releaseSection(map, sectionId) {
    return Object.fromEntries(Object.entries(map).filter(([, id]) => id !== sectionId));
}
/** Drop `sectionId`'s own entry from a section-keyed map. */
export function withoutSection(map, sectionId) {
    const { [sectionId]: _removed, ...rest } = map;
    void _removed;
    return rest;
}
/**
 * A whole state from untrusted JSON. Invalid entries are dropped rather than
 * failing the read, and section names stay unique because `create` reuses a
 * name and `update` refuses a duplicate — a state that broke that invariant
 * (only a hand-edited localStorage value can) keeps its first section.
 */
export function sanitizeState(value) {
    if (!value || typeof value !== 'object')
        return EMPTY_SECTIONS_STATE;
    const raw = value;
    const { sections, ids } = sanitizeSections(raw.sections);
    const assignments = sanitizeAssignments(raw.assignments, ids);
    const pinnedFrom = asRecord(raw.pinnedFrom);
    return {
        sections,
        assignments,
        projectAssignments: sanitizeAssignments(raw.projectAssignments, ids),
        collapsed: sanitizeCollapsed(raw.collapsed, ids),
        sessionOrder: sanitizeSessionOrder(raw.sessionOrder, ids, assignments),
        pinnedFrom: {
            sessions: sanitizeAssignments(pinnedFrom.sessions, ids),
            projects: sanitizeAssignments(pinnedFrom.projects, ids),
        },
        blockOrder: sanitizeBlockOrder(raw.blockOrder, ids),
    };
}
function asRecord(value) {
    return value && typeof value === 'object' ? value : {};
}
/** One raw entry, or null when it is not a usable section. */
function parseSection(item) {
    if (!item || typeof item !== 'object')
        return null;
    const { id, name } = item;
    if (typeof id !== 'string' || !id)
        return null;
    if (typeof name !== 'string')
        return null;
    const normalized = normalizeSectionName(name);
    return normalized ? { id, name: normalized } : null;
}
function sanitizeSections(value) {
    if (!Array.isArray(value))
        return { sections: [], ids: new Set() };
    const seenNames = new Set();
    const seenIds = new Set();
    const sections = [];
    for (const item of value) {
        const parsed = parseSection(item);
        if (!parsed || seenNames.has(parsed.name) || seenIds.has(parsed.id))
            continue;
        seenNames.add(parsed.name);
        seenIds.add(parsed.id);
        const { createdAt } = item;
        sections.push({
            ...parsed,
            createdAt: typeof createdAt === 'number' ? createdAt : 0,
        });
    }
    return { sections, ids: new Set(sections.map((section) => section.id)) };
}
function sanitizeAssignments(value, ids) {
    const out = {};
    if (!value || typeof value !== 'object')
        return out;
    for (const [key, sectionId] of Object.entries(value)) {
        if (key && typeof sectionId === 'string' && ids.has(sectionId))
            out[key] = sectionId;
    }
    return out;
}
function sanitizeCollapsed(value, ids) {
    const out = {};
    if (!value || typeof value !== 'object')
        return out;
    for (const [id, flag] of Object.entries(value)) {
        if (flag === true && ids.has(id))
            out[id] = true;
    }
    return out;
}
function sanitizeSessionOrder(value, ids, assignments) {
    const out = {};
    if (!value || typeof value !== 'object')
        return out;
    for (const [id, raw] of Object.entries(value)) {
        if (!ids.has(id) || !Array.isArray(raw))
            continue;
        const record = normalizeOrderRecord(raw.filter((entry) => typeof entry === 'string'), assignedIdsOf(assignments, id));
        if (record.length > 0)
            out[id] = record;
    }
    return out;
}
function sanitizeBlockOrder(value, ids) {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    const out = [];
    for (const id of value) {
        if (typeof id !== 'string' || seen.has(id))
            continue;
        if (id !== SIDEBAR_PINNED_BLOCK_ID && !ids.has(id))
            continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}
//# sourceMappingURL=state.js.map