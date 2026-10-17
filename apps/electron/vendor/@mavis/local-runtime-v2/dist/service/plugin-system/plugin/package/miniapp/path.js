export function isPathCoveredByRoots(relativePath, roots) {
    return roots.some((root) => relativePath === root || relativePath.startsWith(`${root}/`));
}
export function isMiniAppRuntimePayloadExcludedPath(relativePath) {
    return relativePath
        .split('/')
        .some((segment) => segment.toLocaleLowerCase('en-US') === MINIAPP_DEPENDENCY_DIRECTORY_NAME);
}
const MINIAPP_DEPENDENCY_DIRECTORY_NAME = 'node_modules';
//# sourceMappingURL=path.js.map