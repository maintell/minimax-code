import { NotImplementedError } from '../errors.js';
export class ProjectControllerBase {
    async listProjects(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listProjects');
    }
    async listProjectSessions(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listProjectSessions');
    }
    async updateProject(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('updateProject');
    }
    async setProjectPinned(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('setProjectPinned');
    }
    async setProjectHidden(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('setProjectHidden');
    }
    async putProjectsOrder(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('putProjectsOrder');
    }
    async archiveProjectSessions(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('archiveProjectSessions');
    }
    async listRecentProjects(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listRecentProjects');
    }
    async touchRecentProject(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('touchRecentProject');
    }
    async querySidebarProjects(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('querySidebarProjects');
    }
    async querySidebarProjectSessions(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('querySidebarProjectSessions');
    }
    async querySidebarAgents(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('querySidebarAgents');
    }
    async getSidebarSession(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getSidebarSession');
    }
}
//# sourceMappingURL=project-controller-base.gen.js.map