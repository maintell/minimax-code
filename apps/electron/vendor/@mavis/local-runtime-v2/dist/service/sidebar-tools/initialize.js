import { initializeSidebarSections, } from '../sidebar-sections/index.js';
import { SidebarToolsService } from './sidebar-tools-service.js';
/**
 * One sidebar owner shared by the Runtime; the Electron host asks it for a tool
 * adapter bound to its own busy state and event publisher. The owner also owns
 * the sections service, which the sidebar UI drives over HTTP and the
 * `sidebar.section` tools drive through the same adapter — one copy, one write
 * lane.
 *
 * @internal Exported only for focused tests.
 */
export function createSidebarToolsOwner(options) {
    const sections = options.sections ??
        initializeSidebarSections({
            db: options.db,
            pins: sectionPinPort(options),
            ...(options.metrics ? { metrics: options.metrics } : {}),
        });
    // The host ports (the event publisher) are bound per adapter, not here.
    const resolved = {
        ...options,
        sections,
    };
    return {
        sections,
        createToolAdapter: (host) => new SidebarToolsService({ ...resolved, ...host }),
    };
}
/**
 * 置顶 state for the sections service. Moving an item into a section has to
 * unpin it first, and the pin itself lives in the Application use cases the
 * sidebar already drives.
 */
function sectionPinPort(options) {
    return {
        isPinned: async (target) => 'sessionId' in target
            ? (await options.applications.getPinnedItemsOrder()).items?.some((item) => item.session?.sessionId === target.sessionId) === true
            : (await options.projects.resolve({ workspaceDir: target.projectKey }, false)).pinned,
        releasePin: async (target) => {
            try {
                if ('sessionId' in target) {
                    await options.applications.pinSession({ sessionId: target.sessionId, pinned: false });
                }
                else {
                    const record = await options.projects.resolve({ workspaceDir: target.projectKey }, false);
                    await options.applications.setProjectPinned({
                        project: { projectId: record.projectId },
                        pinned: false,
                    });
                }
                return true;
            }
            catch {
                return false;
            }
        },
    };
}
/**
 * The owner the Runtime composes: the sidebar UI and the Agent's `sidebar.*`
 * tools drive the same capabilities through it, and a v1 host may bind it.
 */
export function createRuntimeSidebarToolsOwner(input) {
    const owner = createSidebarToolsOwner({
        db: input.db,
        ...(input.metrics ? { metrics: input.metrics } : {}),
        applications: sidebarToolsApplications(input.applications),
        agents: sidebarToolsAgents(input.agentService),
        projects: input.projects,
        archiveSession: (sessionId) => input.applications.session.lifecycle.archiveSessionById(sessionId),
        isSessionBusy: input.isSessionBusy,
    });
    input.bind?.(owner);
    return owner;
}
/**
 * The Agent surface-flag read the pin rule needs, from the Agent service the
 * Runtime already owns.
 *
 * The name resolves to its exact storage owner first, so `mavis`, the legacy
 * `main` and an `agent:<name>` ref all reach the same row, and the flag comes
 * from the same `getPersistedOwner` view the Agent list route serves. An
 * unknown name fails here with the Agent service's own `AGENT_NOT_FOUND`,
 * which the tool already reports as `NOT_FOUND`.
 */
function sidebarToolsAgents(agentService) {
    return {
        showInAgentList: async (name) => (await agentService.getPersistedOwner(await agentService.requireExactAgentKey(name)))
            ?.showInAgentList,
    };
}
/** Adapts the Application use cases, which take a transport context, to the tool port. */
function sidebarToolsApplications(applications) {
    return {
        listProjects: (req) => applications.project.listProjects({}, req),
        getSidebarSessionTree: (req) => applications.session.query.getSidebarSessionTree({}, req),
        getPinnedItemsOrder: () => applications.pin.getPinnedItemsOrder({}, {}),
        pinAgent: (req) => applications.pin.pinAgent({}, req),
        pinSession: (req) => applications.pin.pinSession({}, req),
        setProjectPinned: (req) => applications.project.setProjectPinned({}, req),
    };
}
//# sourceMappingURL=initialize.js.map