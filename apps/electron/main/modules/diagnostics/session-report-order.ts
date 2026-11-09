import * as fs from "fs";
const SESSION_REPORT_COLLECTION_NAME = 'session-report-collection.json';
/** 压缩前的历史段：`snapshots/g<代号>--*.jsonl`。 */
const HISTORY_SEGMENT_PATTERN = /^snapshots\/g[^/]*\.jsonl$/u;
const TOOL_OUTPUT_PREFIX = 'reports/';
/** 会话报告在包里的目录前缀，与 SessionReportService 的 archiveSessionPrefix 保持一致。 */
export function sessionReportArchivePrefix(sessionId) {
    return `session/${encodeURIComponent(sessionId)}/`;
}
function isHistoryOrToolOutput(relativeName) {
    return HISTORY_SEGMENT_PATTERN.test(relativeName) || relativeName.startsWith(TOOL_OUTPUT_PREFIX);
}
async function modifiedAtMs(artifact) {
    if (!artifact.path)
        return 0;
    try {
        return (await fs.promises.stat(artifact.path)).mtimeMs;
    }
    catch {
        return 0;
    }
}
/** 历史段和工具输出按修改时间新的在前，装不下时先丢旧的。 */
async function newestFirst(artifacts) {
    const withTime = await Promise.all(artifacts.map(async (artifact) => ({ artifact, mtimeMs: await modifiedAtMs(artifact) })));
    return withTime
        .sort((left, right) => right.mtimeMs - left.mtimeMs || left.artifact.name.localeCompare(right.artifact.name))
        .map(({ artifact }) => artifact);
}
/**
 * 按装包优先级重排会话报告。根会话不在报告里（目录丢失等）时照常返回，只是第一档没有根会话文件；
 * 子会话按 sessionIds 的层级顺序排，每个子会话先核心文件、再历史段和工具输出。
 */
export async function orderSessionReportArtifacts(report) {
    const sessionOrder = [
        ...new Set([report.rootSessionId, ...report.sessionIds].filter((id) => id.length > 0)),
    ];
    const groups = new Map(sessionOrder.map((sessionId) => [sessionId, { core: [], bulky: [] }]));
    const prefixes = sessionOrder.map((sessionId) => ({
        sessionId,
        prefix: sessionReportArchivePrefix(sessionId),
    }));
    const collection = [];
    const unassigned = [];
    for (const artifact of report.artifacts) {
        if (artifact.name === SESSION_REPORT_COLLECTION_NAME) {
            collection.push(artifact);
            continue;
        }
        // encodeURIComponent 会转义 `/`，带结尾斜杠的前缀不会误配到别的会话。
        const owner = prefixes.find(({ prefix }) => artifact.name.startsWith(prefix));
        const group = owner ? groups.get(owner.sessionId) : undefined;
        if (!owner || !group) {
            unassigned.push(artifact);
            continue;
        }
        const relativeName = artifact.name.slice(owner.prefix.length);
        (isHistoryOrToolOutput(relativeName) ? group.bulky : group.core).push(artifact);
    }
    const root = groups.get(report.rootSessionId);
    const deferred = root ? await newestFirst(root.bulky) : [];
    for (const sessionId of sessionOrder) {
        if (sessionId === report.rootSessionId)
            continue;
        const group = groups.get(sessionId);
        if (!group)
            continue;
        deferred.push(...group.core, ...(await newestFirst(group.bulky)));
    }
    deferred.push(...unassigned);
    return {
        required: [...(root?.core ?? []), ...collection],
        deferred,
    };
}
