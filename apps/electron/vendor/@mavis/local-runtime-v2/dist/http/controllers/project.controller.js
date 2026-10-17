import { ProjectControllerBase } from '../generated/project-controller-base.gen.js';
import { NotImplementedError } from '../errors.js';
export class ProjectController extends ProjectControllerBase {
    applications;
    constructor(applications) {
        super();
        this.applications = applications;
    }
    async querySidebarProjects(ctx, req) {
        return this.requireApplication().querySidebarProjects(ctx, req);
    }
    async querySidebarProjectSessions(ctx, req) {
        return this.requireApplication().querySidebarProjectSessions(ctx, req);
    }
    async querySidebarAgents(ctx, req) {
        return this.requireApplication().querySidebarAgents(ctx, req);
    }
    async getSidebarSession(ctx, req) {
        return this.requireApplication().getSidebarSession(ctx, req);
    }
    async listProjects(ctx, req) {
        return this.requireApplication().listProjects(ctx, req);
    }
    async updateProject(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('updateProject');
    }
    async listProjectSessions(ctx, req) {
        return this.requireApplication().listProjectSessions(ctx, req);
    }
    async setProjectPinned(ctx, req) {
        return this.requireApplication().setProjectPinned(ctx, req);
    }
    async setProjectHidden(ctx, req) {
        return this.requireApplication().setProjectHidden(ctx, req);
    }
    async putProjectsOrder(ctx, req) {
        return this.requireApplication().putProjectsOrder(ctx, req);
    }
    async archiveProjectSessions(ctx, req) {
        return this.requireApplication().archiveProjectSessions(ctx, req);
    }
    async listRecentProjects(ctx, req) {
        return this.requireApplication().listRecentProjects(ctx, req);
    }
    async touchRecentProject(ctx, req) {
        return this.requireApplication().touchRecentProject(ctx, req);
    }
    requireApplication() {
        if (!this.applications)
            throw new NotImplementedError('project applications');
        return this.applications.project;
    }
}
//# sourceMappingURL=project.controller.js.map