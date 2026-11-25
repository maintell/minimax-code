import { isAssignedByBunny, readSpaceContext, spaceContextExcerpt, spaceContextSection, } from '../session-system/index.js';
import { escapeAssignmentData, renderExecutionReminder, } from '../coordinator-text/index.js';
/**
 * The space part of the reminder: name, goal, conventions, the context.md excerpt without the
 * suggestions for the user and,
 * after it, the user's active global constraints from Bunny's ledger (13.8). A task whose
 * space was deleted has only the constraints.
 */
function spaceText(source, spaceId, workline, context) {
    const { isDefaultWorkspace, constraints } = context;
    const safe = escapeAssignmentData;
    if (!spaceId)
        return { constraints: constraints.map(safe) };
    const spaceDir = source.worklines.directory(spaceId);
    const summary = readSpaceContext(spaceDir).summary;
    const conventions = isDefaultWorkspace ? '' : spaceContextSection(summary, '约定');
    // 推进建议 is what the user might say to Bunny next, not a request the task should act on.
    const excerpt = summary ? spaceContextExcerpt(summary, undefined, ['推进建议']) : '';
    return {
        spaceName: safe(workline?.name ?? spaceId),
        ...(workline?.goal ? { overallGoal: safe(workline.goal) } : {}),
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
                    const spaceId = source.worklines.sessionSpace(context.sessionId);
                    const workline = spaceId === undefined
                        ? undefined
                        : (await source.worklines.list()).find((item) => item.id === spaceId);
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