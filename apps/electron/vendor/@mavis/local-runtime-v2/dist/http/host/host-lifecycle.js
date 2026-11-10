/** Host 的关闭状态与清理顺序；某项失败后仍 drain 其余已创建资源。 */
export class HostResourceLifecycle {
    getResources;
    closing = false;
    closePromise;
    constructor(getResources) {
        this.getResources = getResources;
    }
    get closed() {
        return this.closing;
    }
    beginShutdown() {
        if (this.closing)
            return;
        this.closing = true;
        const resources = this.getResources();
        resources.workspaceIndexingService.closeWorkspacePrewarm();
        resources.backgroundTaskRuntime?.beginShutdown();
    }
    close() {
        if (!this.closePromise) {
            this.beginShutdown();
            this.closePromise = this.closeResources();
        }
        return this.closePromise;
    }
    async closeResources() {
        const resources = this.getResources();
        let firstError;
        const cleanups = [
            () => resources.globalEvents.close(),
            () => resources.workspaceIndexingRemoteWorker.close(),
            async () => resources.backgroundTaskRuntime?.drain(),
            () => resources.errorReporter?.close(),
        ];
        for (const close of cleanups) {
            try {
                await close();
            }
            catch (error) {
                firstError ??= error;
            }
        }
        if (firstError !== undefined)
            throw firstError;
    }
}
//# sourceMappingURL=host-lifecycle.js.map