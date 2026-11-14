import { createHash } from 'node:crypto';
import { countTokens as countO200kBaseTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { redactMemorySecrets } from '../secret-redactor.js';
import { isCompatibleLegacyArtifactContract } from '../policies/artifact-contract.js';
import { MEMORY_SUMMARY_FILE } from '../contracts.js';
import { exceedsSummaryBudget, formatArtifactSourceDates, isPublishedSummary, listArtifactSourceIds, pruneUnverifiedSummaryPreferences, removeEntriesBySource, summaryPreferenceLines, simpleLineDiff, } from './artifact-edit.js';
import { noteFilePath, renderStateMirror } from './memory-files.js';
// 分词规则变化后重新整理既有摘要，避免沿用旧规则的完成标记。
const SUMMARY_TOKENIZER_CONTRACT = 'gpt-tokenizer@3.4.0/o200k_base:ordinary-text';
/** changes.md 正文上限；超出截断逐行 diff、保留清单（§5.6）。 */
const MAX_CHANGES_BYTES = 256 * 1024;
const CONSOLIDATION_BASELINE_CONTRACT = '.consolidation-contract';
/** 基线伪文件：摘要中受手改保护的行，随每次发布延续（§5.6 规则 8）。 */
const SUMMARY_MANUAL_LINES = '.summary-manual-lines';
const CONSOLIDATION_INPUT_CONTRACT = 'file-agent-v1';
/**
 * 整理模型窗口下限。整理 agent 要把整份选集、已有产物与 changes.md 一起读进上下文再逐文件
 * 编辑，窗口不足时模型会在写完产物前耗尽预算，产出半份结果。窗口取模型登记值
 * （`resolveModel` 返回的 `contextWindow`），不用输入预算加输出上限反推——后者会高估。
 * 空选集清理不需要模型，先于本门槛执行。
 */
export const MIN_CONSOLIDATION_CONTEXT_WINDOW = 250_000;
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
            notes,
        });
        if ('status' in artifacts)
            return artifacts;
        const { indexMarkdown, summaryMarkdown, manualSummaryLines } = artifacts;
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
            });
            if (currentInputDigest !== inputDigest) {
                return { status: 'stale-input' };
            }
            await this.deleteOrphanFiles(scopeKey, currentEligible);
            const prior = await this.readPublishedArtifacts(scopeKey);
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
                baselineFiles: buildBaselineFiles({ indexMarkdown, summaryMarkdown, manualSummaryLines }, currentEligible, currentNotes, contract.artifactContractId),
                consolidatedAtMs: this.now(),
            });
            if (commitResult === 'stale-input') {
                // 产物已写盘而基线未提交：回滚到与旧基线一致的内容，避免本轮模型写的摘要行在下一轮被当成手改。
                await this.restoreArtifacts(scopeKey, prior);
                return { status: 'stale-input' };
            }
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
        const protectedLines = userEditedSummaryLines(baseline, summary);
        if (!changes) {
            return (finalizeArtifacts(index, summary, job, protectedLines) ?? {
                status: 'deferred',
                reason: 'model-invalid-output',
            });
        }
        const files = buildConsolidationWorkdirFiles(previousArtifacts, changes, job, protectedLines);
        return this.runConsolidationAgent(job, { files, changes, mode, protectedLines });
    }
    /** 编辑隔离副本；失败不发布，成功后由调用方校验并条件提交。 */
    async runConsolidationAgent(job, { files, changes, mode, protectedLines }) {
        let workDir;
        try {
            workDir = await this.deps.fileStore.createConsolidationWorkdir(job.scopeKey, files);
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
            return (finalizeEditedArtifacts(edited, job, protectedLines) ?? {
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
    async readPublishedArtifacts(scopeKey) {
        return {
            index: await this.deps.fileStore.readMemoryIndex(scopeKey),
            summary: await this.deps.fileStore.readMemorySummary(scopeKey),
        };
    }
    async restoreArtifacts(scopeKey, prior) {
        if (prior.index !== undefined)
            await this.deps.fileStore.writeMemoryIndex(scopeKey, prior.index);
        if (prior.summary !== undefined) {
            await this.deps.fileStore.writeMemorySummary(scopeKey, prior.summary);
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
        [MEMORY_SUMMARY_FILE, artifacts.summaryMarkdown],
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
        previous.previousSummary?.split('\n')[0]?.trim() !== 'v2' ||
        Buffer.byteLength(previous.previousIndex, 'utf8') > job.config.maxMemoryMarkdownBytes ||
        exceedsSummaryBudget(previous.previousSummary, job.config.maxSummaryInjectionTokens))
        return true;
    if (!baseline.length)
        return true;
    return !matchesBaselineContract(baseline, job.contract.artifactContractId);
}
function matchesBaselineContract(baseline, artifactContractId) {
    const stored = baseline.find((file) => file.fileName === CONSOLIDATION_BASELINE_CONTRACT)?.content;
    const prefix = `${CONSOLIDATION_INPUT_CONTRACT}:`;
    if (!stored?.startsWith(prefix))
        return false;
    const storedContractId = stored.slice(prefix.length);
    return (storedContractId === artifactContractId ||
        isCompatibleLegacyArtifactContract(storedContractId, artifactContractId));
}
function finalizeEditedArtifacts(files, job, protectedLines) {
    const byName = new Map(files.map((file) => [file.fileName, file.markdown]));
    return finalizeArtifacts(byName.get('MEMORY.md') ?? '', byName.get(MEMORY_SUMMARY_FILE) ?? '', job, protectedLines);
}
/**
 * 受手改保护的摘要「用户偏好」区行（§5.6 规则 8）：本轮相对基线新增的行（用户手改与治理直编
 * 同貌），加上历次发布延续下来、仍在该区的保护记录。没有基线摘要时无从证明新增手改。
 * 比较按发布口径（统一换行并脱敏）进行，Windows 上以 CRLF 保存的手改行同样受保护。
 * 保护集只豁免门禁删除并逐轮写进 changes.md；保留与否由整理模型按规则 8 结合遗忘规则判断。
 */
function userEditedSummaryLines(baseline, summary) {
    const byName = new Map(baseline.map((file) => [file.fileName, file.content]));
    const base = byName.get(MEMORY_SUMMARY_FILE);
    const recorded = new Set(publishedForm(byName.get(SUMMARY_MANUAL_LINES) ?? '').split('\n'));
    const baseLines = new Set(base === undefined ? [] : publishedForm(base).split('\n'));
    return new Set(summaryPreferenceLines(publishedForm(summary)).filter((line) => line.trim() && (recorded.has(line) || (base !== undefined && !baseLines.has(line)))));
}
/** 与发布前同一口径：统一换行并脱敏，保护集与发布结果逐字可比，密钥不会经保护记录回流。 */
function publishedForm(markdown) {
    return redactMemorySecrets(markdown.replace(/\r\n?/gu, '\n')).content;
}
/** 工作目录初始文件：预处理后的产物副本、changes.md 与 added/updated 会话文档及规则。 */
function buildConsolidationWorkdirFiles(previous, changes, { docs, notes }, protectedLines) {
    // 程序确定性预处理：removed 会话的条目在 agent 启动前删除(§5.6)。
    const preprocessed = removeEntriesBySource(previous.indexMarkdown, new Set(changes.removedSessionIds));
    const files = [
        { fileName: 'MEMORY.md', markdown: preprocessed.markdown },
        { fileName: MEMORY_SUMMARY_FILE, markdown: previous.summaryMarkdown },
        { fileName: 'changes.md', markdown: renderChangesMarkdown(changes, protectedLines) },
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
        { fileName: MEMORY_SUMMARY_FILE, content: artifacts.summaryMarkdown },
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
        ...(artifacts.manualSummaryLines.length > 0
            ? [{ fileName: SUMMARY_MANUAL_LINES, content: artifacts.manualSummaryLines.join('\n') }]
            : []),
    ];
}
function renderChangesMarkdown(input, protectedLines) {
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
    // 手改行一旦进入基线就不再出现在 diff 中；逐轮列出，由能看到遗忘规则的整理模型负责保留（规则 8）。
    lines.push('## 受保护的摘要手改行', ...[...protectedLines].map((line) => `    ${line}`), '');
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
function finalizeArtifacts(rawIndex, rawSummary, { config, selected, notes, docs }, protectedLines) {
    const timestamps = new Map();
    for (const source of [...selected, ...notes]) {
        if (source.capturedAtMs !== undefined)
            timestamps.set(source.sessionId, source.capturedAtMs);
    }
    const normalize = (raw) => redactMemorySecrets(formatArtifactSourceDates(raw.replace(/\r\n?/gu, '\n'), timestamps))
        .content;
    const indexMarkdown = normalize(rawIndex);
    const summaryMarkdown = pruneUnverifiedSummaryPreferences({
        summaryMarkdown: normalize(rawSummary),
        indexMarkdown,
        sessionDocs: new Map(docs.map((doc) => [doc.sessionId, doc.markdown])),
        noteDocs: new Map(notes.map((note) => [note.sessionId, renderStateMirror(note)])),
        protectedLines,
    }).markdown;
    if (indexMarkdown.trim().length === 0)
        return undefined;
    if (!isPublishedSummary(summaryMarkdown))
        return undefined;
    if (Buffer.byteLength(indexMarkdown, 'utf8') > config.maxMemoryMarkdownBytes)
        return undefined;
    if (exceedsSummaryBudget(summaryMarkdown, config.maxSummaryInjectionTokens))
        return undefined;
    const published = new Set(summaryPreferenceLines(summaryMarkdown));
    const manualSummaryLines = [...protectedLines].filter((line) => published.has(line));
    return { indexMarkdown, summaryMarkdown, manualSummaryLines };
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