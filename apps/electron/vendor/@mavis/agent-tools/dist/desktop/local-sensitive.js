import { realpath } from '../shared/physical-fs.js';
import { Minimatch } from 'minimatch';
import { LOCAL_SENSITIVE_GLOB_EXCLUDES } from '../shared/rg-sensitive.js';
/**
 * Compiled once: Workspace indexing checks every inventory path, and compiling
 * the globs per call made a 10k-file scan block the runtime for seconds.
 */
const SENSITIVE_PATH_MATCHERS = LOCAL_SENSITIVE_GLOB_EXCLUDES.map((exclude) => {
    const pattern = exclude.slice(1);
    return {
        perSegment: !pattern.includes('/'),
        matcher: new Minimatch(pattern, { dot: true, nocase: true }),
    };
});
export function sensitiveExcludeArgs() {
    return LOCAL_SENSITIVE_GLOB_EXCLUDES.map((pattern) => `--iglob=${pattern}`);
}
export function isSensitiveSearchPath(path) {
    const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
    const segments = normalized.split('/').filter(Boolean);
    return SENSITIVE_PATH_MATCHERS.some(({ perSegment, matcher }) => perSegment
        ? segments.some((segment) => matcher.match(segment))
        : matcher.match(normalized) ||
            matcher.match(`${normalized}/__mavis_sensitive_root_probe__`));
}
export async function isSensitiveSearchRoot(path) {
    if (isSensitiveSearchPath(path))
        return true;
    try {
        return isSensitiveSearchPath(await realpath(path));
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=local-sensitive.js.map