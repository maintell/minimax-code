import { countTokens as countO200kBaseTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { noteFilePath, renderStateMirror } from './memory-files.js';
import { buildBaselineFiles, buildConsolidationWorkdirFiles, computeContentChanges, finalizeArtifacts, finalizeEditedArtifacts, initialContentChanges, keptSources, matchesBaselineContract, notesChangedSinceBaseline, needsInitialBaseline, userEditedSummaryLines, } from './consolidation/artifacts.js';
import { buildSelectionInputs, computeInputDigest } from './consolidation/plan.js';
import { readPublishedArtifacts, restoreArtifacts } from './consolidation/publication.js';
import { carrySummaryRequestLines, listArtifactSourceIds, restoreEntriesBySource, } from './artifact-edit.js';
import { ConsolidationCheckpoints, isResumableFailure, publishedDrift, } from './consolidation/checkpoint.js';
/**
 * 整理模型窗口下限。整理 agent 要把整份选集、已有产物与 changes.md 一起读进上下文再逐文件
 * 编辑，窗口不足时模型会在写完产物前耗尽预算，产出半份结果。窗口取模型登记值
 * （`resolveModel` 返回的 `contextWindow`），不用输入预算加输出上限反推——后者会高估。
 * 空选集清理不需要模型，先于本门槛执行。
 */
export const MIN_CONSOLIDATION_CONTEXT_WINDOW = 250_000;
/** 一轮整理的执行时限；到期按环境故障处理，草稿留到下次续跑。 */
const CONSOLIDATION_RUN_TIMEOUT_MS = 60 * 60 * 1000;
export class MemoryConsolidationService {
    deps;
    checkpoints;
    constructor(deps) {
        this.deps = deps;
        this.checkpoints = new ConsolidationCheckpoints({
            fileStore: deps.fileStore,
            repository: deps.repository,
            ...(deps.diagnostics ? { diagnostics: deps.diagnostics } : {}),
            nowMs: () => this.now(),
        });
    }
    dropStaleCheckpoints() {
        return this.checkpoints.dropStale();
    }
    discardCheckpoints() {
        return this.checkpoints.dropAll('write-disabled');
    }
    async inspect(scopeKey) {
        const config = this.deps.config();
        const scope = await this.deps.repository.getScope(scopeKey);
        if (!scope)
            return { cooldownUntilMs: 0, documents: [], notes: [] };
        const all = await this.deps.repository.selectCurrentSessions({
            scopeKey,
            createdAfterMs: scope.resetAtMs,
            maxSessions: Number.MAX_SAFE_INTEGER,
        });
        const selection = all.slice(0, config.maxSelectedSessions);
        const contract = await this.deps.model.resolveContract('consolidation');
        const { selected } = buildSelectionInputs(selection, Math.min(config.maxConsolidationInputTokens, contract.maxInputTokens));
        const selectedIds = new Set(selected.map((state) => state.sessionId));
        const baseline = new Map((await this.deps.repository.listBaselineFiles(scopeKey)).map((file) => [
            file.fileName,
            file.content,
        ]));
        const notes = await this.deps.repository.listAdHocNotes(scopeKey);
        return {
            cooldownUntilMs: (scope.lastConsolidatedAtMs ?? 0) + config.publicationCooldownMs,
            documents: all.map((state, index) => {
                const isSelected = selectedIds.has(state.sessionId);
                let reason = 'selected';
                if (!isSelected)
                    reason = index >= config.maxSelectedSessions ? 'selection-limit' : 'input-budget';
                return {
                    sessionId: state.sessionId,
                    selected: isSelected,
                    reason,
                    changed: baseline.get(`sessions/${state.sessionId}.md`) !== renderStateMirror(state),
                    tokens: countO200kBaseTokens(renderStateMirror(state)),
                };
            }),
            notes: notes.map((state) => ({
                sessionId: state.sessionId,
                changed: baseline.get(noteFilePath(state.sessionId)) !== renderStateMirror(state),
                tokens: countO200kBaseTokens(renderStateMirror(state)),
            })),
        };
    }
    async rebuild(scopeKey, options) {
        const config = this.deps.config();
        const scope = await this.deps.repository.getScope(scopeKey);
        if (!scope)
            return { status: 'unchanged' };
        const early = await this.resumeOrCooldown(scope, options?.reason ?? 'routine');
        if (early)
            return early;
        const selection = await this.deps.repository.selectCurrentSessions({
            scopeKey,
            createdAfterMs: scope.resetAtMs,
            maxSessions: config.maxSelectedSessions,
        });
        const notes = await this.deps.repository.listAdHocNotes(scopeKey);
        if (selection.length + notes.length === 0) {
            return this.publishEmpty(scopeKey, scope.resetEpoch, config);
        }
        const contract = await this.deps.model.resolveContract('consolidation');
        if (contract.contextWindow < MIN_CONSOLIDATION_CONTEXT_WINDOW) {
            return {
                status: 'skipped',
                reason: 'model-context-too-small',
                contextWindow: contract.contextWindow,
            };
        }
        // 选集输入全部来自 DB content，整理全程不读镜像文件(§5.6)。
        const { docs, selected } = buildSelectionInputs(selection, Math.min(config.maxConsolidationInputTokens, contract.maxInputTokens));
        if (selected.length + notes.length === 0)
            return { status: 'deferred', reason: 'size-limit-exceeded' };
        const inputDigest = computeInputDigest(scopeKey, scope.resetEpoch, [...selected, ...notes], {
            governanceRevision: scope.governanceRevision,
            contractId: contract.artifactContractId,
            config,
            admitted: selection,
        });
        const baseline = await this.deps.repository.listBaselineFiles(scopeKey);
        if (await this.canReuseConsolidation(scope, inputDigest, baseline, contract.artifactContractId)) {
            return { status: 'unchanged' };
        }
        const artifacts = await this.produceArtifacts({
            scopeKey,
            resetEpoch: scope.resetEpoch,
            consolidatedDigest: scope.consolidatedDigest,
            baseline,
            config,
            contract,
            docs,
            selected,
            admitted: selection,
            notes,
        }, { inputDigest, governanceRevision: scope.governanceRevision });
        if ('status' in artifacts)
            return artifacts;
        return this.deps.scopeMutation.withScopeMutation(scopeKey, async () => {
            const currentScope = await this.deps.repository.getScope(scopeKey);
            if (!currentScope ||
                currentScope.resetEpoch !== scope.resetEpoch ||
                currentScope.governanceRevision !== scope.governanceRevision) {
                return { status: 'stale-input' };
            }
            const currentSelection = await this.deps.repository.selectCurrentSessions({
                scopeKey,
                createdAfterMs: scope.resetAtMs,
                maxSessions: config.maxSelectedSessions,
            });
            const { selected: currentEligible } = buildSelectionInputs(currentSelection, Math.min(config.maxConsolidationInputTokens, contract.maxInputTokens));
            const currentNotes = await this.deps.repository.listAdHocNotes(scopeKey);
            const currentInputDigest = computeInputDigest(scopeKey, scope.resetEpoch, [...currentEligible, ...currentNotes], {
                governanceRevision: currentScope.governanceRevision,
                contractId: contract.artifactContractId,
                config,
                admitted: currentSelection,
            });
            if (currentInputDigest !== inputDigest) {
                return { status: 'stale-input' };
            }
            return this.writeAndCommit(scope, artifacts, currentEligible, {
                expectedSelection: [...currentEligible, ...currentNotes].map((s) => ({
                    sessionId: s.sessionId,
                    outputDigest: s.outputDigest,
                })),
                inputDigest,
                baselineFiles: buildBaselineFiles(artifacts, {
                    selected: currentEligible,
                    admitted: currentSelection,
                    notes: currentNotes,
                    baseline,
                }, contract.artifactContractId),
            });
        });
    }
    /**
     * 读选集之前的两个出口。上一轮因模型服务故障中断时先接着它的草稿做完，它已经开始过，不受成功
     * 冷却约束；否则常规刷新距上次成功不足冷却期时直接跳过，不读选集(§5.6)。
     */
    async resumeOrCooldown(scope, reason) {
        const resumed = await this.resumeCheckpoint(scope);
        if (resumed)
            return resumed;
        return reason === 'routine' && inSuccessCooldown(scope, this.deps.config(), this.now())
            ? { status: 'cooldown' }
            : undefined;
    }
    /**
     * 有可以续跑的草稿时接着上次的进度整理，并按冻结的输入发布；没有草稿或草稿已作废时返回
     * undefined，由调用方按常规整理。模型窗口不足时保留草稿，等窗口恢复。
     */
    async resumeCheckpoint(scope) {
        if (!(await this.checkpoints.has(scope.scopeKey)))
            return undefined;
        const contract = await this.deps.model.resolveContract('consolidation');
        if (contract.contextWindow < MIN_CONSOLIDATION_CONTEXT_WINDOW) {
            return {
                status: 'skipped',
                reason: 'model-context-too-small',
                contextWindow: contract.contextWindow,
            };
        }
        const round = await this.checkpoints.load(scope, contract.contractId);
        if (!round)
            return undefined;
        const workDir = await this.checkpoints.take(scope.scopeKey);
        this.deps.diagnostics?.event('consolidation.checkpoint-resumed', {
            scopeKey: scope.scopeKey,
            resumeCount: round.resumeCount,
            ageMs: this.now() - round.frozenAtMs,
        });
        const artifacts = await this.editInWorkdir(round, workDir, true);
        if ('status' in artifacts)
            return artifacts;
        return this.publishFrozen(round, artifacts);
    }
    /**
     * 按冻结的输入发布续跑结果：只要求纪元、治理版本与已发布产物没变，不核对选集当前状态；
     * 冻结之后新增的「## 记忆请求」行补进摘要。基线与指纹都取冻结时的输入，新的变化由下一轮增量补上。
     */
    publishFrozen(round, artifacts) {
        const { job } = round;
        return this.deps.scopeMutation.withScopeMutation(job.scopeKey, async () => {
            const scope = await this.deps.repository.getScope(job.scopeKey);
            const stale = frozenScopeChange(round, scope);
            if (stale) {
                this.checkpoints.discarded(job.scopeKey, stale);
                return { status: 'stale-input' };
            }
            const requestLines = publishedDrift(round, await this.checkpoints.published(job.scopeKey));
            if (requestLines === undefined) {
                this.checkpoints.discarded(job.scopeKey, 'artifacts-changed');
                return { status: 'stale-input' };
            }
            const published = this.withRequestLines(job, artifacts, requestLines);
            return this.writeAndCommit(job, published, job.selected, {
                expectedSelection: [],
                frozenGovernanceRevision: round.governanceRevision,
                inputDigest: round.inputDigest,
                baselineFiles: buildBaselineFiles(published, job, job.contract.artifactContractId),
            });
        });
    }
    /** 冻结之后保存 note 写进摘要的请求行补进草稿摘要；超出摘要预算的行不补，由下一轮整理归置。 */
    withRequestLines(job, artifacts, requestLines) {
        if (requestLines.length === 0)
            return artifacts;
        const carried = carrySummaryRequestLines(artifacts.summaryMarkdown, requestLines, job.config.maxSummaryInjectionTokens);
        this.deps.diagnostics?.event('consolidation.request-lines-carried', {
            scopeKey: job.scopeKey,
            carried: carried.carried,
            dropped: carried.dropped,
        });
        return { ...artifacts, summaryMarkdown: carried.markdown };
    }
    /** 写入两份产物，并把基线快照与完成标记同事务整体替换(§5.6/§6.1)；提交失败时写回原产物。 */
    async writeAndCommit(scope, artifacts, eligible, commit) {
        const { scopeKey } = scope;
        await this.deleteOrphanFiles(scopeKey, eligible);
        const prior = await readPublishedArtifacts(this.deps.fileStore, scopeKey);
        await this.deps.fileStore.writeMemoryIndex(scopeKey, artifacts.indexMarkdown);
        await this.deps.fileStore.writeMemorySummary(scopeKey, artifacts.summaryMarkdown);
        const rereadScope = await this.deps.repository.getScope(scopeKey);
        if (!rereadScope || rereadScope.resetEpoch !== scope.resetEpoch) {
            return { status: 'stale-input' };
        }
        const commitResult = await this.deps.repository.commitConsolidation({
            scopeKey,
            expectedResetEpoch: scope.resetEpoch,
            ...commit,
            consolidatedAtMs: this.now(),
        });
        if (commitResult === 'stale-input') {
            // 产物已写盘而基线未提交：回滚到与旧基线一致的内容，避免本轮模型写的摘要行在下一轮被当成手改。
            await restoreArtifacts(this.deps.fileStore, scopeKey, prior);
            return { status: 'stale-input' };
        }
        return { status: 'published', inputDigest: commit.inputDigest, sessionCount: eligible.length };
    }
    /** 按产物与基线选择工作模式，两种模式共用文件编辑与发布协议。 */
    async produceArtifacts(job, identity) {
        const previousIndex = await this.deps.fileStore.readMemoryIndex(job.scopeKey);
        const previousSummary = await this.deps.fileStore.readMemorySummary(job.scopeKey);
        const previous = { previousIndex, previousSummary };
        const baseline = job.baseline;
        const init = needsInitialBaseline(job, baseline, previous);
        const index = previousIndex ?? '';
        const summary = previousSummary ?? '';
        const previousArtifacts = { indexMarkdown: index, summaryMarkdown: summary };
        const changes = init
            ? initialContentChanges(job, previousArtifacts)
            : computeContentChanges(baseline, previousArtifacts, job);
        const mode = init ? 'INIT' : 'INCREMENTAL';
        const protectedLines = userEditedSummaryLines(baseline, summary);
        if (!changes) {
            return (finalizeArtifacts(index, summary, job, protectedLines) ?? {
                status: 'deferred',
                reason: 'model-invalid-output',
            });
        }
        const kept = keptSources(index, job);
        const files = buildConsolidationWorkdirFiles(previousArtifacts, changes, { ...job, kept }, protectedLines);
        const round = {
            job,
            ...identity,
            mode,
            changes,
            protectedLines,
            kept,
            initialIndex: files.find((file) => file.fileName === 'MEMORY.md')?.markdown ?? '',
            publishedIndex: previousIndex,
            publishedSummary: previousSummary,
            frozenAtMs: this.now(),
            resumeCount: 0,
        };
        let workDir;
        try {
            workDir = await this.deps.fileStore.createConsolidationWorkdir(job.scopeKey, files);
        }
        catch {
            return { status: 'deferred', reason: 'store-unavailable' };
        }
        return this.editInWorkdir(round, workDir, false);
    }
    /**
     * 在工作目录里运行整理 Agent，成功后读回并校验两份草稿，由调用方条件提交。模型服务故障时把
     * 工作目录留作草稿，下次续跑；其余失败删除工作目录，不发布。
     */
    async editInWorkdir(round, workDir, resumed) {
        let saved = false;
        try {
            const before = resumed
                ? await this.deps.fileStore.readConsolidationWorkdir(workDir)
                : undefined;
            const timeout = AbortSignal.timeout(CONSOLIDATION_RUN_TIMEOUT_MS);
            const result = await this.deps.model.consolidateInPlace(consolidationInput(round, workDir, resumed, timeout));
            if (result.status === 'ok')
                return await this.readDrafts(round, workDir);
            saved =
                isResumableFailure(result, timeout.aborted) &&
                    (await this.saveCheckpoint(round, workDir, result, before));
            return {
                status: 'deferred',
                reason: result.status === 'failed' ? result.reason : 'model-unavailable',
            };
        }
        catch {
            return { status: 'deferred', reason: 'store-unavailable' };
        }
        finally {
            if (!saved)
                await this.deleteWorkdir(workDir);
        }
    }
    /** 读回两份草稿并校验。 */
    async readDrafts(round, workDir) {
        const { job } = round;
        const edited = await this.deps.fileStore.readConsolidationWorkdir(workDir);
        // INIT 从本轮输入重建索引，可能漏掉本轮之外来源的条目，程序在校验前补回。note 相对上次发布
        // 基线有新增、修改或删除时不补回：新的 note 可能要求遗忘这些来源的内容，交给模型判断。
        // 带遗忘规则的来源同理。
        const checked = round.mode === 'INIT' && !notesChangedSinceBaseline(job.baseline, job.notes)
            ? this.restoreKeptSources(job, edited, round.initialIndex, round.kept)
            : edited;
        return (finalizeEditedArtifacts(checked, job, round.protectedLines) ?? {
            status: 'deferred',
            reason: 'model-invalid-output',
        });
    }
    /**
     * 留草稿续跑。续跑这次草稿有改动才计入续跑次数：额度还没恢复时续跑在第一次请求就失败，
     * 不应耗掉次数。
     */
    async saveCheckpoint(round, workDir, result, before) {
        const progressed = before !== undefined &&
            JSON.stringify(before) !==
                JSON.stringify(await this.deps.fileStore.readConsolidationWorkdir(workDir));
        return this.checkpoints.save({ ...round, resumeCount: round.resumeCount + (progressed ? 1 : 0) }, workDir, result.status === 'failed'
            ? { reason: result.reason, ...(result.errorKind ? { errorKind: result.errorKind } : {}) }
            : { reason: result.status });
    }
    async deleteWorkdir(workDir) {
        try {
            await this.deps.fileStore.deleteConsolidationWorkdir(workDir);
        }
        catch {
            // 残留由 tmp 清理兜底。
        }
    }
    /**
     * 本轮之外的来源（不含带遗忘规则的）在新 MEMORY.md 里一条条目都没有时，从工作目录初始的
     * MEMORY.md 取出它们的条目块整块放回；之后照常做日期、字节与准入校验。INIT 不做 removed
     * 预处理，初始索引里仍有已退出准入集合的来源，所以只放回全部来源都在准入集合内、且都没有
     * 遗忘规则的条目块。
     */
    restoreKeptSources(job, edited, initialIndex, kept) {
        const index = edited.find((file) => file.fileName === 'MEMORY.md')?.markdown ?? '';
        const present = listArtifactSourceIds(index);
        const missing = new Set(kept
            .filter(({ sessionId, forgetRules }) => forgetRules === undefined && !present.has(sessionId))
            .map((state) => state.sessionId));
        if (missing.size === 0)
            return edited;
        const previous = initialIndex;
        const restorable = new Set(job.admitted.filter((state) => state.forgetRules === undefined).map((s) => s.sessionId));
        const result = restoreEntriesBySource(previous, index, { missing, restorable });
        this.deps.diagnostics?.event('consolidation.kept-sources-restored', {
            sources: [...missing].map((sessionId) => ({
                sessionId,
                restored: result.restored.get(sessionId) ?? 0,
                skipped: result.skipped.get(sessionId) ?? 0,
            })),
        });
        return [
            ...edited.filter((file) => file.fileName !== 'MEMORY.md'),
            { fileName: 'MEMORY.md', markdown: result.markdown },
        ];
    }
    async publishEmpty(scopeKey, resetEpoch, config) {
        return this.deps.scopeMutation.withScopeMutation(scopeKey, async () => {
            const currentScope = await this.deps.repository.getScope(scopeKey);
            if (!currentScope || currentScope.resetEpoch !== resetEpoch) {
                return { status: 'stale-input' };
            }
            const current = await this.deps.repository.selectCurrentSessions({
                scopeKey,
                createdAfterMs: currentScope.resetAtMs,
                maxSessions: config.maxSelectedSessions,
            });
            if (current.length > 0 || (await this.deps.repository.listAdHocNotes(scopeKey)).length > 0) {
                return { status: 'stale-input' };
            }
            await this.deps.fileStore.deleteScopeFiles(scopeKey);
            const emptyDigest = computeInputDigest(scopeKey, resetEpoch, []);
            const commitResult = await this.deps.repository.commitConsolidation({
                scopeKey,
                expectedResetEpoch: resetEpoch,
                expectedSelection: [],
                inputDigest: emptyDigest,
                baselineFiles: [],
                consolidatedAtMs: this.now(),
            });
            if (commitResult === 'stale-input')
                return { status: 'stale-input' };
            return { status: 'empty' };
        });
    }
    async deleteOrphanFiles(scopeKey, currentEligible) {
        const currentSessionIds = new Set(currentEligible.map((s) => s.sessionId));
        const existingFiles = await this.deps.fileStore.listSessionMemoryFiles(scopeKey);
        for (const fileSessionId of existingFiles) {
            if (!currentSessionIds.has(fileSessionId) &&
                !(await this.deps.repository.getSessionState(scopeKey, fileSessionId))) {
                await this.deps.fileStore.deleteSessionMemory(scopeKey, fileSessionId);
                await this.deps.fileStore.deleteSessionRules(scopeKey, fileSessionId);
            }
        }
    }
    async canReuseConsolidation(scope, inputDigest, baseline, contractId) {
        return (scope.consolidatedDigest === inputDigest &&
            matchesBaselineContract(baseline, contractId) &&
            (await this.verifyMinimalFiles(scope.scopeKey)));
    }
    /** 最低校验(§5.6)：两份产物存在且摘要首行为 v2；镜像不参与跳过判断。 */
    async verifyMinimalFiles(scopeKey) {
        const summary = await this.deps.fileStore.readMemorySummary(scopeKey);
        if (!summary)
            return false;
        if (summary.split('\n')[0]?.trim() !== 'v2')
            return false;
        const index = await this.deps.fileStore.readMemoryIndex(scopeKey);
        return Boolean(index?.trim());
    }
    now() {
        return (this.deps.nowMs ?? Date.now)();
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** 整理 Agent 的输入；续跑时附上续跑标志，模型从草稿接着做。 */
function consolidationInput(round, workDir, resumed, signal) {
    const { job, changes } = round;
    return {
        contractId: job.contract.contractId,
        workDir,
        mode: round.mode,
        changes: {
            addedSessionIds: changes.addedSessionIds,
            updatedSessionIds: changes.updatedSessionIds,
            removedSessionIds: changes.removedSessionIds,
            artifactsModified: changes.artifactsModified,
            addedNotePaths: changes.addedNotePaths,
            updatedNotePaths: changes.updatedNotePaths,
            removedNotePaths: changes.removedNotePaths,
            forgetRuleSourceIds: changes.forgetRuleSourceIds,
        },
        maxIndexBytes: job.config.maxMemoryMarkdownBytes,
        maxSummaryTokens: job.config.maxSummaryInjectionTokens,
        maxRequests: job.config.maxConsolidationAgentTurns,
        ...(resumed ? { resumed: true } : {}),
        signal,
    };
}
/** 续跑发布前 scope 的变化：Reset 或治理变更都让冻结的草稿作废。 */
function frozenScopeChange(round, scope) {
    if (!scope || scope.resetEpoch !== round.job.resetEpoch)
        return 'reset';
    return scope.governanceRevision === round.governanceRevision ? undefined : 'governance';
}
/** 成功冷却期内的常规刷新直接跳过（§5.6）；治理原因不受冷却约束。 */
function inSuccessCooldown(scope, config, nowMs) {
    return (scope.consolidatedDigest !== undefined &&
        scope.lastConsolidatedAtMs !== undefined &&
        nowMs - scope.lastConsolidatedAtMs < config.publicationCooldownMs);
}
//# sourceMappingURL=consolidation-service.js.map