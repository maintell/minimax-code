import { WorkspaceLocalActionsUnavailableError } from '../errors.js';
/**
 * V2 owner for effects that target the host UI.  The interface is deliberately
 * the same small domain surface consumed by DesktopService; the concrete OS
 * launcher remains an injected adapter so headless CLI hosts cannot execute it.
 */
export class WorkspaceLocalActionsServiceImpl {
    options;
    constructor(options = {}) {
        this.options = options;
    }
    async openApp(input) {
        await this.requirePort('openWorkspaceApp').openApp(input);
    }
    async listIdeApps() {
        return this.requirePort('listIdeApps').listIdeApps();
    }
    async openFile(input) {
        return this.requirePort('openWorkspaceFile').openFile(input);
    }
    async revealFile(input) {
        return this.requirePort('revealWorkspaceFile').revealFile(input);
    }
    async openFileInIde(input) {
        return this.requirePort('openWorkspaceFileInIde').openFileInIde(input);
    }
    requirePort(operation) {
        if (this.options.port)
            return this.options.port;
        throw new WorkspaceLocalActionsUnavailableError(operation);
    }
}
//# sourceMappingURL=workspace-local-actions.service.js.map