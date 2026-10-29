/**
 * In-process permission execution metadata. The carrier is deliberately a
 * non-enumerable symbol so it never enters the model-visible Bash schema or
 * serialized tool arguments.
 */
const LOCAL_PERMISSION_EXECUTION_PLAN = Symbol.for('@mavis/permission/execution-plan');
export function resolvePermissionBashEnvPolicy(source, plan) {
    return typeof source === 'function' ? source(plan) : source;
}
export function withPermissionExecutionPlan(input, plan) {
    Object.defineProperty(input, LOCAL_PERMISSION_EXECUTION_PLAN, {
        value: plan,
        enumerable: false,
        configurable: true,
        writable: false,
    });
    return input;
}
export function copyWithPermissionExecutionPlan(input, plan) {
    return withPermissionExecutionPlan({ ...input }, plan);
}
export function readPermissionExecutionPlan(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return undefined;
    const value = input[LOCAL_PERMISSION_EXECUTION_PLAN];
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    return value;
}
//# sourceMappingURL=permission-execution.js.map