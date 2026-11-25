import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { logger } from '@mavis/shared/local-runtime-logging';
import { incrementMetric } from '@mavis/shared/local-runtime-logging/metric-registry';
import { and, eq, inArray } from 'drizzle-orm';
import { deletePreferenceValue, readPreferenceValue, upsertPreferenceValue, } from '../../infra/db/preference-values.js';
import { projects } from '../../infra/db/schema/projects.js';
import { sessions } from '../../infra/db/schema/sessions.js';
import { SIDEBAR_PINNED_BLOCK_ID, SIDEBAR_SECTIONS_IMPORTED_PREFERENCE_KEY, SIDEBAR_SECTIONS_PREFERENCE_KEY, } from './contracts.js';
import { assignTarget, commitPin as commitPinRule, deleteSection as deleteSectionRule, rollbackPin as rollbackPinRule, sectionOf, } from './pin-rules.js';
import { applyNamedBlockOrder, assignedIdsOf, normalizeOrderRecord, normalizeSectionName, orderIdsByRecord, orderSidebarBlocks, projectKey, sanitizeState, withoutSessionInOrders, } from './state.js';
const UNSECTIONED_PROJECT_LIMIT = 100;
export class SidebarSectionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'SidebarSectionError';
    }
}
/**
 * Owns the desktop sidebar sections (分区) for one data directory.
 *
 * The renderer and the Agent `sidebar.section` tools read and write this single
 * Runtime copy. Every write is one item — there is deliberately no whole-state
 * replace — so the sidebar UI and an Agent editing the same sections never
 * overwrite each other, and every write runs in one serialized lane.
 */
export class SidebarSectionsService {
    options;
    nowMs;
    writeQueue = Promise.resolve();
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    read() {
        return sanitizeState(readPreferenceValue(this.options.db, SIDEBAR_SECTIONS_PREFERENCE_KEY));
    }
    /** Whether this data directory already imported the renderer's localStorage copy. */
    isImported() {
        return readPreferenceValue(this.options.db, SIDEBAR_SECTIONS_IMPORTED_PREFERENCE_KEY) === true;
    }
    /**
     * `id` is the id the renderer already painted the section under. Taking it
     * keeps both sides on one id, so the rename / move / delete the user does
     * next still resolves instead of 404-ing on a row the Runtime never wrote.
     */
    create(input) {
        return this.serializeWrite(async () => {
            const name = requireName(input.name);
            const state = this.read();
            const existing = state.sections.find((section) => section.name === name);
            const section = existing ?? {
                id: requestedSectionId(input.id, state) ?? `sec_${randomUUID()}`,
                name,
                createdAt: this.nowMs(),
            };
            let next = existing
                ? state
                : { ...state, sections: [...state.sections, section] };
            // Normalized like `move`, so a project target keyed "/w/a/" lands on the
            // same row the sidebar reads for "/w/a".
            if (input.target) {
                const target = normalizeTarget(input.target);
                next = (await this.assignWithPin(next, target, section.id)).state;
            }
            this.write(next);
            return { section: toRef(section), created: existing === undefined };
        });
    }
    /** Rename and/or collapse one section; both are the same single-item write. */
    update(input) {
        return this.serializeWrite(() => {
            const state = this.read();
            const target = resolveSection(state, input.section);
            let sections = state.sections;
            let name = target.name;
            if (input.name !== undefined) {
                name = requireName(input.name);
                if (sections.some((section) => section.name === name && section.id !== target.id)) {
                    throw new SidebarSectionError('CONFLICT', `A section named "${name}" already exists.`);
                }
                sections = sections.map((section) => section.id === target.id ? { ...section, name } : section);
            }
            let collapsed = state.collapsed;
            if (input.collapsed !== undefined) {
                collapsed = input.collapsed
                    ? { ...state.collapsed, [target.id]: true }
                    : Object.fromEntries(Object.entries(state.collapsed).filter(([id]) => id !== target.id));
            }
            this.write({ ...state, sections, collapsed });
            return { section_id: target.id, name, collapsed: collapsed[target.id] === true };
        });
    }
    remove(input) {
        return this.serializeWrite(() => {
            const state = this.read();
            const target = resolveSection(state, input.section);
            const next = deleteSectionRule(state, target.id);
            this.write(next);
            return {
                section: toRef(target),
                released_sessions: Object.keys(state.assignments).length - Object.keys(next.assignments).length,
                released_projects: Object.keys(state.projectAssignments).length -
                    Object.keys(next.projectAssignments).length,
            };
        });
    }
    /**
     * Move one chat or project into a section, or out of every section. A pinned
     * item is unpinned first, because 置顶 wins over 分区; a failed unpin leaves
     * the sections untouched.
     */
    move(input) {
        return this.serializeWrite(async () => {
            const state = this.read();
            const target = targetOf(input.item_type, input.id);
            const section = input.section === null ? null : resolveSection(state, input.section);
            let unpinned = false;
            let next = state;
            if (section) {
                const assigned = await this.assignWithPin(state, target, section.id);
                next = assigned.state;
                unpinned = assigned.unpinned;
                if (input.position !== undefined && 'sessionId' in target) {
                    next = this.placeSession(next, section.id, target.sessionId, input.position);
                }
            }
            else {
                next = assignTarget(state, target, null);
            }
            if (next !== state)
                this.write(next);
            return {
                item_type: input.item_type,
                id: input.id,
                section: section ? toRef(section) : null,
                unpinned,
            };
        });
    }
    /** Persist one section's manual chat order without changing any assignment. */
    setSessionOrder(input) {
        return this.serializeWrite(() => {
            const state = this.read();
            const target = resolveSection(state, input.section);
            const record = normalizeOrderRecord(input.session_ids, assignedIdsOf(state.assignments, target.id));
            const sessionOrder = { ...state.sessionOrder };
            if (record.length > 0)
                sessionOrder[target.id] = record;
            else
                delete sessionOrder[target.id];
            this.write({ ...state, sessionOrder });
            return { section: toRef(target), session_ids: record };
        });
    }
    /**
     * Persist the top-to-bottom order of 置顶 and the sections.
     *
     * The current order is the base, so naming part of it moves only those blocks
     * and leaves every other block exactly where the user put it. Rebuilding from
     * creation order instead would push each unnamed block to the end.
     */
    setBlockOrder(input) {
        return this.serializeWrite(() => {
            const state = this.read();
            const order = applyNamedBlockOrder(orderSidebarBlocks(state.sections.map((section) => section.id), state.blockOrder), input.order);
            this.write({ ...state, blockOrder: order });
            return { order };
        });
    }
    /**
     * A pin or unpin the caller already committed. Pin: remember the section the
     * item left and drop the membership. Unpin: put it back where it was.
     */
    commitPin(input) {
        return this.serializeWrite(() => {
            const state = this.read();
            const target = targetOf(input.item_type, input.id);
            // `undefined` (the caller named no section) falls back to where the item
            // sits now, and stays `undefined` when it is in no section at all — which
            // tells the rule to keep the restore target it already recorded.
            const before = input.section_before === undefined ? sectionOf(state, target) : input.section_before;
            const next = commitPinRule(state, target, {
                pinned: input.pinned,
                sectionBefore: before,
                restore: input.restore !== false,
            });
            if (next !== state)
                this.write(next);
            const sectionId = sectionOf(next, target);
            return {
                item_type: input.item_type,
                id: input.id,
                pinned: input.pinned,
                section: sectionId ? refOf(next, sectionId) : null,
            };
        });
    }
    /** A pin the caller attempted failed; undo the optimistic section change. */
    rollbackPin(input) {
        return this.serializeWrite(() => {
            const state = this.read();
            const target = targetOf(input.item_type, input.id);
            const next = rollbackPinRule(state, target, input.section_before ?? undefined);
            if (next !== state)
                this.write(next);
            return { restored: next !== state };
        });
    }
    /**
     * One-time merge of the renderer's localStorage copy into this data
     * directory. Sections merge by name, and an assignment the Runtime already
     * has always wins — the local copy only fills gaps, so an Agent that created
     * sections before the first sidebar paint is never overwritten.
     */
    async importLocalState(input) {
        try {
            if (this.isImported()) {
                this.reportImport('already_done');
                return { status: 'already_done', state: this.read(), imported_sections: 0 };
            }
            const local = sanitizeState(input);
            const result = await this.serializeWrite(() => {
                const state = this.read();
                const hadSections = state.sections.length > 0;
                const next = mergeLocalState(state, local, () => this.nowMs());
                this.write(next);
                // Written last: a failed merge leaves the marker unset so the next
                // launch retries, exactly like the project-alias migration.
                upsertPreferenceValue(this.options.db, SIDEBAR_SECTIONS_IMPORTED_PREFERENCE_KEY, true);
                return {
                    status: (hadSections ? 'merged' : 'imported'),
                    state: next,
                    imported_sections: next.sections.length - state.sections.length,
                };
            });
            this.reportImport(result.status);
            return result;
        }
        catch (error) {
            this.reportImport('failed', error);
            throw error;
        }
    }
    /** The section `target` sits in right now; read it before a pin commits. */
    sectionOfTarget(target) {
        return sectionOf(this.read(), target);
    }
    /**
     * Which of these chats / projects still show in the sidebar. A move reports
     * the rest as not found instead of writing an assignment nobody can see.
     */
    visibleItems(itemType, ids) {
        if (itemType === 'session')
            return new Set(this.liveSessions(ids).keys());
        const known = new Set(this.visibleProjects().map((row) => projectKey(row.workspaceDir)));
        return new Set(ids.map(projectKey).filter((key) => known.has(key)));
    }
    /** Tool-facing view: each section with its chats and projects, plus the rest. */
    list() {
        const state = this.read();
        const projectRows = this.visibleProjects();
        const projectByKey = new Map(projectRows.map((row) => [projectKey(row.workspaceDir), row]));
        const sessionRows = this.liveSessions(Object.keys(state.assignments));
        let stale = 0;
        const sections = state.sections.map((section) => {
            const projectsInSection = Object.entries(state.projectAssignments).flatMap(([key, sectionId]) => {
                if (sectionId !== section.id)
                    return [];
                const row = projectByKey.get(key);
                if (!row) {
                    stale += 1;
                    return [];
                }
                return [toProjectView(row)];
            });
            const assignedHere = Object.keys(state.assignments).filter((id) => state.assignments[id] === section.id);
            const ordered = orderIdsByRecord(assignedHere
                .flatMap((id) => {
                const row = sessionRows.get(id);
                return row ? [{ id, row }] : [];
            })
                .sort((left, right) => right.row.updatedAtMs - left.row.updatedAtMs)
                .map((entry) => entry.id), state.sessionOrder[section.id]);
            const sessionsInSection = ordered.map((id) => {
                const row = sessionRows.get(id);
                return {
                    session_id: id,
                    title: row?.title?.trim() || '(untitled)',
                    ...(row?.workspaceDir ? { workspace_dir: row.workspaceDir } : {}),
                };
            });
            stale += assignedHere.length - sessionsInSection.length;
            return {
                section_id: section.id,
                name: section.name,
                collapsed: state.collapsed[section.id] === true,
                projects: projectsInSection,
                sessions: sessionsInSection,
            };
        });
        const unsectioned = projectRows
            .filter((row) => !(projectKey(row.workspaceDir) in state.projectAssignments))
            .sort((left, right) => right.sessionCount - left.sessionCount)
            .slice(0, UNSECTIONED_PROJECT_LIMIT)
            .map(toProjectView);
        return { sections, unsectioned_projects: unsectioned, stale_entries: stale };
    }
    /** Unpins the item when needed, then assigns it. A failed unpin aborts the write. */
    async assignWithPin(state, target, sectionId) {
        if (!(await this.options.pins.isPinned(target))) {
            return { state: assignTarget(state, target, sectionId), unpinned: false };
        }
        if (!(await this.options.pins.releasePin(target))) {
            throw new SidebarSectionError('CONFLICT', 'The item is pinned and could not be unpinned, so it stays where it is.');
        }
        // The unpin committed, so re-read: it may have moved the item back into the
        // section it came from and cleared its restore target.
        const fresh = this.read();
        return { state: assignTarget(fresh, target, sectionId), unpinned: true };
    }
    /**
     * Put `sessionId` at `position` inside `sectionId`'s manual order.
     *
     * `position` is a slot in the order the sidebar actually shows, so the rest
     * of the section is laid out the way `list()` lays it out — the recorded
     * order first, everything else by activity — before the chat is inserted.
     * Inserting into the raw assignment order instead would rewrite the section's
     * order from scratch and shuffle chats the caller never touched.
     */
    placeSession(state, sectionId, sessionId, position) {
        const rest = assignedIdsOf(state.assignments, sectionId).filter((id) => id !== sessionId);
        const displayed = orderIdsByRecord(this.displayOrder(rest), state.sessionOrder[sectionId]);
        const index = Math.max(0, Math.min(Math.trunc(position), displayed.length));
        const ordered = [...displayed.slice(0, index), sessionId, ...displayed.slice(index)];
        return {
            ...state,
            sessionOrder: {
                ...withoutSessionInOrders(state.sessionOrder, sessionId),
                [sectionId]: ordered,
            },
        };
    }
    /** Assigned ids by last activity, as `list()` orders a section without a record. */
    displayOrder(sessionIds) {
        const rows = this.liveSessions(sessionIds);
        const active = sessionIds
            .flatMap((id) => {
            const row = rows.get(id);
            return row ? [{ id, updatedAtMs: row.updatedAtMs }] : [];
        })
            .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
            .map((entry) => entry.id);
        // Chats that no longer show in the sidebar keep their relative order at the
        // end, so a record never drops an assignment it is supposed to cover.
        return [...active, ...sessionIds.filter((id) => !rows.has(id))];
    }
    write(state) {
        if (state.sections.length === 0) {
            deletePreferenceValue(this.options.db, SIDEBAR_SECTIONS_PREFERENCE_KEY);
            return;
        }
        upsertPreferenceValue(this.options.db, SIDEBAR_SECTIONS_PREFERENCE_KEY, state);
    }
    reportImport(status, error) {
        // Observation must not change what the import did: incrementMetric is a
        // no-op without a sink and contains a throwing one.
        incrementMetric(this.options.metrics, 'sidebar_sections_import_total', 1, { status });
        if (status !== 'failed')
            return;
        logger.warn({
            status,
            reason: error instanceof Error ? error.message : String(error),
        }, 'Sidebar sections import from the renderer localStorage copy failed');
    }
    /** One lane for every write, so two callers never read-modify-write the same row. */
    async serializeWrite(operation) {
        const previous = this.writeQueue;
        let release = () => { };
        this.writeQueue = new Promise((resolve) => {
            release = resolve;
        });
        try {
            // A failed write must not block the lane; the next one still runs.
            await previous;
        }
        catch {
            /* handled by the caller that queued it */
        }
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
    visibleProjects() {
        return this.options.db
            .select({
            workspaceDir: projects.workspaceDir,
            sessionCount: projects.sessionCount,
            pinned: projects.pinned,
            displayName: projects.displayName,
        })
            .from(projects)
            .where(and(eq(projects.projectKind, 'workspace'), eq(projects.hidden, 0)))
            .all()
            .flatMap((row) => row.workspaceDir
            ? [
                {
                    workspaceDir: row.workspaceDir,
                    sessionCount: row.sessionCount,
                    pinned: row.pinned === 1,
                    displayName: row.displayName,
                },
            ]
            : []);
    }
    /** Chats that still show in the sidebar: not archived and not hidden. */
    liveSessions(sessionIds) {
        const out = new Map();
        if (sessionIds.length === 0)
            return out;
        const rows = this.options.db
            .select({
            sessionId: sessions.sessionId,
            title: sessions.title,
            workspaceDir: sessions.workspaceDir,
            archived: sessions.archived,
            visibility: sessions.visibility,
            updatedAtMs: sessions.updatedAtMs,
        })
            .from(sessions)
            .where(inArray(sessions.sessionId, [...sessionIds]))
            .all();
        for (const row of rows) {
            if (row.archived !== 0 || row.visibility === 'hidden')
                continue;
            out.set(row.sessionId, {
                title: row.title,
                workspaceDir: row.workspaceDir,
                updatedAtMs: row.updatedAtMs,
            });
        }
        return out;
    }
}
/**
 * Merge the renderer's copy into the Runtime copy without overwriting anything
 * the Runtime already decided. Sections merge by name; an assignment, collapse
 * flag, chat order or restore target the Runtime already has always wins.
 */
function mergeLocalState(state, local, nowMs) {
    if (local.sections.length === 0)
        return state;
    const { sections, idByLocalId } = mergeSections(state, local, nowMs);
    const assignments = fillMissing(state.assignments, local.assignments, idByLocalId);
    return {
        sections,
        assignments,
        projectAssignments: fillMissing(state.projectAssignments, local.projectAssignments, idByLocalId),
        collapsed: mergeCollapsed(state.collapsed, local.collapsed, idByLocalId),
        sessionOrder: mergeSessionOrder(state.sessionOrder, local.sessionOrder, idByLocalId, assignments),
        pinnedFrom: {
            sessions: fillMissing(state.pinnedFrom.sessions, local.pinnedFrom.sessions, idByLocalId),
            projects: fillMissing(state.pinnedFrom.projects, local.pinnedFrom.projects, idByLocalId),
        },
        blockOrder: mergeBlockOrder(state, sections, local.blockOrder, idByLocalId),
    };
}
/** Sections merge by name; the Runtime's own id wins when both sides have one. */
function mergeSections(state, local, nowMs) {
    const usedIds = new Set(state.sections.map((section) => section.id));
    const idByLocalId = new Map();
    const sections = [...state.sections];
    for (const localSection of local.sections) {
        const existing = sections.find((section) => section.name === localSection.name);
        if (existing) {
            idByLocalId.set(localSection.id, existing.id);
            continue;
        }
        const id = usedIds.has(localSection.id) ? `sec_${randomUUID()}` : localSection.id;
        usedIds.add(id);
        idByLocalId.set(localSection.id, id);
        sections.push({ id, name: localSection.name, createdAt: localSection.createdAt || nowMs() });
    }
    return { sections, idByLocalId };
}
/** Keep every row the Runtime already has; the local copy only fills the gaps. */
function fillMissing(current, incoming, idByLocalId) {
    const out = { ...current };
    for (const [key, localSectionId] of Object.entries(incoming)) {
        if (key in out)
            continue;
        const sectionId = idByLocalId.get(localSectionId);
        if (sectionId)
            out[key] = sectionId;
    }
    return out;
}
function mergeCollapsed(current, incoming, idByLocalId) {
    const out = { ...current };
    for (const [localSectionId, flag] of Object.entries(incoming)) {
        const sectionId = idByLocalId.get(localSectionId);
        if (flag === true && sectionId && !(sectionId in out))
            out[sectionId] = true;
    }
    return out;
}
function mergeSessionOrder(current, incoming, idByLocalId, assignments) {
    const out = { ...current };
    for (const [localSectionId, ids] of Object.entries(incoming)) {
        const sectionId = idByLocalId.get(localSectionId);
        if (!sectionId || sectionId in out)
            continue;
        const record = normalizeOrderRecord(ids, assignedIdsOf(assignments, sectionId));
        if (record.length > 0)
            out[sectionId] = record;
    }
    return out;
}
/** The Runtime's own block order wins; otherwise the local one is remapped. */
function mergeBlockOrder(state, sections, localOrder, idByLocalId) {
    if (state.blockOrder.length > 0)
        return state.blockOrder;
    return orderSidebarBlocks(sections.map((section) => section.id), localOrder.flatMap((id) => {
        if (id === SIDEBAR_PINNED_BLOCK_ID)
            return [id];
        const sectionId = idByLocalId.get(id);
        return sectionId ? [sectionId] : [];
    }));
}
function targetOf(itemType, id) {
    const trimmed = id.trim();
    if (!trimmed)
        throw new SidebarSectionError('INVALID_ARGUMENT', 'An item id is required.');
    return itemType === 'session' ? { sessionId: trimmed } : { projectKey: projectKey(trimmed) };
}
/** Trim / normalize a target that already knows its own kind (the create path). */
function normalizeTarget(target) {
    return 'sessionId' in target
        ? targetOf('session', target.sessionId)
        : targetOf('project', target.projectKey);
}
/**
 * The id a caller asked for, when it is one this Runtime may hand out. Absent
 * means "generate one"; a malformed or already-owned id is refused rather than
 * silently replaced, which would put the two sides back on different ids.
 */
function requestedSectionId(requested, state) {
    if (requested === undefined)
        return undefined;
    const id = requested.trim();
    if (!id.startsWith('sec_') || id === 'sec_') {
        throw new SidebarSectionError('INVALID_ARGUMENT', `"${id}" is not a section id.`);
    }
    if (state.sections.some((section) => section.id === id)) {
        throw new SidebarSectionError('CONFLICT', `Section id "${id}" is already taken.`);
    }
    return id;
}
function requireName(raw) {
    const name = normalizeSectionName(raw);
    if (!name)
        throw new SidebarSectionError('INVALID_ARGUMENT', 'The section name is empty.');
    return name;
}
function resolveSection(state, ref) {
    const wanted = ref.trim();
    const byId = state.sections.find((section) => section.id === wanted);
    if (byId)
        return byId;
    const byName = state.sections.find((section) => section.name === normalizeSectionName(wanted));
    if (byName)
        return byName;
    throw new SidebarSectionError('NOT_FOUND', `No section matches "${wanted}". Use section_list to see the sections.`);
}
function refOf(state, sectionId) {
    const section = state.sections.find((candidate) => candidate.id === sectionId);
    return section ? toRef(section) : null;
}
function toRef(section) {
    return { section_id: section.id, name: section.name };
}
function toProjectView(row) {
    return {
        workspace_dir: row.workspaceDir,
        name: row.displayName ?? (path.basename(row.workspaceDir) || row.workspaceDir),
        session_count: row.sessionCount,
        pinned: row.pinned,
    };
}
//# sourceMappingURL=sidebar-sections.service.js.map