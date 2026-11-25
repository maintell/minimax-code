/**
 * In-process permission execution metadata. The carrier is deliberately a
 * non-enumerable symbol so it never enters the model-visible Bash schema or
 * serialized tool arguments.
 */
const LOCAL_PERMISSION_EXECUTION_PLAN = Symbol.for('@mavis/permission/execution-plan');
/** Same non-enumerable contract as the execution plan. */
const LOCAL_PERMISSION_WRITE_TARGET = Symbol.for('@mavis/permission/write-target');
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
export function withPermissionWriteTarget(input, target) {
    Object.defineProperty(input, LOCAL_PERMISSION_WRITE_TARGET, {
        value: target,
        enumerable: false,
        configurable: true,
        writable: false,
    });
    return input;
}
/**
 * Refuses a write when a symlink swap moved its target after the permission
 * decision. Inputs that never passed a decision carry no target and are not
 * checked here.
 */
export function assertPermissionWriteTargetUnchanged(input) {
    if (!input || typeof input !== 'object')
        return;
    const target = input[LOCAL_PERMISSION_WRITE_TARGET];
    if (!target || target.resolveCurrent() === target.canonicalPath)
        return;
    throw new Error('The real location of this path changed after the permission check, so nothing was written. ' +
        'Retry the call to have the new location checked.');
}
//# sourceMappingURL=permission-execution.js.map