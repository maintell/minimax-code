import path from 'node:path';
import { modelAccessOrigin } from './contracts.js';
/** Never attach raw fs/import errors: they can contain private paths or module secrets. */
export class ModelAccessPackageError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'ModelAccessPackageError';
    }
}
export function failureState(error) {
    const errorCode = error instanceof ModelAccessPackageError ? error.code : 'activation_failed';
    return { status: errorCode === 'pending_restart' ? 'pending-restart' : 'failed', errorCode };
}
export function assertPackageOptions(options) {
    if (!path.isAbsolute(options.root) ||
        !options.profileId.trim() ||
        (options.executionMode !== undefined &&
            !['in-process', 'subprocess'].includes(options.executionMode)) ||
        [options.disposeTimeoutMs, options.activationTimeoutMs].some((timeout) => timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1))) {
        throw new ModelAccessPackageError('invalid_package');
    }
}
export function isUserTrust(trustSource) {
    return modelAccessOrigin(trustSource) !== 'official';
}
/** `@mavis/*` is the official namespace: a user or dev package may not claim it. */
export function assertPackageNamespace(name, trustSource) {
    if (isUserTrust(trustSource) && name.startsWith('@mavis/'))
        throw new ModelAccessPackageError('package_name_reserved');
}
//# sourceMappingURL=errors.js.map