/**
 * Opaque handle for a source-registry-issued sanitized copy.
 *
 * The filesystem path deliberately lives in a WeakMap instead of the public
 * object.  A transform backend therefore cannot accidentally accept a
 * renderer/original path as if it were a sanitized input.  Only the source
 * registry creates these handles; the runtime resolves the path after the
 * handle's validator has approved the current generation.
 */

const INTERNAL_HANDLES = new WeakMap();
export function issueSanitizedSourceHandle(metadata, pathname, validate) {
    const handle = Object.freeze({ ...metadata });
    INTERNAL_HANDLES.set(handle, { path: pathname, validate });
    return handle;
}
export function isSanitizedSourceHandle(value) {
    return typeof value === 'object' && value !== null && INTERNAL_HANDLES.has(value);
}
/** Resolve only a source-registry-issued handle; forged structural objects fail closed. */
export function resolveSanitizedSourcePath(handle) {
    if (!isSanitizedSourceHandle(handle))
        return null;
    return INTERNAL_HANDLES.get(handle)?.path ?? null;
}
export async function validateSanitizedSourceHandle(handle) {
    if (!isSanitizedSourceHandle(handle))
        return false;
    try {
        return await (INTERNAL_HANDLES.get(handle)?.validate() ?? Promise.resolve(false));
    }
    catch {
        return false;
    }
}
