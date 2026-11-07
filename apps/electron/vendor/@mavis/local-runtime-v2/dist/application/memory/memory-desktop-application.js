import { GLOBAL_SCOPE_KEY } from '../../service/memory-system/index.js';
const LEGACY_MIGRATION_AUTOMATIC = 'legacy-migration-automatic';
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
    /*
     * 旧记忆改为启用引导选择后由 Reconciler 静默迁移（§8），预览三件套没有调用方。
     * 接口仍在跨仓 IDL 中，删除前返回固定错误码，避免旧客户端误以为迁移成功。
     */
    async prepareLegacyMigration(_req) {
        return err(LEGACY_MIGRATION_AUTOMATIC);
    }
    async acceptLegacyMigration(_req) {
        return err(LEGACY_MIGRATION_AUTOMATIC);
    }
    async discardLegacyMigration(_req) {
        return err(LEGACY_MIGRATION_AUTOMATIC);
    }
    async getOnboarding(_req) {
        const state = await this.deps.onboarding.inspect();
        return {
            ...(state.record ? { record: wireOnboardingRecord(state.record) } : {}),
            needsOnboarding: state.needsOnboarding,
        };
    }
    async completeOnboarding(req) {
        const result = await this.deps.onboarding.complete({
            legacyChoice: req.legacyChoice,
            backfillChoice: req.backfillChoice,
        });
        if (result.status !== 'completed')
            return err(result.status);
        return { record: wireOnboardingRecord(result.record) };
    }
}
/** 迁移进度与收尾状态是 runtime 内部状态，wire 只暴露 IDL 定义的三个字段。 */
function wireOnboardingRecord(record) {
    return {
        completedAtMs: record.completedAtMs,
        legacyChoice: record.legacyChoice,
        backfillChoice: record.backfillChoice,
    };
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
            onboarding: memory.onboarding,
        }),
    };
}
//# sourceMappingURL=memory-desktop-application.js.map