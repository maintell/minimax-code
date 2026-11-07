/**
 * 串行写入 profile 级权限模式：每次提交都基于前一次的生效值判断模式是否真的变化，
 * 多个客户端的并发写入也按调用顺序生效；某次写入失败不阻塞排在后面的写入。
 */
export class ProcessLocalPermissionModeWriter {
    deps;
    pending = Promise.resolve();
    constructor(deps) {
        this.deps = deps;
    }
    write(mode) {
        const update = this.applyAfter(this.pending, mode);
        this.pending = waitSettled(update);
        return update;
    }
    async applyAfter(previousUpdate, mode) {
        await previousUpdate;
        const previousMode = this.deps.configGetter().permissionMode;
        const { config } = await this.deps.configUpdater({ field: 'permissionMode', set: mode });
        if (mode === 'acceptEdits')
            await this.deps.syncAcceptEditsSeed();
        if (config.permissionMode && previousMode !== config.permissionMode) {
            this.deps.publishGlobalEvent({
                type: 'config.permission_mode.changed',
                payload: { permissionMode: config.permissionMode },
            });
        }
        return config.permissionMode;
    }
}
/** 下一环只等待上一环结束；上一环的失败已经交还给它的调用方。 */
async function waitSettled(update) {
    try {
        await update;
    }
    catch {
        // 不继承上一次写入的失败。
    }
}
//# sourceMappingURL=host-permission-mode.js.map