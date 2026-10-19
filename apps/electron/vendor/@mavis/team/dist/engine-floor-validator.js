export class FloorValidationError extends Error {
    violations;
    constructor(violations) {
        const summary = violations.map((v) => `  - ${v.task_id} [${v.rule}]: ${v.message}`).join('\n');
        super(`Plan rejected by structural floor validator:\n${summary}\n\n` +
            `These tasks cannot skip verification because the dependency graph or ` +
            `missing user reason prevents a knowing skip. Either provide ` +
            `\`verified_by\`, write a \`verify_skip_reason\`, or remove the dependency edge.`);
        this.name = 'FloorValidationError';
        this.violations = violations;
    }
}
export function validatePlanFloor(tasks) {
    const violations = collectFloorViolations(tasks);
    if (violations.length > 0)
        throw new FloorValidationError(violations);
}
export function isVerifySkippedTaskAutoContinuable(result) {
    return (result.verifier_results.length === 0 &&
        result.verdict_summary?.startsWith('Skipped (verify off') === true);
}
export function collectFloorViolations(tasks) {
    const violations = [];
    const taskIds = new Set(tasks.map((t) => t.id));
    const referencedBy = new Map();
    for (const task of tasks) {
        for (const dep of task.depends_on) {
            if (!taskIds.has(dep))
                continue;
            const list = referencedBy.get(dep) ?? [];
            list.push(task.id);
            referencedBy.set(dep, list);
        }
    }
    for (const task of tasks) {
        const dependers = referencedBy.get(task.id) ?? [];
        const skipped = task.verified_by === undefined;
        const role = task.role ?? 'produce';
        const hasReason = !!task.verify_skip_reason && task.verify_skip_reason.length > 0;
        if (!skipped)
            continue;
        if (dependers.length > 0 && !hasReason) {
            violations.push({
                task_id: task.id,
                rule: role === 'verify-as-task'
                    ? 'verify_as_task_referenced_skip'
                    : 'depends_on_referenced_skip',
                message: role === 'verify-as-task'
                    ? `Task is role='verify-as-task' but other tasks depend on it (${dependers.join(', ')}). Verification reports consumed by downstream work must themselves be verified.`
                    : `Task is referenced by depends_on of: ${dependers.join(', ')}. Skipping verification here lets a defect propagate downstream undetected.`,
            });
            continue;
        }
        if (role === 'verify-as-task')
            continue;
        if (!hasReason) {
            violations.push({
                task_id: task.id,
                rule: 'plan_exit_skip_missing_reason',
                message: `Task is a plan-exit produce task with verified_by omitted, but verify_skip_reason is missing. ` +
                    `Plan-exit deliverables go directly to the user — write a one-line reason recording why skipping verification is acceptable here, OR set verified_by.`,
            });
        }
    }
    for (const task of tasks) {
        if ((task.role ?? 'produce') !== 'produce')
            continue;
        if (task.verified_by !== undefined)
            continue;
        if (task.verify_skip_reason && task.verify_skip_reason.length > 0)
            continue;
        if (violations.some((v) => v.task_id === task.id))
            continue;
        violations.push({
            task_id: task.id,
            rule: 'produce_skip_missing_reason',
            message: `Task has role='produce' and verified_by is omitted, but verify_skip_reason is missing. ` +
                `User must own the skip decision — write a one-line reason into the plan.yaml or remove the verified_by omission.`,
        });
    }
    return violations;
}
//# sourceMappingURL=engine-floor-validator.js.map