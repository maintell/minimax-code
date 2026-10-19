import { GLOBAL_SCOPE_KEY } from '../../service/memory-system/index.js';
function err(code) {
    return { error: { code } };
}
export class MemoryDesktopApplication {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /** 全部字段来自 §5.7 RecallService.getScopeStatus 的单次返回。 */
    async getStatus(req) {
        const result = await this.deps.recall.getScopeStatus(req.sessionId);
        if (result.status !== 'ok') {
            return err(result.status === 'unavailable' ? result.reason : result.status);
        }
        return {
            scopeLabel: GLOBAL_SCOPE_KEY,
            generateEnabled: result.access.canGenerate,
            recallEnabled: result.access.canRecall,
            rebuildPending: result.rebuildPending,
            resetEpoch: result.resetEpoch,
        };
    }
    async listSessions(req) {
        const result = await this.deps.recall.listSessionMemories({
            requestSessionId: req.sessionId,
            ...(req.cursor !== undefined ? { cursor: req.cursor } : {}),
            ...(req.limit !== undefined ? { limit: req.limit } : {}),
        });
        if (result.status === 'empty')
            return { sessions: [] };
        if (result.status !== 'ok') {
            return err(result.status === 'unavailable' ? result.reason : result.status);
        }
        return {
            sessions: result.sessions.map((session) => ({
                sourceSessionId: session.sourceSessionId,
                title: session.title,
                byteSize: session.byteSize,
                hasForgetRules: session.hasForgetRules,
                capturedAtMs: session.capturedAtMs,
                ...(session.lastUsedAtMs !== undefined ? { lastUsedAtMs: session.lastUsedAtMs } : {}),
            })),
            ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
        };
    }
    async getSessionDoc(req) {
        const result = await this.deps.recall.readSessionMemory({
            requestSessionId: req.sessionId,
            sessionId: req.sourceSessionId,
        });
        if (result.status !== 'ok') {
            return err(result.status === 'unavailable' ? result.reason : result.status);
        }
        return {
            markdown: result.markdown,
            ...(result.rulesMarkdown !== undefined ? { rulesMarkdown: result.rulesMarkdown } : {}),
        };
    }
    async forgetContent(req) {
        if (req.forgetWholeSession === true) {
            if (!req.sourceSessionId)
                return err('invalid-query');
            const result = await this.deps.governance.forgetSession({
                requestSessionId: req.sessionId,
                sourceSessionId: req.sourceSessionId,
            });
            return mapForgetResult(result);
        }
        const result = await this.deps.governance.forgetContent({
            requestSessionId: req.sessionId,
            targetText: req.targetText,
            ...(req.sourceSessionId ? { sourceSessionId: req.sourceSessionId } : {}),
        });
        return mapForgetResult(result);
    }
    async resetScope(req) {
        // 确认位由前端弹窗产生；缺失即拒绝，防止误触发不可逆清空（§5.15）。
        if (req.confirmed !== true)
            return err('invalid-query');
        const result = await this.deps.governance.resetScope({
            requestSessionId: req.sessionId,
            confirmed: true,
        });
        if (result.status !== 'reset') {
            return err(result.status === 'unavailable' ? result.reason : result.status);
        }
        return { resetEpoch: result.resetEpoch, filesDeleted: result.filesDeleted };
    }
    async prepareLegacyMigration(req) {
        const result = await this.deps.legacyMigration.prepare({ agentName: req.agentName });
        if (result.status !== 'prepared') {
            return err(result.status === 'unavailable' ? result.reason : result.status);
        }
        return {
            previewId: result.previewId,
            sourceFileCount: result.sourceFileCount,
            documents: result.documents.map((doc) => ({
                sourceFile: doc.sourceFile,
                markdown: doc.markdown,
            })),
        };
    }
    async acceptLegacyMigration(req) {
        const result = await this.deps.legacyMigration.accept({
            agentName: req.agentName,
            previewId: req.previewId,
        });
        if (result.status !== 'accepted') {
            return err(result.status === 'unavailable' ? result.reason : result.status);
        }
        return { documentCount: result.documentCount };
    }
    async discardLegacyMigration(req) {
        const result = await this.deps.legacyMigration.discard({
            agentName: req.agentName,
            previewId: req.previewId,
        });
        if (result.status !== 'discarded') {
            return err(result.status === 'unavailable' ? result.reason : result.status);
        }
        return { discarded: true };
    }
}
function mapForgetResult(result) {
    if (result.status === 'accepted-for-rebuild')
        return { acceptedForRebuild: true };
    if (result.status === 'unchanged')
        return { acceptedForRebuild: false };
    return err(result.status === 'unavailable' ? result.reason : result.status);
}
/** Memory V2 Desktop 管理面（§5.15）：只有装配出 memory system 时才提供 application。 */
export function memoryDesktopApplicationFor(memory) {
    if (!memory)
        return {};
    return {
        memoryV2: new MemoryDesktopApplication({
            recall: memory.recall,
            governance: memory.governance,
            legacyMigration: memory.legacyMigration,
        }),
    };
}
//# sourceMappingURL=memory-desktop-application.js.map