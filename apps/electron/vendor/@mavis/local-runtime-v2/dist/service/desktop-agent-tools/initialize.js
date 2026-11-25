import { AgentFavorites } from '../agent/index.js';
import { reviewProjectName } from '../content-safety/index.js';
import { createRuntimeSidebarToolsOwner } from '../sidebar-tools/index.js';
import { createRuntimeUiRequestBroker } from '../ui-request/index.js';
import { DesktopAppToolsService } from './app-tools-service.js';
import { DesktopSessionToolsService } from './session-tools-service.js';
import { DesktopSidebarManageService } from './sidebar-manage-service.js';
/**
 * One owner shared by the Runtime: the Electron host asks it for the three
 * tool adapters bound to its own event publisher. The sidebar UI and the
 * Agent's tools drive the same capabilities through it.
 */
function createDesktopAgentToolsOwner(options) {
    return {
        createAdapters: (host) => {
            const serviceOptions = { ...options, ...host };
            return {
                sidebarManage: new DesktopSidebarManageService(serviceOptions),
                sessionManage: new DesktopSessionToolsService(serviceOptions),
                appManage: new DesktopAppToolsService(serviceOptions),
            };
        },
    };
}
/** The owner the Runtime composes; a v1 host may bind it. */
function createRuntimeDesktopAgentToolsOwner(input) {
    const owner = createDesktopAgentToolsOwner({
        applications: input.applications,
        projects: input.projects,
        reviewProjectName: (name) => reviewProjectName(input.reviewContent, name),
        subscribeGlobalEvents: input.subscribeGlobalEvents,
        ...(input.logger ? { logger: input.logger } : {}),
    });
    input.bind?.(owner);
    return owner;
}
/**
 * The owners the sidebar tools, the later desktop tools and the UI request
 * broker share, assembled here so the Runtime's own composition file stays a
 * list of values to hand over. Agent favourites come back out because the
 * Runtime also exposes them on its own service surface.
 */
export function composeDesktopToolOwners(sources) {
    const { options, writeGlobalEvent, productionSessionComposition } = sources.prepared;
    const agentFavorites = new AgentFavorites(options.db, options.agentService);
    return {
        agentFavorites,
        sidebarTools: createRuntimeSidebarToolsOwner({
            db: options.db,
            ...(options.metrics ? { metrics: options.metrics } : {}),
            applications: sources.owners.applications,
            agentService: options.agentService,
            projects: productionSessionComposition.sessionSystem.projects.service,
            isSessionBusy: (sessionId) => productionSessionComposition.goal.isSessionBusy(sessionId),
            bind: (owner) => sources.compatibility.sidebarTools?.bind(owner),
        }),
        desktopAgentTools: createRuntimeDesktopAgentToolsOwner({
            applications: desktopAgentToolApplications(sources.owners.applications, sources.application.plugins),
            projects: productionSessionComposition.sessionSystem.projects.service,
            reviewContent: sources.safety.review,
            subscribeGlobalEvents: (subscriber) => options.eventBus.subscribe({ next: subscriber }),
            ...(options.logger ? { logger: options.logger } : {}),
            bind: (owner) => sources.compatibility.desktopAgentTools?.bind(owner),
        }),
        uiRequestBroker: createRuntimeUiRequestBroker({
            publishGlobalEvent: writeGlobalEvent,
            bind: (broker) => sources.compatibility.uiRequests?.bind(broker),
        }),
    };
}
/** Adapts the Application use cases, which take a transport context, to the tool ports. */
function desktopAgentToolApplications(applications, plugins) {
    return {
        project: {
            createProject: (req) => applications.project.createProject({}, req),
            updateProject: (req) => applications.project.updateProject({}, req),
            setProjectHidden: (req) => applications.project.setProjectHidden({}, req),
            putProjectsOrder: (req) => applications.project.putProjectsOrder({}, req),
        },
        pin: {
            putPinnedItemsOrder: (req) => applications.pin.putPinnedItemsOrder({}, req),
        },
        conversation: {
            getSessionForkOptions: (req) => applications.session.conversationMutation.getSessionForkOptions({}, req),
            forkSession: (req) => applications.session.conversationMutation.forkSession({}, req),
        },
        plugins,
    };
}
//# sourceMappingURL=initialize.js.map