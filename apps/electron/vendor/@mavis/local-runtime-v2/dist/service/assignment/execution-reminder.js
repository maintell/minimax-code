import { DEFAULT_SPACE_NAME, isAssignedByBunny, readSpaceContext, spaceContextExcerpt, spaceContextSection, } from '../session-system/index.js';
import { escapeAssignmentData, renderExecutionReminder, } from '../coordinator-text/index.js';
/**
 * The space part of the reminder: name, goal, conventions, the context.md excerpt and,
 * after it, the user's active global constraints from Bunny's ledger (13.8).
 */
function spaceText(source, spaceId, workline, context) {
    const { isDefaultWorkspace, constraints } = context;
    const safe = escapeAssignmentData;
    const spaceDir = source.worklines.directory(spaceId);
    const summary = spaceId === 'default' ? '' : readSpaceContext(spaceDir).summary;
    const conventions = spaceId !== 'default' && !isDefaultWorkspace ? spaceContextSection(summary, '约定') : '';
    const excerpt = summary ? spaceContextExcerpt(summary) : '';
    return {
        spaceName: safe(workline?.name ?? DEFAULT_SPACE_NAME),
        ...(spaceId !== 'default' && workline?.goal ? { overallGoal: safe(workline.goal) } : {}),
        ...(conventions ? { conventions: safe(conventions) } : {}),
        ...(excerpt ? { excerpt: safe(excerpt) } : {}),
        constraints: constraints.map(safe),
        spaceDir: safe(spaceDir),
    };
}
/**
 * Where the task's files go: a project task's execution directory, and whether it is a
 * worktree of its own; a project outside git has no worktree, so the task changes it in place.
 */
function workingDirectory(session) {
    if (!session?.workspaceDir || session.isDefaultWorkspace)
        return {};
    return {
        workingDirectory: {
            dir: escapeAssignmentData(session.workspaceDir),
            worktree: session.runLocation?.mode.includes('worktree') === true,
        },
    };
}
function taskCriteria(assignment) {
    const criteria = (assignment?.doneWhen ?? [])
        .map((item) => escapeAssignmentData(item.trim()))
        .filter(Boolean);
    return criteria.length ? { criteria } : {};
}
export function createAssignmentExecutionReminderExtension(source) {
    return {
        id: 'local-assignment-execution',
        init(pi) {
            pi.registerReminderProvider({
                name: 'assignment-execution',
                async compute(context) {
                    const session = await source.sessions.get(context.sessionId);
                    const assignment = session && (await source.tasks.get(context.sessionId));
                    if (!isAssignedByBunny(assignment))
                        return null;
                    const spaceId = source.worklines.sessionSpace(context.sessionId) ?? 'default';
                    const workline = (await source.worklines.list()).find((item) => item.id === spaceId);
                    return {
                        requestOnly: true,
                        content: renderExecutionReminder({
                            ...spaceText(source, spaceId, workline, {
                                isDefaultWorkspace: session?.isDefaultWorkspace,
                                constraints: source.globalConstraints?.() ?? [],
                            }),
                            ...taskCriteria(assignment),
                            ...workingDirectory(session),
                        }),
                    };
                },
            });
        },
    };
}
//# sourceMappingURL=execution-reminder.js.map