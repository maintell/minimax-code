import path from 'node:path';
/** Resolve and compare one filesystem identity with the host platform's case rules. */
export function isSameResolvedPath(left, right, platform = process.platform) {
    const pathApi = platform === 'win32' ? path.win32 : path;
    const resolvedLeft = pathApi.resolve(left);
    const resolvedRight = pathApi.resolve(right);
    return platform === 'win32'
        ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
        : resolvedLeft === resolvedRight;
}
//# sourceMappingURL=path-identity.js.map