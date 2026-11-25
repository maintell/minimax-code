import {} from '@mavis/agent-tools';
import { basename } from 'node:path';
import { logger } from '@mavis/shared/local-runtime-logging';
import { publishBestEffort } from '@mavis/shared/global-events';
import { DEFAULT_PROJECT_KEY, projectSessionFilter } from '../session-system/index.js';
import { normalizeSectionName, projectKey, SIDEBAR_PINNED_BLOCK_ID, SidebarSectionError, } from '../sidebar-sections/index.js';
import { DesktopAgentToolError, mapToolError, toProjectId } from './errors.js';
/**
 * Backs the namespaced `sidebar.*` Agent tools.
 *
 * Every method drives a capability the sidebar UI already has; the service
 * adds no product behaviour of its own. It publishes `sidebar.changed` after
 * a successful write so the sidebar refetches the area it owns — the Runtime
 * query stays the source of truth and nothing here navigates the UI.
 *
 * A failure throws a `DesktopAgentToolError` carrying one of the shared
 * `DESKTOP_TOOL_ERROR_CODES`, which is what the tool reports and what the
 * metric label counts.
 */
export class SidebarToolsService {
    options;
    constructor(options) {
        this.options = options;
    }
    async listProjects(req) {
        try {
            const page = await this.options.applications.listProjects({
                includeHidden: false,
                limit: req.limit,
                ...(req.cursor ? { cursor: req.cursor } : {}),
            });
            const sections = this.sectionRefs();
            return {
                projects: (page.projects ?? [])
                    .map((group) => group.project)
                    .filter((project) => project !== undefined)
                    .map((project) => {
                    const view = toProjectView(project);
                    const section = project.workspaceDir
                        ? sections.byProjectKey.get(projectKey(project.workspaceDir))
                        : undefined;
                    return section ? { ...view, section } : view;
                }),
                has_more: page.hasMore === true,
                ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
            };
        }
        catch (error) {
            throw mapSidebarToolError(error, 'Failed to list projects.');
        }
    }
    async readSidebar(req) {
        try {
            const [tree, pins] = await Promise.all([
                this.options.applications.getSidebarSessionTree({
                    limit: req.limit,
                    ...(req.cursor ? { cursor: req.cursor } : {}),
                }),
                this.options.applications.getPinnedItemsOrder(),
            ]);
            const sections = this.sectionRefs();
            return {
                sessions: (tree.sessions ?? [])
                    .map((node) => node.session)
                    .filter((session) => session !== undefined)
                    .map((session) => {
                    const view = toSessionView(session);
                    const section = sections.bySessionId.get(view.session_id);
                    return section ? { ...view, section } : view;
                }),
                pinned: (pins.items ?? []).flatMap(toPinnedRef),
                has_more: tree.hasMore === true,
                ...(tree.nextCursor ? { next_cursor: tree.nextCursor } : {}),
            };
        }
        catch (error) {
            throw mapSidebarToolError(error, 'Failed to read the sidebar.');
        }
    }
    async setPinned(req) {
        try {
            if (req.item_type === 'agent')
                return await this.pinAgentRow(req);
            if (req.item_type === 'session')
                return await this.pinChat(req);
            return await this.pinProject(req);
        }
        catch (error) {
            throw mapSidebarToolError(error, `Failed to ${req.pinned ? 'pin' : 'unpin'} the item.`);
        }
    }
    /**
     * An Agent pin: the same Application call the sidebar's own pin action makes.
     *
     * Only an Agent the Agent management page lists can be pinned. The pinned area
     * and that page have to agree, or the tool answers success while the sidebar
     * never shows the row. The check runs before the already-pinned shortcut, so an
     * Agent that is pinned already and is not on that page is refused as well.
     *
     * `PinService` appends a newly pinned ref, so pinning an Agent that is already
     * pinned would move its row to the end of the pinned area. Order belongs to
     * `pinned_reorder`, so the repeat answers with the state that already holds and
     * writes nothing. An unpin always goes through, so an Agent that does not exist
     * is still reported rather than answered as `not pinned`.
     *
     * The id is passed through as the sidebar passes it: the Agent lookup behind
     * `PinService` resolves the exact owner from a bare stable name and from the
     * `agent:<name>` form alike, so the id `sidebar_read` reports for a pinned Agent
     * and a name from `agent_list` both reach the same Agent the UI pins.
     */
    async pinAgentRow(req) {
        if (req.pinned)
            await this.requireListedAgent(req.id);
        if (req.pinned && (await this.isPinned('agent', req.id))) {
            return { item_type: 'agent', id: req.id, pinned: true };
        }
        await this.options.applications.pinAgent({ name: req.id, pinned: req.pinned });
        // An Agent sits in no section and in no project list, so the pinned area is
        // the only sidebar area this write shows up in.
        this.publish(['pins']);
        return { item_type: 'agent', id: req.id, pinned: req.pinned };
    }
    /**
     * Refuses a pin of an Agent the Agent management page does not list.
     *
     * `undefined` is an Agent that does not exist: nothing is refused here, so the
     * pin call below reports it as `NOT_FOUND` exactly as it did before this check
     * existed. Nothing is written and no refresh hint is published on a refusal.
     */
    async requireListedAgent(id) {
        if ((await this.options.agents.showInAgentList(id)) === false) {
            throw new DesktopAgentToolError('INVALID_ARGUMENT', `Agent "${id}" cannot be pinned: only Agents listed on the Agent management page can be pinned.`);
        }
    }
    /**
     * A chat pin: remember the section it leaves so the unpin can put it back.
     *
     * `PinService` appends a newly pinned ref, so pinning a chat that 置顶 already
     * holds would move its row to the end of the pinned area. Order belongs to
     * `pinned_reorder`, so the repeat answers with the state that already holds and
     * writes nothing — the same shortcut `pinAgentRow` takes. The bookkeeping is
     * skipped with it: the chat sits in no section while pinned, so the only thing
     * the write could record is `it was in no section`, which forgets where its
     * unpin goes back to.
     */
    async pinChat(req) {
        if (req.pinned && (await this.isPinned('session', req.id))) {
            return { item_type: 'session', id: req.id, pinned: true };
        }
        // Read the section before the pin commits: a pin moves the chat out of
        // its section, and the unpin has to put it back.
        const before = this.options.sections.sectionOfTarget({ sessionId: req.id });
        await this.options.applications.pinSession({ sessionId: req.id, pinned: req.pinned });
        await this.options.sections.commitPin({
            item_type: 'session',
            id: req.id,
            pinned: req.pinned,
            section_before: before ?? null,
        });
        this.publish(['pins', 'sections']);
        return { item_type: 'session', id: req.id, pinned: req.pinned };
    }
    /**
     * The same for a project, which the sidebar also shows in the project list.
     *
     * `PinService` appends a newly pinned ref here too, so a repeat answers with
     * the state that already holds and writes nothing. The project is still
     * resolved first, so a project that does not exist is reported rather than
     * answered as `already pinned`.
     */
    async pinProject(req) {
        const projectId = toProjectId(req.id);
        const record = await this.options.projects.resolve({ projectId }, false);
        if (req.pinned && (await this.isPinned('project', String(projectId)))) {
            return { item_type: 'project', id: req.id, pinned: true };
        }
        const key = record.workspaceDir ? projectKey(record.workspaceDir) : undefined;
        const before = key ? this.options.sections.sectionOfTarget({ projectKey: key }) : undefined;
        await this.options.applications.setProjectPinned({
            project: { projectId },
            pinned: req.pinned,
        });
        if (key) {
            await this.options.sections.commitPin({
                item_type: 'project',
                id: key,
                pinned: req.pinned,
                section_before: before ?? null,
            });
        }
        // The pinned area, the project list and the sections all show this flag.
        this.publish(['pins', 'projects', 'sections']);
        return { item_type: 'project', id: req.id, pinned: req.pinned };
    }
    /**
     * Whether 置顶 already holds this item, read before the pin call commits.
     *
     * A read that fails answers `no`, so the caller writes the section bookkeeping
     * exactly as it did before this check existed.
     */
    async isPinned(itemType, id) {
        try {
            const order = await this.options.applications.getPinnedItemsOrder();
            return (order.items ?? [])
                .flatMap(toPinnedRef)
                .some((ref) => ref.item_type === itemType && sameRefId(itemType, ref.id, id));
        }
        catch {
            return false;
        }
    }
    async archiveProjectSessions(req) {
        try {
            const projectId = toProjectId(req.project);
            const record = await this.options.projects.resolve({ projectId }, false);
            const sessionIds = await this.options.projects.listRootSessionIds(record.projectId, {
                // The sidebar's own archive filter, so `project_list`'s session_count and
                // this call count the same chats — Cron roots included.
                filter: projectSessionFilter({}),
            });
            const skipped = [];
            const archived = [];
            const failed = [];
            for (const sessionId of sessionIds) {
                if (this.options.isSessionBusy(sessionId)) {
                    skipped.push(sessionId);
                    continue;
                }
                try {
                    await this.options.archiveSession(sessionId);
                    archived.push(sessionId);
                }
                catch {
                    failed.push(sessionId);
                }
            }
            // `sessions` and `projects` both map to the same sidebar refetch, so one
            // event covers the project list. `pins` is separate: archiving drops the
            // Runtime pin, and only this scope makes the pinned area re-read that
            // order — otherwise it keeps showing an archived chat until a full reload.
            // Nothing changed when nothing was archived.
            if (archived.length > 0)
                this.publish(['projects', 'pins']);
            return {
                project: { project_id: String(record.projectId), name: projectName(record) },
                archived_session_ids: archived,
                skipped_running_session_ids: skipped,
                failed_session_ids: failed,
            };
        }
        catch (error) {
            throw mapSidebarToolError(error, 'Failed to archive the project chats.');
        }
    }
    // ── sidebar.section ──
    // Each method is one item, and the sections service runs every write in one
    // serialized lane, so the sidebar UI writing the same rows never collides.
    async listSections() {
        return this.options.sections.list();
    }
    async createSection(req) {
        try {
            const result = await this.options.sections.create({ name: req.name });
            if (result.created)
                this.publish(['sections']);
            return result;
        }
        catch (error) {
            throw mapSidebarToolError(error, 'Failed to create the section.');
        }
    }
    async renameSection(req) {
        try {
            const result = await this.options.sections.update({ section: req.section, name: req.name });
            this.publish(['sections']);
            return result;
        }
        catch (error) {
            throw mapSidebarToolError(error, 'Failed to rename the section.');
        }
    }
    async deleteSection(req) {
        try {
            const result = await this.options.sections.remove({ section: req.section });
            this.publish(['sections']);
            return result;
        }
        catch (error) {
            throw mapSidebarToolError(error, 'Failed to delete the section.');
        }
    }
    async moveSectionSessions(req) {
        return this.moveSectionItems('session', req.session_ids, req.section, req.position);
    }
    async moveSectionProjects(req) {
        return this.moveSectionItems('project', req.workspace_dirs, req.section, undefined);
    }
    async reorderSectionBlocks(req) {
        try {
            const state = this.options.sections.read();
            const result = await this.options.sections.setBlockOrder({
                order: req.order.map((ref) => resolveBlockRef(state, ref)),
            });
            this.publish(['sections']);
            return result;
        }
        catch (error) {
            throw mapSidebarToolError(error, 'Failed to reorder the sidebar blocks.');
        }
    }
    /**
     * One move per item so a pinned chat is unpinned before it lands in a
     * section, and a project that is gone is reported instead of failing the call.
     *
     * Each move is its own committed write, so a failure part-way through leaves
     * the earlier items in their new section. The call therefore reports both
     * lists and still publishes the refresh for what did move; failing the whole
     * batch would tell the model nothing changed while the sidebar kept the old
     * view of writes that landed.
     *
     * The position offset counts what actually moved, not the index in the
     * request: an id that matched nothing must not push the next item down a slot.
     */
    async moveSectionItems(itemType, ids, section, position) {
        try {
            const visible = this.options.sections.visibleItems(itemType, ids);
            const moved = [];
            const notFound = [];
            const failed = [];
            const unpinned = [];
            let target = null;
            for (const id of ids) {
                const outcome = await this.moveOneSectionItem({
                    itemType,
                    id,
                    section,
                    position: position === undefined ? undefined : position + moved.length,
                }, visible);
                if (outcome.kind === 'not_found') {
                    notFound.push(id);
                    continue;
                }
                if (outcome.kind === 'failed') {
                    failed.push(id);
                    continue;
                }
                moved.push(id);
                if (outcome.unpinned)
                    unpinned.push(id);
                target = outcome.section;
            }
            if (moved.length > 0) {
                this.publish(unpinned.length > 0 ? ['sections', 'pins'] : ['sections']);
            }
            return {
                item_type: itemType,
                moved,
                not_found: notFound,
                failed,
                section: target,
                unpinned,
            };
        }
        catch (error) {
            throw mapSidebarToolError(error, 'Failed to move the items into the section.');
        }
    }
    /**
     * One item's move, so the batch above stays a flat loop: an id the sidebar
     * does not show is reported as not found and a failed write as failed,
     * instead of either one ending the whole call.
     */
    async moveOneSectionItem(input, visible) {
        const { itemType, id, section, position } = input;
        if (!visible.has(itemType === 'session' ? id : projectKey(id)))
            return { kind: 'not_found' };
        try {
            const result = await this.options.sections.move({
                item_type: itemType,
                id,
                section,
                ...(position === undefined ? {} : { position }),
            });
            return { kind: 'moved', unpinned: result.unpinned, section: result.section };
        }
        catch {
            return { kind: 'failed' };
        }
    }
    /** Section lookup for the two read tools, resolved once per call. */
    sectionRefs() {
        const state = this.options.sections.read();
        const byId = new Map(state.sections.map((section) => [section.id, { section_id: section.id, name: section.name }]));
        const project = (map, key) => {
            const sectionId = map[key];
            return sectionId ? byId.get(sectionId) : undefined;
        };
        const bySessionId = new Map();
        for (const sessionId of Object.keys(state.assignments)) {
            const section = project(state.assignments, sessionId);
            if (section)
                bySessionId.set(sessionId, section);
        }
        const byProjectKeyMap = new Map();
        for (const key of Object.keys(state.projectAssignments)) {
            const section = project(state.projectAssignments, key);
            if (section)
                byProjectKeyMap.set(key, section);
        }
        return { bySessionId, byProjectKey: byProjectKeyMap };
    }
    /**
     * Best effort: the write already committed, so a failed hint never fails the
     * call — but it is logged, because "the Runtime wrote and the sidebar did not
     * refresh" is otherwise invisible.
     */
    publish(scopes) {
        for (const scope of scopes) {
            publishBestEffort(this.options.publishGlobalEvent, { type: 'sidebar.changed', payload: { scope } }, 
            // A committed write the sidebar never heard about is only diagnosable
            // from a log line, so the swallowed failure leaves one.
            (_event, error) => logger.warn({ scope, err: error instanceof Error ? error.message : String(error) }, '[local-runtime-v2] sidebar.changed publish failed'));
        }
    }
}
function toProjectView(project) {
    const defaultProject = project.key === DEFAULT_PROJECT_KEY;
    return {
        project_id: String(project.projectId ?? project.key),
        name: project.displayName ?? project.key,
        // The sidebar shows this bucket as "未选项目"; its wire name is a key the
        // model would otherwise read as a project the user named.
        ...(defaultProject ? { is_default: true } : {}),
        ...(project.workspaceDir ? { workspace_dir: project.workspaceDir } : {}),
        session_count: project.sessionCount ?? 0,
        pinned: project.state?.pinned === true,
        hidden: project.state?.hidden === true,
    };
}
function toSessionView(session) {
    return {
        session_id: session.sessionId ?? '',
        title: session.title ?? '',
        agent_name: session.agentName ?? '',
        ...(session.workspaceDir ? { workspace_dir: session.workspaceDir } : {}),
        updated_at_ms: toMs(session.updatedAt),
    };
}
function toPinnedRef(item) {
    if (item.session?.sessionId)
        return [{ item_type: 'session', id: item.session.sessionId }];
    const projectId = item.project?.id ?? item.desktopProject?.projectId;
    if (projectId !== undefined && projectId !== null) {
        return [{ item_type: 'project', id: String(projectId) }];
    }
    if (item.agent?.name)
        return [{ item_type: 'agent', id: item.agent.name }];
    return [];
}
/**
 * Whether two ids name the same pinned item.
 *
 * An Agent ref is keyed without its `agent:` prefix, exactly as `PinService` keys
 * it, so the id `sidebar_read` reports for a pinned Agent and a bare name from
 * `agent_list` match the row that is already pinned.
 */
function sameRefId(itemType, left, right) {
    return itemType === 'agent' ? agentPinKey(left) === agentPinKey(right) : left === right;
}
function agentPinKey(id) {
    return id.toLowerCase().startsWith('agent:') ? id.slice('agent:'.length) : id;
}
/**
 * The name the sidebar shows: the user's own name, else the folder basename.
 *
 * The default project has neither, and `project_list` already answers that row
 * as `No project selected` through `toProjectDetail`. Reporting a third name
 * here would have the model describe a project the sidebar never shows.
 */
function projectName(record) {
    if (record.displayName)
        return record.displayName;
    return record.workspaceDir ? basename(record.workspaceDir) : 'No project selected';
}
function toMs(value) {
    const ms = typeof value === 'bigint' ? Number(value) : (value ?? 0);
    return Number.isFinite(ms) ? ms : 0;
}
/**
 * A block reference the model gave: the 置顶 sentinel, a section id, or a name.
 *
 * The name is matched through the same `normalizeSectionName` the move path
 * uses, so one spelling resolves the same section in `section_move_session` and
 * in `section_reorder`. A reference that matches nothing throws instead of
 * passing through: dropped silently, the block would fall back to an unlisted
 * position while the tool answered success.
 */
function resolveBlockRef(state, ref) {
    const wanted = ref.trim();
    if (wanted === SIDEBAR_PINNED_BLOCK_ID)
        return SIDEBAR_PINNED_BLOCK_ID;
    const byId = state.sections.find((section) => section.id === wanted);
    if (byId)
        return byId.id;
    const byName = state.sections.find((section) => section.name === normalizeSectionName(wanted));
    if (byName)
        return byName.id;
    throw new SidebarSectionError('NOT_FOUND', `No sidebar block matches "${wanted}". Use section_list to see the sections.`);
}
/**
 * The sections service already speaks the shared desktop codes, so its own code
 * passes through. Everything else keeps the status or reason it carries, which
 * is how an Application `AppError(404, 'SESSION_NOT_FOUND')` reaches the model
 * as `NOT_FOUND` instead of `INTERNAL`.
 */
function mapSidebarToolError(error, fallback) {
    if (error instanceof SidebarSectionError) {
        return new DesktopAgentToolError(error.code, error.message);
    }
    return mapToolError(error, fallback);
}
//# sourceMappingURL=sidebar-tools-service.js.map