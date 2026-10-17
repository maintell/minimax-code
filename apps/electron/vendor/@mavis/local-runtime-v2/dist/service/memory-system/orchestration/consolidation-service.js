import { createHash } from 'node:crypto';
import { countTokens as countO200kBaseTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { redactMemorySecrets } from '../secret-redactor.js';
import { formatArtifactSourceDates, listArtifactSourceIds, removeEntriesBySource, simpleLineDiff, } from './artifact-edit.js';
import { noteFilePath, renderStateMirror } from './memory-files.js';
// 分词规则变化后重新整理既有摘要，避免沿用旧规则的完成标记。
const SUMMARY_TOKENIZER_CONTRACT = 'gpt-tokenizer@3.4.0/o200k_base:ordinary-text';
/** changes.md 正文上限；超出截断逐行 diff、保留清单（§5.6）。 */
const MAX_CHANGES_BYTES = 256 * 1024;
const CONSOLIDATION_BASELINE_CONTRACT = '.consolidation-contract';
const CONSOLIDATION_INPUT_CONTRACT = 'file-agent-v1';
export class MemoryConsolidationService {
    deps;
    constructor(deps) {
        this.deps = deps;
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
        // 成功冷却：常规刷新且距上次成功不足冷却期时直接跳过，不读选集(§5.6)。
        const reason = options?.reason ?? 'routine';
        if (reason === 'routine' && inSuccessCooldown(scope, config, this.now())) {
            return { status: 'cooldown' };
        }
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
        // 选集输入全部来自 DB content，整理全程不读镜像文件(§5.6)。
        const { docs, selected } = buildSelectionInputs(selection, Math.min(config.maxConsolidationInputTokens, contract.maxInputTokens));
        if (selected.length + notes.length === 0)
            return { status: 'deferred', reason: 'size-limit-exceeded' };
        const inputDigest = computeInputDigest(scopeKey, scope.resetEpoch, [...selected, ...notes], {
            governanceRevision: scope.governanceRevision,
            contractId: contract.contractId,
            config,
        });
        const baseline = await this.deps.repository.listBaselineFiles(scopeKey);
        if (await this.canReuseConsolidation(scope, inputDigest, baseline, contract.contractId)) {
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
            notes,
        });
        if ('status' in artifacts)
            return artifacts;
        const { indexMarkdown, summaryMarkdown } = artifacts;
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
                contractId: contract.contractId,
                config,
            });
            if (currentInputDigest !== inputDigest) {
                return { status: 'stale-input' };
            }
            await this.deleteOrphanFiles(scopeKey, currentEligible);
            await this.deps.fileStore.writeMemoryIndex(scopeKey, indexMarkdown);
            await this.deps.fileStore.writeMemorySummary(scopeKey, summaryMarkdown);
            const rereadScope = await this.deps.repository.getScope(scopeKey);
            if (!rereadScope || rereadScope.resetEpoch !== scope.resetEpoch) {
                return { status: 'stale-input' };
            }
            // 基线快照与完成标记同事务整体替换(§5.6/§6.1)。
            const commitResult = await this.deps.repository.commitConsolidation({
                scopeKey,
                expectedResetEpoch: scope.resetEpoch,
                expectedSelection: [...currentEligible, ...currentNotes].map((s) => ({
                    sessionId: s.sessionId,
                    outputDigest: s.outputDigest,
                })),
                inputDigest,
                baselineFiles: buildBaselineFiles({ indexMarkdown, summaryMarkdown }, currentEligible, currentNotes, contract.contractId),
                consolidatedAtMs: this.now(),
            });
            if (commitResult === 'stale-input')
                return { status: 'stale-input' };
            return {
                status: 'published',
                inputDigest,
                sessionCount: currentEligible.length,
            };
        });
    }
    /** 按产物与基线选择工作模式，两种模式共用文件编辑与发布协议。 */
    async produceArtifacts(job) {
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
            : computeContentChanges(baseline, previousArtifacts, job.selected, job.notes);
        const mode = init ? 'INIT' : 'INCREMENTAL';
        if (!changes) {
            return (finalizeArtifacts(index, summary, job) ?? {
                status: 'deferred',
                reason: 'model-invalid-output',
            });
        }
        const workdirFiles = buildConsolidationWorkdirFiles(previousArtifacts, changes, job);
        return this.runConsolidationAgent(job, workdirFiles, changes, mode);
    }
    /** 编辑隔离副本；失败不发布，成功后由调用方校验并条件提交。 */
    async runConsolidationAgent(job, workdirFiles, changes, mode) {
        let workDir;
        try {
            workDir = await this.deps.fileStore.createConsolidationWorkdir(job.scopeKey, workdirFiles);
            const result = await this.deps.model.consolidateInPlace({
                contractId: job.contract.contractId,
                workDir,
                mode,
                changes: {
                    addedSessionIds: changes.addedSessionIds,
                    updatedSessionIds: changes.updatedSessionIds,
                    removedSessionIds: changes.removedSessionIds,
                    artifactsModified: changes.artifactsModified,
                    addedNotePaths: changes.addedNotePaths,
                    updatedNotePaths: changes.updatedNotePaths,
                    removedNotePaths: changes.removedNotePaths,
                },
                maxIndexBytes: job.config.maxMemoryMarkdownBytes,
                maxSummaryTokens: job.config.maxSummaryInjectionTokens,
                maxTurns: job.config.maxConsolidationAgentTurns,
                signal: AbortSignal.timeout(60 * 60 * 1000),
            });
            if (result.status !== 'ok')
                return {
                    status: 'deferred',
                    reason: result.status === 'failed' ? result.reason : 'model-unavailable',
                };
            const edited = await this.deps.fileStore.readConsolidationWorkdir(workDir);
            return (finalizeEditedArtifacts(edited, job) ?? {
                status: 'deferred',
                reason: 'model-invalid-output',
            });
        }
        catch {
            return { status: 'deferred', reason: 'store-unavailable' };
        }
        finally {
            if (workDir !== undefined) {
                try {
                    await this.deps.fileStore.deleteConsolidationWorkdir(workDir);
                }
                catch {
                    // 残留由 tmp 清理兜底。
                }
            }
        }
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
/** 成功冷却期内的常规刷新直接跳过（§5.6）；治理原因不受冷却约束。 */
function inSuccessCooldown(scope, config, nowMs) {
    return (scope.consolidatedDigest !== undefined &&
        scope.lastConsolidatedAtMs !== undefined &&
        nowMs - scope.lastConsolidatedAtMs < config.publicationCooldownMs);
}
function initialContentChanges(job, previous) {
    const notes = diffNotes(new Map(), job.notes);
    // INIT 的全量输入清单与真实产物修改是两件事，空基线不能证明用户手改。
    const artifacts = diffArtifacts(new Map(job.baseline.map((file) => [file.fileName, file.content])), previous);
    return {
        addedSessionIds: job.selected.map((row) => row.sessionId),
        updatedSessionIds: [],
        removedSessionIds: [],
        ...notes,
        ...artifacts,
        diffs: [...notes.diffs, ...artifacts.diffs],
    };
}
/**
 * changes 合成(§5.6)：added/removed 用来源标注与选集的集合差，updated 与产物权威修改
 * 用基线比较。内容层没有任何变化时返回 undefined，复用校验后的产物并推进本轮基线。
 */
function computeContentChanges(baseline, previous, selected, notes) {
    const before = new Map(baseline.map((f) => [f.fileName, f.content]));
    const sessions = sessionChanges(before, previous.indexMarkdown, selected);
    const noteChanges = diffNotes(before, notes);
    const artifacts = diffArtifacts(before, previous);
    const groups = [
        sessions.addedSessionIds,
        sessions.removedSessionIds,
        sessions.updatedSessionIds,
        noteChanges.addedNotePaths,
        noteChanges.updatedNotePaths,
        noteChanges.removedNotePaths,
    ];
    if (!groups.some((paths) => paths.length > 0) && !artifacts.artifactsModified)
        return undefined;
    return {
        ...sessions,
        ...noteChanges,
        ...artifacts,
        diffs: [...sessions.diffs, ...noteChanges.diffs, ...artifacts.diffs],
    };
}
function sessionChanges(before, index, selected) {
    const selectionIds = new Set(selected.map((s) => s.sessionId));
    const annotatedIds = new Set([...listArtifactSourceIds(index)].filter((id) => !id.startsWith('note-')));
    const updatedSessionIds = [];
    const diffs = [];
    for (const state of selected) {
        const old = before.get(`sessions/${state.sessionId}.md`);
        const current = renderStateMirror(state);
        if (old === undefined || old === current)
            continue;
        updatedSessionIds.push(state.sessionId);
        diffs.push(`## diff: ${state.sessionId}\n${simpleLineDiff(old, current)}`);
    }
    return {
        addedSessionIds: [...selectionIds].filter((id) => !annotatedIds.has(id)).sort(),
        removedSessionIds: [...annotatedIds].filter((id) => !selectionIds.has(id)).sort(),
        updatedSessionIds,
        diffs,
    };
}
function diffNotes(before, notes) {
    const paths = new Set(notes.map((note) => noteFilePath(note.sessionId)));
    const removedNotePaths = [...before.keys()].filter((path) => path.startsWith('extensions/ad_hoc/notes/') && !paths.has(path));
    const diffs = removedNotePaths.map((path) => `## diff: ${path}\n${simpleLineDiff(before.get(path) ?? '', '')}`);
    const addedNotePaths = [];
    const updatedNotePaths = [];
    for (const note of notes) {
        const path = noteFilePath(note.sessionId);
        const old = before.get(path);
        const current = renderStateMirror(note);
        if (old === current)
            continue;
        if (old === undefined)
            addedNotePaths.push(path);
        else
            updatedNotePaths.push(path);
        diffs.push(`## diff: ${path}\n${simpleLineDiff(old ?? '', current)}`);
    }
    return { addedNotePaths, updatedNotePaths, removedNotePaths, diffs };
}
function diffArtifacts(before, artifacts) {
    const current = new Map([
        ['MEMORY.md', artifacts.indexMarkdown],
        ['memory_summary.md', artifacts.summaryMarkdown],
    ]);
    let artifactsModified = false;
    const diffs = [];
    for (const [path, content] of current) {
        const old = before.get(path);
        if (old === undefined || old === content)
            continue;
        artifactsModified = true;
        diffs.push(`## diff: ${path}\n${simpleLineDiff(old, content)}`);
    }
    return { artifactsModified, diffs };
}
function needsInitialBaseline(job, baseline, previous) {
    if (job.consolidatedDigest === undefined ||
        !previous.previousIndex?.trim() ||
        previous.previousSummary?.split('\n')[0]?.trim() !== 'v2')
        return true;
    if (!baseline.length)
        return true;
    return !matchesBaselineContract(baseline, job.contract.contractId);
}
function matchesBaselineContract(baseline, contractId) {
    return baseline.some((file) => file.fileName === CONSOLIDATION_BASELINE_CONTRACT &&
        file.content === `${CONSOLIDATION_INPUT_CONTRACT}:${contractId}`);
}
function finalizeEditedArtifacts(files, job) {
    const byName = new Map(files.map((file) => [file.fileName, file.markdown]));
    return finalizeArtifacts(byName.get('MEMORY.md') ?? '', byName.get('memory_summary.md') ?? '', job);
}
/** 工作目录初始文件：预处理后的产物副本、changes.md 与 added/updated 会话文档及规则。 */
function buildConsolidationWorkdirFiles(previous, changes, { docs, notes }) {
    // 程序确定性预处理：removed 会话的条目在 agent 启动前删除(§5.6)。
    const preprocessed = removeEntriesBySource(previous.indexMarkdown, new Set(changes.removedSessionIds));
    const files = [
        { fileName: 'MEMORY.md', markdown: preprocessed.markdown },
        { fileName: 'memory_summary.md', markdown: previous.summaryMarkdown },
        { fileName: 'changes.md', markdown: renderChangesMarkdown(changes) },
    ];
    const involved = new Set([...changes.addedSessionIds, ...changes.updatedSessionIds]);
    for (const doc of docs) {
        if (!involved.has(doc.sessionId))
            continue;
        files.push({ fileName: `${doc.sessionId}.md`, markdown: doc.markdown });
        if (doc.forgetRules !== undefined) {
            files.push({ fileName: `${doc.sessionId}.rules.md`, markdown: doc.forgetRules });
        }
    }
    files.push(...notes.map((note) => ({
        fileName: noteFilePath(note.sessionId),
        markdown: renderStateMirror(note),
    })));
    return files;
}
function buildSelectionInputs(selection, maxTokens) {
    const docs = [];
    const selected = [];
    let inputTokens = 0;
    for (const state of selection) {
        if (!state.content)
            continue;
        const markdown = renderStateMirror(state);
        // 与 contractId 绑定的固定估算口径(§5.6)。
        const tokens = Math.ceil(Buffer.byteLength(markdown, 'utf8') / 4);
        if (inputTokens + tokens > maxTokens)
            break;
        inputTokens += tokens;
        selected.push(state);
        docs.push({ sessionId: state.sessionId, markdown, forgetRules: state.forgetRules });
    }
    return { docs, selected };
}
function buildBaselineFiles(artifacts, selection, notes, contractId) {
    return [
        { fileName: 'MEMORY.md', content: artifacts.indexMarkdown },
        { fileName: 'memory_summary.md', content: artifacts.summaryMarkdown },
        ...selection.map((state) => ({
            fileName: `sessions/${state.sessionId}.md`,
            content: renderStateMirror(state),
        })),
        ...notes.map((state) => ({
            fileName: noteFilePath(state.sessionId),
            content: renderStateMirror(state),
        })),
        {
            fileName: CONSOLIDATION_BASELINE_CONTRACT,
            content: `${CONSOLIDATION_INPUT_CONTRACT}:${contractId}`,
        },
    ];
}
function renderChangesMarkdown(input) {
    const lines = ['# 变更清单', ''];
    const groups = [
        ['added', input.addedSessionIds.map((id) => `${id}.md`)],
        ['updated', input.updatedSessionIds.map((id) => `${id}.md`)],
        ['removed（普通会话条目已移除）', input.removedSessionIds.map((id) => `${id}.md`)],
        ['note added', input.addedNotePaths],
        ['note updated', input.updatedNotePaths],
        ['note removed', input.removedNotePaths],
    ];
    for (const [name, paths] of groups)
        lines.push(`## ${name}`, ...paths.map((path) => `- ${path}`), '');
    lines.push(`产物存在外部修改：${input.artifactsModified ? '是' : '否'}`, '');
    let remaining = MAX_CHANGES_BYTES;
    let diffBody = '';
    for (const diff of input.diffs) {
        const bytes = Buffer.from(`${diff}\n`, 'utf8');
        if (bytes.length <= remaining) {
            diffBody += `${diff}\n`;
            remaining -= bytes.length;
            continue;
        }
        let end = remaining;
        while (end > 0 && (bytes[end] & 0xc0) === 0x80)
            end--;
        diffBody += bytes.subarray(0, end).toString('utf8');
        lines.push('[diff truncated; read changed files by path]', '');
        break;
    }
    return lines.join('\n') + diffBody;
}
function finalizeArtifacts(rawIndex, rawSummary, { config, selected, notes }) {
    const timestamps = new Map();
    for (const source of [...selected, ...notes]) {
        if (source.capturedAtMs !== undefined)
            timestamps.set(source.sessionId, source.capturedAtMs);
    }
    const normalize = (raw) => redactMemorySecrets(formatArtifactSourceDates(raw.replace(/\r\n?/gu, '\n'), timestamps))
        .content;
    const indexMarkdown = normalize(rawIndex);
    const summaryMarkdown = normalize(rawSummary);
    if (indexMarkdown.trim().length === 0)
        return undefined;
    if (summaryMarkdown.split('\n')[0]?.trim() !== 'v2')
        return undefined;
    if (Buffer.byteLength(indexMarkdown, 'utf8') > config.maxMemoryMarkdownBytes)
        return undefined;
    if (countO200kBaseTokens(summaryMarkdown, { disallowedSpecial: new Set() }) >
        config.maxSummaryInjectionTokens) {
        return undefined;
    }
    return { indexMarkdown, summaryMarkdown };
}
function computeInputDigest(scopeKey, resetEpoch, selection, options) {
    const hash = createHash('sha256');
    const config = options?.config;
    hash.update(JSON.stringify([
        options?.contractId ?? 'empty',
        options?.governanceRevision ?? 0,
        SUMMARY_TOKENIZER_CONTRACT,
        CONSOLIDATION_INPUT_CONTRACT,
        config?.maxSelectedSessions,
        config?.maxConsolidationInputTokens,
        config?.maxMemoryMarkdownBytes,
        config?.maxSummaryInjectionTokens,
    ]));
    hash.update(scopeKey);
    hash.update(`\0${resetEpoch}\0`);
    for (const s of selection) {
        hash.update(JSON.stringify([s.sessionId, s.outputDigest, s.forgetRules ?? null]));
    }
    return hash.digest('base64url');
}
//# sourceMappingURL=consolidation-service.js.map