import { prepareCaptureHistory, truncateToTokenBudget } from './capture-history.js';
/** 已结束的会话状态；`started` 之外都视为终态（Mavis 语义里 idle 即 finished）。 */
const TERMINAL_STATUSES = new Set(['idle', 'error', 'aborted', 'interrupted']);
export function createProductionSessionSystemPort(deps) {
    async function readSnapshot(sessionId, maxInputTokens) {
        const session = await deps.sessions.get(sessionId);
        if (!session)
            return { status: 'not-found' };
        let source;
        try {
            source = await deps.history.read(sessionId);
        }
        catch (error) {
            return isMissingHistory(error) ? { status: 'not-found' } : { status: 'invalid' };
        }
        const prepared = prepareCaptureHistory(source);
        if (prepared.status !== 'found')
            return prepared;
        return {
            status: 'found',
            snapshot: {
                sessionId,
                sessionCreatedAtMs: session.createdAtMs,
                sourceRevision: source.revision,
                sourceUpdatedAtMs: session.updatedAtMs,
                events: truncateToTokenBudget(prepared.events, maxInputTokens),
            },
        };
    }
    return {
        async getSessionContext(sessionId) {
            const session = await deps.sessions.get(sessionId);
            if (!session)
                return { status: 'not-found' };
            const projectId = await deps.projects.getSessionProjectId(sessionId);
            const project = projectId === undefined ? undefined : await deps.projects.getById(projectId);
            const agentName = session.agentName.trim();
            return {
                status: 'found',
                sessionId,
                // 身份缺失只影响标注，作用域恒为全局(§2.2)。
                canonicalAgentName: agentName.length > 0 ? agentName : undefined,
                projectName: projectDisplayName(project),
                workspaceDir: session.workspaceDir || undefined,
                createdAtMs: session.createdAtMs,
                updatedAtMs: session.updatedAtMs,
                rootConversation: isTopLevelConversation(session),
                ...(session.memoryPolicy ? { memoryPolicy: session.memoryPolicy } : {}),
            };
        },
        getSessionHistory(input) {
            return readSnapshot(input.sessionId, input.maxInputTokens);
        },
        async getCurrentRevision(sessionId) {
            try {
                const source = await deps.history.read(sessionId);
                return source.revision;
            }
            catch {
                return 'not-found';
            }
        },
        async listCaptureCandidates(input) {
            const page = await deps.sessions.listPage({
                order: 'oldest-updated',
                parentSessionId: null,
                archived: false,
                includeHidden: false,
                includeSessionKinds: ['conversation'],
                limit: input.limit,
                ...(input.cursor ? { cursor: input.cursor } : {}),
            });
            const now = deps.nowMs();
            const excluded = new Set(input.excludeSessionIds);
            const maxAgeMs = input.maxAgeDays * 86_400_000;
            const eligible = page.sessions.filter((session) => isTopLevelConversation(session) &&
                // 候选必须早于触发 Turn 的开始时刻，且不是触发会话自身(§2.3)。
                session.createdAtMs < input.createdBeforeMs &&
                !excluded.has(session.sessionId) &&
                // 年龄窗：updatedAtMs 超窗的会话退出候选资格(§2.3)。
                now - session.updatedAtMs <= maxAgeMs &&
                // 终态会话立即具备时间资格；运行中的会话要空闲达标(§5.10)。
                (TERMINAL_STATUSES.has(session.status) || now - session.updatedAtMs >= input.idleForMs));
            const candidates = [];
            for (const session of eligible) {
                // 只对通过元数据过滤的会话付出一次 History 读取,换取 sourceRevision。
                let source;
                try {
                    source = await deps.history.read(session.sessionId);
                }
                catch {
                    continue;
                }
                if (prepareCaptureHistory(source).status === 'ineligible')
                    continue;
                candidates.push({
                    sessionId: session.sessionId,
                    createdAtMs: session.createdAtMs,
                    updatedAtMs: session.updatedAtMs,
                    sourceRevision: source.revision,
                });
            }
            return {
                candidates,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            };
        },
    };
}
function isTopLevelConversation(session) {
    return (
    // root 仅兼容历史会话；新建用户规划使用 branch。
    (session.sessionType === 'branch' || session.sessionType === 'root') &&
        !session.parentSessionId &&
        session.sessionKind === 'conversation' &&
        session.visibility !== 'hidden' &&
        !session.archived &&
        !session.originCronId);
}
/** 项目标注名：workspace 项目取目录 basename；default 项目不标注（§2.2）。 */
function projectDisplayName(project) {
    if (!project || project.projectKind !== 'workspace' || !project.workspaceDir)
        return undefined;
    const normalized = project.workspaceDir.replace(/[\\/]+$/u, '');
    const base = normalized.split(/[\\/]/u).pop();
    return base && base.length > 0 ? base : undefined;
}
function isMissingHistory(error) {
    return error instanceof Error && /session not found|history.*not found/iu.test(error.message);
}
//# sourceMappingURL=session-source.production.js.map