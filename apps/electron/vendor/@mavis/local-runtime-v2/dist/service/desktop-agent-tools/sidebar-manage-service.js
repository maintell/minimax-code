import { PinnedItemType, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { publishBestEffort } from '@mavis/shared/global-events';
import { DesktopAgentToolError, mapToolError, toProjectId } from '../sidebar-tools/index.js';
/**
 * Backs the `sidebar.project` and `sidebar.view` write tools added after the
 * first slice: create / rename / remove projects and reorder the pinned area.
 *
 * Every method drives a capability the sidebar UI already has. A successful
 * write publishes `sidebar.changed` for the areas it touched, so the sidebar
 * refetches what it owns; nothing here navigates the UI.
 */
export class DesktopSidebarManageService {
    options;
    constructor(options) {
        this.options = options;
    }
    async createProject(req) {
        try {
            await this.requireReviewedName(req.name);
            const result = await this.options.applications.project.createProject({
                displayName: req.name,
                ...(req.workspace_dir !== undefined ? { workspaceDir: req.workspace_dir } : {}),
            });
            const project = requireProject(result.project, 'The project was not created.');
            this.publish(['projects']);
            return {
                project_id: String(project.projectId ?? project.key),
                name: project.displayName ?? project.key,
                ...(project.workspaceDir ? { workspace_dir: project.workspaceDir } : {}),
            };
        }
        catch (error) {
            throw mapToolError(error, 'Failed to create the project.');
        }
    }
    async renameProject(req) {
        try {
            const projectId = toProjectId(req.project);
            await this.requireMutableProject(projectId, 'renamed');
            await this.requireReviewedName(req.name);
            const result = await this.options.applications.project.updateProject({
                project: { projectId },
                displayName: req.name,
            });
            const project = requireProject(result.project, 'The project was not renamed.');
            this.publish(['projects']);
            return {
                project_id: String(project.projectId ?? project.key),
                name: project.displayName ?? project.key,
            };
        }
        catch (error) {
            throw mapToolError(error, 'Failed to rename the project.');
        }
    }
    /**
     * A project name is user-authored text, so it is reviewed before it is
     * written, exactly as the sidebar UI reviews an alias. Anything but an
     * explicit allow leaves the project untouched and names which of the two
     * failures happened: the name itself, or the reviewer.
     */
    async requireReviewedName(name) {
        const verdict = await this.options.reviewProjectName(name);
        if (verdict === 'allow')
            return;
        // The message is the model's only instruction here: without the explicit
        // stop it keeps trying variants of the refused name and finally renames the
        // project to something the user never asked for.
        throw new DesktopAgentToolError(verdict === 'blocked' ? 'CONTENT_BLOCKED' : 'CONTENT_REVIEW_UNAVAILABLE', verdict === 'blocked'
            ? `The name "${name}" did not pass the content review, so nothing was written. ` +
                'Stop here: tell the user this exact name was refused and ask them for a new one. ' +
                'Do not retry with a variant, a translation, a different spelling or a name you invent.'
            : 'The content review service is unavailable right now, so nothing was written and ' +
                'nothing changed. Tell the user it could not be checked and let them decide whether ' +
                'to try again later.');
    }
    async removeProject(req) {
        try {
            const projectId = toProjectId(req.project);
            await this.requireMutableProject(projectId, 'removed');
            const result = await this.options.applications.project.setProjectHidden({
                project: { projectId },
                hidden: true,
            });
            const project = requireProject(result.project, 'The project was not removed.');
            // Hiding a project also drops it from the pinned area's project rows.
            this.publish(['projects', 'pins']);
            return {
                project_id: String(project.projectId ?? project.key),
                name: project.displayName ?? project.key,
                hidden: project.state?.hidden === true,
            };
        }
        catch (error) {
            throw mapToolError(error, 'Failed to remove the project.');
        }
    }
    /**
     * Refuses a rename or a removal aimed at the bucket of chats that are in no
     * project — the row `project_list` marks `is_default`. It is not a project
     * the user created: it has no folder, and hiding it would take every chat
     * that is in no project out of the sidebar at once.
     *
     * `ProjectRecord.projectKind === 'default'` is the same fact
     * `project_list` reports: the wire projection derives that row's
     * `DEFAULT_PROJECT_KEY` from exactly this field.
     */
    async requireMutableProject(projectId, action) {
        const record = await this.options.projects.resolve({ projectId }, false);
        if (record.projectKind !== 'default')
            return;
        throw new DesktopAgentToolError('INVALID_ARGUMENT', [
            'That row is the bucket of chats which are in no project, not a project the user created.',
            'It has no folder,',
            `its name is not the user's, and it is never ${action}.`,
            'Tell the user this instead of retrying with another id.',
        ].join(' '));
    }
    async reorderPinned(req) {
        try {
            const result = await this.options.applications.pin.putPinnedItemsOrder({
                items: req.items.map(toPinnedItemRef),
            });
            this.publish(['pins']);
            return {
                items: (result.items ?? []).map((item) => ({
                    item_type: pinnedItemTypeName(item.itemType),
                    id: item.id,
                })),
            };
        }
        catch (error) {
            throw mapToolError(error, 'Failed to reorder the pinned area.');
        }
    }
    /** Best effort: the write already committed, so a failed hint never fails the call. */
    publish(scopes) {
        for (const scope of scopes) {
            publishBestEffort(this.options.publishGlobalEvent, { type: 'sidebar.changed', payload: { scope } }, (event, error) => {
                // The Runtime wrote successfully but the sidebar will not refresh,
                // so leave the one clue that explains it.
                this.options.logger?.warn({
                    scope,
                    event_type: event.type,
                    error: error instanceof Error ? error.message : String(error),
                }, '[local-runtime-v2] sidebar.changed publish failed after a committed write');
            });
        }
    }
}
function requireProject(project, message) {
    if (!project)
        throw new DesktopAgentToolError('INTERNAL', message);
    return project;
}
function toPinnedItemRef(item) {
    switch (item.item_type) {
        case 'agent':
            return { itemType: PinnedItemType.Agent, id: item.id };
        case 'session':
            return { itemType: PinnedItemType.Session, id: item.id };
        default:
            return { itemType: PinnedItemType.Project, id: item.id };
    }
}
function pinnedItemTypeName(value) {
    switch (value) {
        case PinnedItemType.Agent:
            return 'agent';
        case PinnedItemType.Session:
            return 'session';
        case PinnedItemType.Project:
            return 'project';
        default:
            return 'unknown';
    }
}
//# sourceMappingURL=sidebar-manage-service.js.map