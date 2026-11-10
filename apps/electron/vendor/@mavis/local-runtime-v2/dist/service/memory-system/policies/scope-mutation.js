import { realpath } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { GLOBAL_SCOPE_KEY, } from '../contracts.js';
export class MemoryScopeMutationCoordinator {
    locks = new Map();
    wakeSink;
    async withScopeMutation(scopeKey, operation, options) {
        while (this.locks.has(scopeKey)) {
            await this.locks.get(scopeKey);
        }
        let release;
        const barrier = new Promise((resolve) => {
            release = resolve;
        });
        this.locks.set(scopeKey, barrier);
        try {
            const result = await operation();
            if (options?.requestWakeOnComplete && this.wakeSink) {
                this.wakeSink();
            }
            return result;
        }
        finally {
            this.locks.delete(scopeKey);
            release();
        }
    }
    bindWakeSink(wake) {
        this.wakeSink = wake;
    }
}
/** 手改摘要与整理发布、Reset 共用互斥区；保留旧基线供下次整理识别手改。 */
export class MemorySummaryEditorImpl {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async withFileEdit(path, edit) {
        const summaryPath = join(this.deps.dataDir, 'memories', 'scopes', GLOBAL_SCOPE_KEY, 'memory_summary.md');
        const [target, summary] = await Promise.all([canonicalPath(path), canonicalPath(summaryPath)]);
        if (target !== summary)
            return edit();
        return this.deps.scopeMutation.withScopeMutation(GLOBAL_SCOPE_KEY, async () => {
            // 先失效在途整理。写文件失败时最多多做一次整理，不会覆盖一次已成功的手改。
            await this.deps.repository.markGovernanceChange(GLOBAL_SCOPE_KEY);
            return edit();
        });
    }
}
async function canonicalPath(path) {
    try {
        return await realpath(path);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        return resolvePath(path);
    }
}
//# sourceMappingURL=scope-mutation.js.map