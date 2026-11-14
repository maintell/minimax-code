import { realpathSync } from 'node:fs';
import path from 'node:path';
/**
 * Resolves the deepest existing ancestor, so a link to a protected directory is
 * followed even when the target itself does not exist yet.
 */
export function canonicalPath(target) {
    try {
        return realpathSync.native(target);
    }
    catch {
        const parent = path.dirname(target);
        return parent === target ? target : path.join(canonicalPath(parent), path.basename(target));
    }
}
export function isInside(root, target) {
    // `path.relative` compares Windows paths case-insensitively.
    const relative = path.relative(root, target);
    return (relative === '' ||
        (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)));
}
//# sourceMappingURL=canonical-paths.js.map