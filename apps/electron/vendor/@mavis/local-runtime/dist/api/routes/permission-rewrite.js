import { withPermissionExecutionPlan } from '@mavis/agent-tools/desktop';
/**
 * Apply a complete effective-input snapshot onto the live `toolContext.args`
 * object so the executor sees the decision-time safe form.
 *
 * The permission facade records a checker rewrite such as
 * `rm <path>` → `mavis-trash <path>` in `ExecutionPlan.effectiveInput`.
 * The pi-agent-core `beforeToolCallHook` contract has no explicit rewrite
 * channel — the runner just forwards the same `toolContext.args` reference to
 * the tool executor — so this helper mutates that object in place instead of
 * returning a new one. The complete plan is carried alongside the live args by
 * a non-enumerable symbol for execution-boundary consumers.
 */
export function applyPermissionExecutionPlan(toolContext, plan) {
    if (!plan)
        return;
    const effectiveInput = plan.effectiveInput;
    if (toolContext.args &&
        typeof toolContext.args === 'object' &&
        !Array.isArray(toolContext.args)) {
        const target = toolContext.args;
        if (target === effectiveInput) {
            Object.assign(toolContext, {
                args: withPermissionExecutionPlan({ ...effectiveInput }, plan),
            });
            return;
        }
        for (const key of Reflect.ownKeys(target)) {
            if (!Reflect.deleteProperty(target, key)) {
                throw new TypeError('Permission gate could not replace the execution input.');
            }
        }
        Object.assign(target, effectiveInput);
        withPermissionExecutionPlan(target, plan);
        return;
    }
    toolContext.args = withPermissionExecutionPlan({ ...effectiveInput }, plan);
}
//# sourceMappingURL=permission-rewrite.js.map