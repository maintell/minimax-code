/**
 * Recoverable Windows delete metadata carried in-process from the permission
 * checker to the local Bash implementation. Only literal trash targets cross
 * this seam; the runtime owns the launcher, script path and environment.
 */
const WINDOWS_TRASH_EXECUTION = Symbol.for('@mavis/permission/windows-trash-execution');
export function withWindowsTrashExecution(input, targets) {
    if (targets.length === 0 || !targets.every((target) => typeof target === 'string' && target)) {
        throw new TypeError('Windows trash execution requires at least one literal target.');
    }
    const effectiveInput = { ...input };
    Object.defineProperty(effectiveInput, WINDOWS_TRASH_EXECUTION, {
        value: Object.freeze({ targets: Object.freeze([...targets]) }),
        enumerable: true,
        configurable: false,
        writable: false,
    });
    return effectiveInput;
}
export function readWindowsTrashExecution(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return undefined;
    const value = input[WINDOWS_TRASH_EXECUTION];
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    if (!Array.isArray(value.targets) ||
        value.targets.length === 0 ||
        !value.targets.every((target) => typeof target === 'string' && target)) {
        return undefined;
    }
    return value;
}
//# sourceMappingURL=windows-trash-execution.js.map