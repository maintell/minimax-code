function getNodeErrorCode(error) {
    if (!error || typeof error !== 'object')
        return undefined;
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}
/** Keep "not found" reserved for actual filesystem absence, not every realpath failure. */
export function classifyExistingPathError(error, target) {
    const code = getNodeErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
        return target === 'workspace'
            ? { status: 404, error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' }
            : { status: 404, error: 'File not found', code: 'NOT_FOUND' };
    }
    if (code === 'EACCES' || code === 'EPERM') {
        return { status: 403, error: 'Permission denied', code: 'FORBIDDEN' };
    }
    if (code === 'ELOOP' || code === 'EINVAL') {
        return { status: 400, error: 'Invalid path', code: 'INVALID_PATH' };
    }
    return {
        status: 500,
        error: target === 'workspace' ? 'Unable to inspect workspace' : 'Unable to inspect file',
        code: 'FILE_INFO_FAILED',
    };
}
//# sourceMappingURL=path-error.js.map