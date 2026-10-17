import { createHash } from 'node:crypto';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { computeOutputDigest, renderSessionMirror, validateDocumentEnvelope, } from './session-doc.js';
export class MemoryCaptureService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /** §2.3 抽取资格的上下文部分：可写会话、可解析 scope、策略放行。不满足即 ineligible。 */
    async resolveWritableScope(config, sessionId, createScope) {
        const ctx = await this.deps.source.readContext(sessionId);
        if (!isWritableContext(ctx))
            return undefined;
        const resolution = this.deps.accessPolicy.resolve({
            contextAvailable: true,
            agentName: ctx.canonicalAgentName,
            projectName: ctx.projectName,
            workspaceDir: ctx.workspaceDir,
        });
        if (resolution.status === 'scope-unresolved')
            return undefined;
        const scope = createScope
            ? await this.deps.repository.ensureScope(resolution.scopeKey)
            : ((await this.deps.repository.getScope(resolution.scopeKey)) ?? {
                resetAtMs: 0,
                resetEpoch: 0,
            });
        const access = this.deps.accessPolicy.evaluate({
            config,
            exclusionReason: undefined,
            rootConversation: ctx.rootConversation,
            sessionCreatedAtMs: ctx.createdAtMs,
            resetAtMs: scope.resetAtMs,
        });
        if (!access.canGenerate)
            return undefined;
        return { ctx, scopeKey: resolution.scopeKey, scope };
    }
    /** 模型调用期间来源修订、scope 纪元或状态行任一移动即视为陈旧（§5.12）。 */
    async isCommitContextStale(candidate, scopeKey, expectedResetEpoch, existingState) {
        const currentRevision = await this.deps.source.currentRevision(candidate.sessionId);
        if (currentRevision === 'not-found' || currentRevision !== candidate.sourceRevision) {
            return true;
        }
        const currentScope = await this.deps.repository.getScope(scopeKey);
        if (!currentScope || currentScope.resetEpoch !== expectedResetEpoch)
            return true;
        const currentState = await this.deps.repository.getSessionState(scopeKey, candidate.sessionId);
        return !sameCaptureState(currentState, existingState);
    }
    /**
     * 模型抽取 + 信封校验(§5.5)：字节上限与小节骨架；内部结构由 prompt 承担。
     * 遗忘规则注入 prompt，防止已删内容再生(§2.4/§5.8)。合法空结果返回 content undefined。
     */
    async generateDocument(contractId, snapshot, forgetRules, maxDocBytes) {
        const modelResult = await this.deps.model.capture({
            contractId,
            snapshot,
            forgetRules,
            maxDocBytes,
            signal: new AbortController().signal,
        });
        if (modelResult.status !== 'ok')
            return mapModelFailure(modelResult);
        const envelope = validateDocumentEnvelope(modelResult.output.document, maxDocBytes);
        if (envelope.status === 'invalid') {
            return { status: 'deferred', reason: 'model-invalid-output' };
        }
        return { content: envelope.status === 'ok' ? envelope.content : undefined };
    }
    async prepare(candidate, createScope) {
        const config = this.deps.config();
        if (!config.writeEnabled)
            return { status: 'ineligible' };
        const resolved = await this.resolveWritableScope(config, candidate.sessionId, createScope);
        if (!resolved)
            return { status: 'ineligible' };
        const { ctx, scopeKey, scope } = resolved;
        const existingState = await this.deps.repository.getSessionState(scopeKey, candidate.sessionId);
        if (existingState?.exclusionReason)
            return { status: 'ineligible' };
        const contract = await this.deps.model.resolveContract('capture');
        const sourceDigest = computeSourceDigest(candidate.sessionId, candidate.sourceRevision, contract.contractId);
        // 未变化短路只看状态水位；镜像缺失由 Reconciler 补物化，不构成重抽理由(§2.3)。
        if (existingState && existingState.sourceDigest === sourceDigest) {
            return { status: 'unchanged' };
        }
        const historyResult = await this.deps.source.readHistory({
            sessionId: candidate.sessionId,
            maxInputTokens: config.maxCaptureInputTokens,
        });
        if (historyResult.status !== 'found')
            return mapHistoryFailure(historyResult.status);
        const snapshot = historyResult.snapshot;
        if (snapshot.sourceRevision !== candidate.sourceRevision)
            return { status: 'stale-input' };
        return {
            status: 'ready',
            config,
            ctx,
            scopeKey,
            scope,
            existingState,
            contract,
            sourceDigest,
            snapshot,
        };
    }
    /** 与执行共用准备逻辑；检查不创建 scope、不推进水位、不调用生成模型。 */
    async inspect(candidate) {
        const prepared = await this.prepare(candidate, false);
        if (prepared.status !== 'ready')
            return prepared;
        return {
            status: 'ready',
            historyInputTokens: countTokens(JSON.stringify(prepared.snapshot)),
            agentName: prepared.ctx.canonicalAgentName,
            projectName: prepared.ctx.projectName,
            workspaceDir: prepared.ctx.workspaceDir,
        };
    }
    async capture(candidate) {
        const prepared = await this.prepare(candidate, true);
        if (prepared.status !== 'ready')
            return prepared;
        const { config, ctx, scopeKey, scope, existingState, contract, sourceDigest, snapshot } = prepared;
        const generated = await this.generateDocument(contract.contractId, snapshot, existingState?.forgetRules, config.maxSessionDocBytes);
        if ('status' in generated)
            return generated;
        const content = generated.content;
        return this.deps.scopeMutation.withScopeMutation(scopeKey, async () => {
            if (await this.isCommitContextStale(candidate, scopeKey, scope.resetEpoch, existingState)) {
                return { status: 'stale-input' };
            }
            const context = await this.deps.source.readContext(candidate.sessionId);
            if (!this.deps.config().writeEnabled || !isWritableContext(context)) {
                return { status: 'ineligible' };
            }
            const capturedAtMs = (this.deps.nowMs ?? Date.now)();
            const mirror = content === undefined
                ? undefined
                : renderSessionMirror({
                    sessionId: candidate.sessionId,
                    sourceRevision: candidate.sourceRevision,
                    sourceDigest,
                    capturedAtMs,
                    agentName: ctx.canonicalAgentName,
                    projectName: ctx.projectName,
                    workspaceDir: ctx.workspaceDir,
                }, content);
            const outputDigest = computeOutputDigest(mirror);
            // 先单事务提交事实层，事务成功后物化镜像；物化失败不回滚(§6.3)。
            const commitResult = await this.deps.repository.commitCapture({
                scopeKey,
                sessionId: candidate.sessionId,
                expectedResetEpoch: scope.resetEpoch,
                expectedSourceRevision: existingState?.sourceRevision,
                sessionCreatedAtMs: snapshot.sessionCreatedAtMs,
                sourceRevision: candidate.sourceRevision,
                sourceDigest,
                captureContractId: contract.contractId,
                outputDigest,
                content,
                agentName: ctx.canonicalAgentName,
                projectName: ctx.projectName,
                workspaceDir: ctx.workspaceDir,
                capturedAtMs,
            });
            if (commitResult === 'stale-input') {
                return { status: 'stale-input' };
            }
            try {
                if (mirror === undefined) {
                    await this.deps.fileStore.deleteSessionMemory(scopeKey, candidate.sessionId);
                }
                else {
                    await this.deps.fileStore.writeSessionMemory(scopeKey, candidate.sessionId, mirror);
                }
            }
            catch {
                // 镜像与 output_digest 不符时由 Reconciler 免模型补物化(§6.4)。
            }
            return {
                status: 'updated',
                sessionId: candidate.sessionId,
                outputDigest,
                hasContent: content !== undefined,
            };
        });
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mapHistoryFailure(status) {
    return status === 'invalid'
        ? { status: 'deferred', reason: 'redaction-failed' }
        : { status: 'ineligible' };
}
function mapModelFailure(result) {
    switch (result.status) {
        case 'failed':
            return { status: 'deferred', reason: result.reason };
        case 'rate-limited':
        case 'stale-contract':
            return { status: 'deferred', reason: 'model-unavailable' };
    }
}
function computeSourceDigest(sessionId, sourceRevision, contractId) {
    return createHash('sha256')
        .update(`${sessionId}\0${sourceRevision}\0${contractId}`)
        .digest('base64url');
}
function isWritableContext(context) {
    return (context.status === 'found' &&
        context.rootConversation &&
        context.memoryPolicy?.writeEnabled !== false);
}
function sameCaptureState(current, previous) {
    if (!current || !previous)
        return current === previous;
    return (!current.exclusionReason &&
        current.sourceRevision === previous.sourceRevision &&
        current.outputDigest === previous.outputDigest &&
        current.forgetRules === previous.forgetRules);
}
//# sourceMappingURL=capture-service.js.map