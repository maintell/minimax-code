import { isMemoryV2Enabled } from '@mavis/config';
import { createHash } from 'node:crypto';
import { fileFailure, noteFilePath, renderStateMirror } from './memory-files.js';
import { removeEntriesBySource, removeLinesMatching } from './artifact-edit.js';
import { computeOutputDigest, renderRulesMirror, renderSessionMirror } from './session-doc.js';
/** 整会话遗忘写入的排除原因；同时是 §2.3 资格检查的程序级挡板。 */
const USER_FORGOTTEN_REASON = 'user-forgotten';
export class MemoryGovernanceService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /** 显式请求独立持久化，语义交给后续增量整理。 */
    async addAdHocNote(input) {
        if (typeof input.note !== 'string' || !input.note.trim() || !input.toolCallId) {
            return fileFailure('invalid-arguments', 'Provide a non-empty note and a trusted tool call identity.');
        }
        const config = this.deps.config();
        const content = renderNoteDocument('user-request', input.note);
        if (Buffer.byteLength(content, 'utf8') > config.maxSessionDocBytes)
            return fileFailure('invalid-arguments', 'This request exceeds the note size limit.');
        try {
            const ctx = await this.deps.source.readContext(input.requestSessionId);
            if (ctx.status !== 'found')
                return fileFailure('store-unavailable', 'The requesting session is unavailable.');
            const resolution = this.deps.accessPolicy.resolve({
                contextAvailable: true,
                agentName: ctx.canonicalAgentName,
                projectName: ctx.projectName,
                workspaceDir: ctx.workspaceDir,
            });
            if (resolution.status !== 'resolved')
                return fileFailure('store-unavailable', 'Memory scope is unavailable.');
            const scopeKey = resolution.scopeKey;
            return await this.deps.scopeMutation.withScopeMutation(scopeKey, async () => {
                const existingScope = await this.deps.repository.getScope(scopeKey);
                const requestState = await this.deps.repository.getSessionState(scopeKey, input.requestSessionId);
                const access = this.deps.accessPolicy.evaluate({
                    config: { ...config, recallEnabled: isMemoryV2Enabled({ v2: config }) },
                    exclusionReason: requestState?.exclusionReason,
                    rootConversation: ctx.rootConversation,
                    sessionCreatedAtMs: ctx.createdAtMs,
                    resetAtMs: existingScope?.resetAtMs ?? 0,
                });
                if (!access.canRecall || ctx.memoryPolicy?.recallEnabled === false)
                    return fileFailure('disabled', 'Memory is disabled for this session.');
                const scope = existingScope ?? (await this.deps.repository.ensureScope(scopeKey));
                const noteSessionId = `note-${createHash('sha256')
                    .update(JSON.stringify([
                    scopeKey,
                    scope.resetEpoch,
                    input.requestSessionId,
                    input.toolCallId,
                ]))
                    .digest('hex')}`;
                const meta = {
                    sessionId: noteSessionId,
                    sourceRevision: 'ad-hoc',
                    sourceDigest: sha256Base64Url(input.note),
                    capturedAtMs: this.deps.nowMs(),
                    agentName: resolution.annotations.agentName,
                    projectName: resolution.annotations.projectName,
                    workspaceDir: resolution.annotations.workspaceDir,
                };
                const mirror = renderSessionMirror(meta, content);
                const commit = await this.deps.repository.createAdHocNote({
                    scopeKey,
                    sessionId: noteSessionId,
                    expectedResetEpoch: scope.resetEpoch,
                    expectedSourceRevision: undefined,
                    sessionCreatedAtMs: meta.capturedAtMs,
                    sourceRevision: meta.sourceRevision,
                    sourceDigest: meta.sourceDigest,
                    captureContractId: 'ad-hoc-note',
                    outputDigest: computeOutputDigest(mirror),
                    content,
                    agentName: meta.agentName,
                    projectName: meta.projectName,
                    workspaceDir: meta.workspaceDir,
                    capturedAtMs: meta.capturedAtMs,
                });
                if (commit === 'stale-epoch')
                    return fileFailure('store-unavailable', 'Memory was reset during this request.');
                if (commit === 'conflicting-call')
                    return fileFailure('invalid-arguments', 'This call identity already belongs to a different or removed request.');
                try {
                    const stored = commit === 'unchanged'
                        ? await this.deps.repository.getSessionState(scopeKey, noteSessionId)
                        : undefined;
                    await this.deps.fileStore.writeAdHocNoteMirror(scopeKey, `${noteSessionId}.md`, stored ? renderStateMirror(stored) : mirror);
                }
                catch {
                    /* 持久化已完成，镜像交给协调器恢复。 */
                }
                return {
                    status: 'ok',
                    result: { status: 'saved', path: noteFilePath(noteSessionId) },
                };
            }, { requestWakeOnComplete: true });
        }
        catch {
            return fileFailure('store-unavailable', 'The memory request could not be saved. Try again later.');
        }
    }
    async deleteDocumentMirror(scopeKey, sessionId) {
        if (sessionId.startsWith('note-'))
            await this.deps.fileStore.deleteAdHocNoteMirror(scopeKey, `${sessionId}.md`);
        await this.deps.fileStore.deleteSessionMemory(scopeKey, sessionId);
    }
    async forgetContent(input) {
        const targetText = input.targetText.trim();
        if (targetText.length === 0)
            return { status: 'content-not-found' };
        try {
            const scopeKey = await this.resolveScopeKey(input.requestSessionId);
            if (!scopeKey)
                return { status: 'scope-unresolved' };
            return await this.deps.scopeMutation.withScopeMutation(scopeKey, async () => {
                const scope = await this.deps.repository.getScope(scopeKey);
                if (!scope)
                    return { status: 'scope-unresolved' };
                const now = this.deps.nowMs();
                let hit = false;
                // 1) 有来源会话时：编辑 content 并追加遗忘规则，两者同一事务(§5.8)。
                if (input.sourceSessionId !== undefined) {
                    hit = await this.forgetInSessionDoc({
                        scopeKey,
                        resetEpoch: scope.resetEpoch,
                        sessionId: input.sourceSessionId,
                        targetText,
                        now,
                    });
                }
                // 2) 程序直编两份视图，立即移除逐字目标(§5.8)。
                hit = (await this.editArtifact(scopeKey, 'index', targetText)) || hit;
                hit = (await this.editArtifact(scopeKey, 'summary', targetText)) || hit;
                if (!hit)
                    return { status: 'content-not-found' };
                return { status: 'accepted-for-rebuild', scopeKey };
            }, { requestWakeOnComplete: true });
        }
        catch {
            return { status: 'unavailable', reason: 'store-unavailable' };
        }
    }
    /**
     * 编辑来源会话文档并追加遗忘规则，两者同一事务；返回是否落实了本次遗忘。
     * 提供 sourceSessionId 时无论正文是否命中都追加规则——遗忘意图本身值得记录(§5.8)。
     */
    async forgetInSessionDoc(edit) {
        const state = await this.deps.repository.getSessionState(edit.scopeKey, edit.sessionId);
        if (!state)
            return false;
        const newContent = contentAfterRemoval(state.content, edit.targetText);
        const mirror = newContent === undefined ? undefined : renderSessionMirror(mirrorMeta(state), newContent);
        const rule = renderForgetRule(edit.targetText, edit.now);
        const commit = await this.deps.repository.applyContentEdit({
            scopeKey: edit.scopeKey,
            sessionId: edit.sessionId,
            expectedResetEpoch: edit.resetEpoch,
            expectedOutputDigest: state.outputDigest,
            newContent,
            newOutputDigest: computeOutputDigest(mirror),
            appendForgetRule: rule,
            exclusionReason: undefined,
            updatedAtMs: edit.now,
        });
        if (commit !== 'committed')
            return false;
        await this.materializeSession(edit.scopeKey, edit.sessionId, mirror, {
            ...state,
            forgetRules: appendRule(state.forgetRules, rule),
            updatedAtMs: edit.now,
        });
        return true;
    }
    async forgetSession(input) {
        try {
            const scopeKey = await this.resolveScopeKey(input.requestSessionId);
            if (!scopeKey)
                return { status: 'scope-unresolved' };
            return await this.deps.scopeMutation.withScopeMutation(scopeKey, async () => {
                const scope = await this.deps.repository.getScope(scopeKey);
                if (!scope)
                    return { status: 'scope-unresolved' };
                const now = this.deps.nowMs();
                const rule = renderForgetSessionRule(now);
                const state = await this.deps.repository.getSessionState(scopeKey, input.sourceSessionId);
                if (state) {
                    // 清空文档 + 追加规则 + 程序级排除，同一事务(§5.8)。
                    await this.deps.repository.applyContentEdit({
                        scopeKey,
                        sessionId: input.sourceSessionId,
                        expectedResetEpoch: scope.resetEpoch,
                        expectedOutputDigest: state.outputDigest,
                        newContent: undefined,
                        newOutputDigest: computeOutputDigest(undefined),
                        appendForgetRule: rule,
                        exclusionReason: USER_FORGOTTEN_REASON,
                        updatedAtMs: now,
                    });
                }
                else {
                    // 无状态行时插入排除桩，防止后续抽取(§5.12)。
                    await this.deps.repository.excludeSession({
                        scopeKey,
                        sessionId: input.sourceSessionId,
                        expectedSourceRevision: undefined,
                        reason: USER_FORGOTTEN_REASON,
                        updatedAtMs: now,
                    });
                }
                // 直编索引：删除来源标注为该会话的条目；摘要留待重建收敛(§5.8)。
                const index = await this.deps.fileStore.readMemoryIndex(scopeKey);
                if (index !== undefined) {
                    const edited = removeEntriesBySource(index, new Set([input.sourceSessionId]));
                    if (edited.removed > 0) {
                        await this.deps.fileStore.writeMemoryIndex(scopeKey, edited.markdown);
                    }
                }
                try {
                    await this.deleteDocumentMirror(scopeKey, input.sourceSessionId);
                    const updated = await this.deps.repository.getSessionState(scopeKey, input.sourceSessionId);
                    if (updated?.forgetRules !== undefined) {
                        await this.deps.fileStore.writeSessionRules(scopeKey, input.sourceSessionId, renderRulesMirror({
                            sessionId: input.sourceSessionId,
                            updatedAtMs: updated.updatedAtMs,
                            rules: updated.forgetRules,
                        }));
                    }
                }
                catch {
                    // 镜像收敛由 Reconciler 兜底(§6.4)。
                }
                return { status: 'accepted-for-rebuild', scopeKey };
            }, { requestWakeOnComplete: true });
        }
        catch {
            return { status: 'unavailable', reason: 'store-unavailable' };
        }
    }
    async resetScope(input) {
        try {
            const scopeKey = await this.resolveScopeKey(input.requestSessionId);
            if (!scopeKey)
                return { status: 'scope-unresolved' };
            return await this.deps.scopeMutation.withScopeMutation(scopeKey, async () => {
                await this.deps.repository.ensureScope(scopeKey);
                const resetRow = await this.deps.repository.resetScope({
                    scopeKey,
                    requestedAtMs: this.deps.nowMs(),
                });
                let filesDeleted = false;
                try {
                    await this.deps.fileStore.deleteScopeFiles(scopeKey);
                    filesDeleted = true;
                }
                catch {
                    // 清空纪元已经提交，文件清理由下一次协调唤醒重试。
                }
                return {
                    status: 'reset',
                    scopeKey: resetRow.scopeKey,
                    resetEpoch: resetRow.resetEpoch,
                    filesDeleted,
                };
            }, { requestWakeOnComplete: true });
        }
        catch {
            return { status: 'unavailable', reason: 'store-unavailable' };
        }
    }
    async excludeSession(input) {
        try {
            const scopeKey = await this.resolveScopeKey(input.requestSessionId);
            if (!scopeKey)
                return { status: 'scope-unresolved' };
            const scope = await this.deps.repository.getScope(scopeKey);
            if (!scope)
                return { status: 'scope-unresolved' };
            return await this.deps.scopeMutation.withScopeMutation(scopeKey, async () => {
                const state = await this.deps.repository.getSessionState(scopeKey, input.requestSessionId);
                const now = this.deps.nowMs();
                const result = await this.deps.repository.excludeSession({
                    scopeKey,
                    sessionId: input.requestSessionId,
                    expectedSourceRevision: state?.sourceRevision,
                    reason: input.reason,
                    updatedAtMs: now,
                });
                if (result === 'stale-input')
                    return { status: 'unchanged' };
                try {
                    await this.deleteDocumentMirror(scopeKey, input.requestSessionId);
                }
                catch {
                    // Best-effort file deletion
                }
                return { status: 'accepted-for-rebuild', scopeKey };
            }, { requestWakeOnComplete: true });
        }
        catch {
            return { status: 'unavailable', reason: 'store-unavailable' };
        }
    }
    async onSessionDeleted(input) {
        try {
            const scopeKey = await this.resolveScopeKey(input.requestSessionId);
            if (!scopeKey)
                return { status: 'scope-unresolved' };
            const scope = await this.deps.repository.getScope(scopeKey);
            if (!scope)
                return { status: 'unchanged' };
            return await this.deps.scopeMutation.withScopeMutation(scopeKey, async () => {
                const result = await this.deps.repository.deleteSessionState({
                    scopeKey,
                    sessionId: input.requestSessionId,
                });
                try {
                    await this.deleteDocumentMirror(scopeKey, input.requestSessionId);
                    await this.deps.fileStore.deleteSessionRules(scopeKey, input.requestSessionId);
                }
                catch {
                    // Best-effort
                }
                if (result === 'unchanged')
                    return { status: 'unchanged' };
                return { status: 'accepted-for-rebuild', scopeKey };
            }, { requestWakeOnComplete: true });
        }
        catch {
            return { status: 'unavailable', reason: 'store-unavailable' };
        }
    }
    async applyRetention(input) {
        try {
            const expired = await this.deps.repository.listExpiredSessionCandidates({
                nowMs: input.nowMs,
                retentionDays: input.retentionDays,
                limit: input.limit,
            });
            // §5.18 生命周期豁免：ad-hoc note 是长期变更单，仅 Reset 清除。
            const candidates = expired.filter((c) => !c.sessionId.startsWith('note-'));
            if (candidates.length === 0) {
                return { status: 'completed', prunedSessions: [], affectedScopeKeys: [] };
            }
            // Group by scope
            const byScope = new Map();
            for (const c of candidates) {
                let list = byScope.get(c.scopeKey);
                if (!list) {
                    list = [];
                    byScope.set(c.scopeKey, list);
                }
                list.push(c.sessionId);
            }
            const cutoffMs = input.nowMs - input.retentionDays * 24 * 60 * 60 * 1000;
            const allPruned = [];
            const affectedScopes = [];
            for (const [scopeKey, sessionIds] of byScope) {
                await this.deps.scopeMutation.withScopeMutation(scopeKey, async () => {
                    const pruneResult = await this.deps.repository.pruneExpired({
                        scopeKey,
                        sessionIds,
                        cutoffAtMs: cutoffMs,
                    });
                    for (const sid of pruneResult.prunedSessionIds) {
                        try {
                            await this.deleteDocumentMirror(scopeKey, sid);
                            await this.deps.fileStore.deleteSessionRules(scopeKey, sid);
                        }
                        catch {
                            // Best-effort
                        }
                        allPruned.push({ scopeKey, sessionId: sid });
                    }
                    if (pruneResult.prunedSessionIds.length > 0) {
                        affectedScopes.push(scopeKey);
                    }
                }, { requestWakeOnComplete: true });
            }
            return {
                status: 'completed',
                prunedSessions: allPruned,
                affectedScopeKeys: affectedScopes,
            };
        }
        catch {
            return { status: 'unavailable', reason: 'store-unavailable' };
        }
    }
    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------
    async resolveScopeKey(requestSessionId) {
        const ctx = await this.deps.source.readContext(requestSessionId);
        const resolution = this.deps.accessPolicy.resolve({
            contextAvailable: ctx.status === 'found',
            agentName: ctx.status === 'found' ? ctx.canonicalAgentName : undefined,
            projectName: ctx.status === 'found' ? ctx.projectName : undefined,
            workspaceDir: ctx.status === 'found' ? ctx.workspaceDir : undefined,
        });
        return resolution.status === 'resolved' ? resolution.scopeKey : undefined;
    }
    /** 视图直编：命中行删除，temp + rename 完整替换；摘要首行 v2 始终保留(§5.8)。 */
    async editArtifact(scopeKey, kind, targetText) {
        const current = kind === 'index'
            ? await this.deps.fileStore.readMemoryIndex(scopeKey)
            : await this.deps.fileStore.readMemorySummary(scopeKey);
        if (current === undefined)
            return false;
        let head = '';
        let body = current;
        if (kind === 'summary') {
            const newline = current.indexOf('\n');
            head = newline === -1 ? current : current.slice(0, newline + 1);
            body = newline === -1 ? '' : current.slice(newline + 1);
        }
        const edited = removeLinesMatching(body, targetText);
        if (edited.removed === 0)
            return false;
        await this.deps.repository.markGovernanceChange(scopeKey);
        const next = `${head}${edited.markdown}`;
        if (kind === 'index')
            await this.deps.fileStore.writeMemoryIndex(scopeKey, next);
        else
            await this.deps.fileStore.writeMemorySummary(scopeKey, next);
        return true;
    }
    async materializeSession(scopeKey, sessionId, mirror, state) {
        try {
            if (mirror === undefined) {
                await this.deleteDocumentMirror(scopeKey, sessionId);
            }
            else if (sessionId.startsWith('note-'))
                await this.deps.fileStore.writeAdHocNoteMirror(scopeKey, `${sessionId}.md`, mirror);
            else
                await this.deps.fileStore.writeSessionMemory(scopeKey, sessionId, mirror);
            if (state.forgetRules !== undefined) {
                await this.deps.fileStore.writeSessionRules(scopeKey, sessionId, renderRulesMirror({
                    sessionId,
                    updatedAtMs: state.updatedAtMs,
                    rules: state.forgetRules,
                }));
            }
        }
        catch {
            // 镜像收敛由 Reconciler 兜底(§6.4)。
        }
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** 直编后的正文：未命中保持原文，命中后空文档折叠为 undefined（§5.8）。 */
function contentAfterRemoval(content, targetText) {
    if (content === undefined)
        return undefined;
    const edited = removeLinesMatching(content, targetText);
    return edited.removed > 0 ? emptyToUndefined(edited.markdown) : content;
}
/** §5.18：信封由程序拼装——标题 + 固定小节包住原文引用，满足 §6.2 骨架校验。 */
function renderNoteDocument(slug, note) {
    const quoted = note
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    return `# ${slug}\n\n## 事实与决策\n\n${quoted}`;
}
function sha256Base64Url(value) {
    return createHash('sha256').update(value).digest('base64url');
}
function mirrorMeta(state) {
    return {
        sessionId: state.sessionId,
        sourceRevision: state.sourceRevision,
        sourceDigest: state.sourceDigest,
        capturedAtMs: state.capturedAtMs,
        agentName: state.agentName,
        projectName: state.projectName,
        workspaceDir: state.workspaceDir,
    };
}
function renderForgetRule(targetText, nowMs) {
    const date = new Date(nowMs).toISOString().slice(0, 10);
    const quoted = targetText
        .split('\n')
        .map((line) => `  > ${line}`)
        .join('\n');
    return `- 用户于 ${date} 要求忘记以下内容，重抽本会话时不得再生成相同或近似的记忆：\n${quoted}`;
}
function renderForgetSessionRule(nowMs) {
    const date = new Date(nowMs).toISOString().slice(0, 10);
    return `- 用户于 ${date} 要求忘记整个会话：本会话不得再产生任何记忆。`;
}
function appendRule(existing, rule) {
    return existing === undefined ? rule : `${existing}\n${rule}`;
}
function emptyToUndefined(markdown) {
    return markdown.trim().length === 0 ? undefined : markdown;
}
//# sourceMappingURL=governance-service.js.map