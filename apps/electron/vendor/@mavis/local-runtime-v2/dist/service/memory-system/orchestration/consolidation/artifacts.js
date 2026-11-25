import { redactMemorySecrets } from '../../secret-redactor.js';
import { isCompatibleLegacyArtifactContract } from '../../policies/artifact-contract.js';
import { MEMORY_SUMMARY_FILE } from '../../contracts.js';
import { exceedsSummaryBudget, formatArtifactSourceDates, isPublishedSummary, listArtifactSourceIds, pruneUnverifiedSummaryPreferences, removeEntriesBySource, summaryPreferenceLines, simpleLineDiff, } from '../artifact-edit.js';
import { noteFilePath, renderStateMirror } from '../memory-files.js';
/** changes.md 正文上限；超出截断逐行 diff、保留清单（§5.6）。 */
const MAX_CHANGES_BYTES = 256 * 1024;
const CONSOLIDATION_BASELINE_CONTRACT = '.consolidation-contract';
/** 基线伪文件：摘要中受手改保护的行，随每次发布延续（§5.6 规则 8）。 */
const SUMMARY_MANUAL_LINES = '.summary-manual-lines';
export const CONSOLIDATION_INPUT_CONTRACT = 'file-agent-v1';
/** 基线伪文件：本轮之外来源在上次发布时交给模型的遗忘规则，用来判断规则是否有变化。 */
function keptRulesBaselinePath(sessionId) {
    return `sessions/${sessionId}.rules.md`;
}
export function initialContentChanges(job, previous) {
    const notes = diffNotes(new Map(), job.notes);
    // INIT 的全量输入清单与真实产物修改是两件事，空基线不能证明用户手改。
    const artifacts = diffArtifacts(new Map(job.baseline.map((file) => [file.fileName, file.content])), previous);
    return {
        addedSessionIds: job.selected.map((row) => row.sessionId),
        updatedSessionIds: [],
        removedSessionIds: [],
        ...notes,
        ...artifacts,
        // INIT 把本轮之外来源的全部遗忘规则放进工作目录，不需要单独列出变化。
        forgetRuleSourceIds: [],
        diffs: [...notes.diffs, ...artifacts.diffs],
    };
}
/**
 * changes 合成(§5.6)：added 是本轮选集减去来源标注，removed 是来源标注减去准入集合，
 * updated 与产物权威修改用基线比较。预算外但仍在准入集合的会话不算退出；它们的遗忘规则
 * 相对上次发布记录有变化时也算变化，否则遗忘只改了会话文档、模型不会运行。
 * 内容层没有任何变化时返回 undefined，复用校验后的产物并推进本轮基线。
 */
export function computeContentChanges(baseline, previous, sources) {
    const before = new Map(baseline.map((f) => [f.fileName, f.content]));
    const sessions = sessionChanges(before, previous.indexMarkdown, sources);
    const rules = keptRuleChanges(before, previous.indexMarkdown, sources);
    const noteChanges = diffNotes(before, sources.notes);
    const artifacts = diffArtifacts(before, previous);
    const groups = [
        sessions.addedSessionIds,
        sessions.removedSessionIds,
        sessions.updatedSessionIds,
        rules.forgetRuleSourceIds,
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
        forgetRuleSourceIds: rules.forgetRuleSourceIds,
        diffs: [...sessions.diffs, ...rules.diffs, ...noteChanges.diffs, ...artifacts.diffs],
    };
}
/** 本轮之外来源的遗忘规则与上次发布记录的比较；没有记录也算变化。 */
function keptRuleChanges(before, index, sources) {
    const forgetRuleSourceIds = [];
    const diffs = [];
    for (const { sessionId, forgetRules } of keptSources(index, sources)) {
        if (forgetRules === undefined)
            continue;
        const old = before.get(keptRulesBaselinePath(sessionId));
        if (old === forgetRules)
            continue;
        forgetRuleSourceIds.push(sessionId);
        diffs.push(`## diff: ${sessionId}.rules.md\n${simpleLineDiff(old ?? '', forgetRules)}`);
    }
    return { forgetRuleSourceIds, diffs };
}
function sessionChanges(before, index, { selected, admitted }) {
    const selectionIds = new Set(selected.map((s) => s.sessionId));
    const admittedIds = new Set(admitted.map((s) => s.sessionId));
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
        removedSessionIds: [...annotatedIds].filter((id) => !admittedIds.has(id)).sort(),
        updatedSessionIds,
        diffs,
    };
}
/**
 * 当前 note 与上次发布基线里的 note 副本相比是否有新增、修改或删除。基线没有 note 副本时，
 * 当前的 note 都算新增。INIT 的 changes 把全部 note 列为 added，不能用来判断 note 是否变化。
 */
export function notesChangedSinceBaseline(baseline, notes) {
    const changes = diffNotes(new Map(baseline.map((file) => [file.fileName, file.content])), notes);
    return [changes.addedNotePaths, changes.updatedNotePaths, changes.removedNotePaths].some((paths) => paths.length > 0);
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
export function needsInitialBaseline(job, baseline, previous) {
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
export function matchesBaselineContract(baseline, artifactContractId) {
    const stored = baseline.find((file) => file.fileName === CONSOLIDATION_BASELINE_CONTRACT)?.content;
    const prefix = `${CONSOLIDATION_INPUT_CONTRACT}:`;
    if (!stored?.startsWith(prefix))
        return false;
    const storedContractId = stored.slice(prefix.length);
    return (storedContractId === artifactContractId ||
        isCompatibleLegacyArtifactContract(storedContractId, artifactContractId));
}
export function finalizeEditedArtifacts(files, job, protectedLines) {
    const byName = new Map(files.map((file) => [file.fileName, file.markdown]));
    return finalizeArtifacts(byName.get('MEMORY.md') ?? '', byName.get(MEMORY_SUMMARY_FILE) ?? '', job, protectedLines);
}
/**
 * 受手改保护的摘要「用户偏好」区行（§5.6 规则 8）：本轮相对基线新增的行（用户手改与治理直编
 * 同貌），加上历次发布延续下来、仍在该区的保护记录。没有基线摘要时无从证明新增手改。
 * 比较按发布口径（统一换行并脱敏）进行，Windows 上以 CRLF 保存的手改行同样受保护。
 * 保护集只豁免门禁删除并逐轮写进 changes.md；保留与否由整理模型按规则 8 结合遗忘规则判断。
 */
export function userEditedSummaryLines(baseline, summary) {
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
/**
 * 本轮之外的来源：旧索引里有条目、仍在准入集合内、但没进本轮 selected 的会话，按 ID 排序。
 * 它们的文档不进工作目录，已有条目由模型原样保留；带遗忘规则的，规则文件进工作目录，
 * 命中的内容照常移除。changes.md、INIT 核对与基线沿用共用这一判定。
 */
export function keptSources(indexMarkdown, { selected, admitted }) {
    const selectedIds = new Set(selected.map((state) => state.sessionId));
    const indexed = listArtifactSourceIds(indexMarkdown);
    return admitted
        .filter((state) => indexed.has(state.sessionId) && !selectedIds.has(state.sessionId))
        .sort((a, b) => Number(a.sessionId > b.sessionId) - Number(a.sessionId < b.sessionId));
}
/**
 * 工作目录初始文件：预处理后的产物副本、changes.md、added/updated 会话文档及规则，
 * 以及本轮之外来源的遗忘规则。
 */
export function buildConsolidationWorkdirFiles(previous, changes, { docs, notes, kept, }, protectedLines) {
    // 程序确定性预处理：removed 会话的条目在 agent 启动前删除(§5.6)。
    const preprocessed = removeEntriesBySource(previous.indexMarkdown, new Set(changes.removedSessionIds));
    const files = [
        { fileName: 'MEMORY.md', markdown: preprocessed.markdown },
        { fileName: MEMORY_SUMMARY_FILE, markdown: previous.summaryMarkdown },
        {
            fileName: 'changes.md',
            markdown: renderChangesMarkdown(changes, protectedLines, kept),
        },
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
    // 本轮之外的来源只给遗忘规则，不给文档：已有条目保留，但遗忘规则命中的内容不能留在产物里（规则 6）。
    for (const state of kept) {
        if (state.forgetRules === undefined)
            continue;
        files.push({ fileName: `${state.sessionId}.rules.md`, markdown: state.forgetRules });
    }
    files.push(...notes.map((note) => ({
        fileName: noteFilePath(note.sessionId),
        markdown: renderStateMirror(note),
    })));
    return files;
}
/**
 * 本轮发布的基线：两份产物、本轮会话文档与 note。准入集合内、本轮之外且条目仍在新索引里的会话
 * 沿用上一版基线的文档副本；否则它以后进入预算且内容变化时，既不算 added 也不算 updated。
 */
export function buildBaselineFiles(artifacts, { selected, admitted, notes, baseline, }, contractId) {
    const previous = new Map(baseline.map((file) => [file.fileName, file.content]));
    const kept = keptSources(artifacts.indexMarkdown, { selected, admitted });
    const carried = kept.flatMap((state) => {
        const fileName = `sessions/${state.sessionId}.md`;
        const content = previous.get(fileName);
        return content === undefined ? [] : [{ fileName, content }];
    });
    // 记录本轮交给模型的遗忘规则，规则之后再变化时才重新交给模型。
    const keptRules = kept.flatMap(({ sessionId, forgetRules }) => forgetRules === undefined
        ? []
        : [{ fileName: keptRulesBaselinePath(sessionId), content: forgetRules }]);
    return [
        { fileName: 'MEMORY.md', content: artifacts.indexMarkdown },
        { fileName: MEMORY_SUMMARY_FILE, content: artifacts.summaryMarkdown },
        ...selected.map((state) => ({
            fileName: `sessions/${state.sessionId}.md`,
            content: renderStateMirror(state),
        })),
        ...carried,
        ...keptRules,
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
function renderChangesMarkdown(input, protectedLines, kept) {
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
    // 预算外但仍在准入集合的会话不进本轮材料，已有条目由模型原样保留；遗忘规则命中的内容照常移除。
    lines.push('## 本轮之外的来源（已有条目保持原样）', ...kept.map(({ sessionId, forgetRules }) => {
        if (forgetRules === undefined)
            return `- ${sessionId}`;
        const updated = input.forgetRuleSourceIds.includes(sessionId) ? '有更新' : '';
        return `- ${sessionId}（遗忘规则${updated}：${sessionId}.rules.md）`;
    }), '');
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
export function finalizeArtifacts(rawIndex, rawSummary, { config, admitted, notes }, protectedLines) {
    // 日期取准入集合（含本轮选集）与 note 的采集时间：本轮之外来源的条目与程序补回的条目同样按采集记录渲染。
    const timestamps = new Map();
    for (const source of [...admitted, ...notes]) {
        if (source.capturedAtMs !== undefined)
            timestamps.set(source.sessionId, source.capturedAtMs);
    }
    const normalize = (raw) => redactMemorySecrets(formatArtifactSourceDates(raw.replace(/\r\n?/gu, '\n'), timestamps))
        .content;
    const indexMarkdown = normalize(rawIndex);
    const summaryMarkdown = pruneUnverifiedSummaryPreferences({
        summaryMarkdown: normalize(rawSummary),
        indexMarkdown,
        // 本轮之外来源的条目也保留在索引里，其摘要偏好行按准入集合的当前文档核对原话。
        sessionDocs: new Map(admitted.map((state) => [state.sessionId, renderStateMirror(state)])),
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
//# sourceMappingURL=artifacts.js.map