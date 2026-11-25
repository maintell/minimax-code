// Runs inside the packaged QuickJS Worker; see ./errors.ts for the import rule.
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { PtcScriptLoadError, allowedDirectories, ptcScriptError, withDirectories, } from './errors.js';
/** The file the skill registry requires before it accepts a skill directory. */
const SKILL_FILE = 'SKILL.md';
/**
 * Every directory a realpath may sit in: the roots themselves, plus what a
 * skill root reaches through a symlinked direct child. The skill registry
 * allows a skill root's direct children to be directory symlinks pointing
 * outside the root (`skill/registry/roots.ts`,
 * `allowDirectorySymlinksOutsideRoot`), so a script installed that way has to
 * be importable here too. Only direct children are followed, and only when the
 * registry would have accepted the link: its target must hold its own regular
 * `SKILL.md`. Without that a link to any directory (`/`, a home directory)
 * would make the whole tree importable. Anything deeper still has to resolve
 * inside one of these directories.
 */
function allowedRealDirectories(roots) {
    return [
        ...allowedDirectories(roots).map(realDirectory),
        ...roots.skills.flatMap(skillSymlinkTargets),
    ];
}
function skillSymlinkTargets(root) {
    let names;
    try {
        names = readdirSync(root);
    }
    catch {
        return [];
    }
    return names.flatMap((name) => {
        const path = join(root, name);
        try {
            if (!lstatSync(path).isSymbolicLink())
                return [];
            const target = realpathSync(path);
            // `lstat` so a SKILL.md that is itself a link does not count, exactly as
            // the registry's `skill_symlink_rejected` rule.
            if (!lstatSync(join(target, SKILL_FILE)).isFile())
                return [];
            return [target];
        }
        catch {
            return [];
        }
    });
}
/**
 * The realpath of a script that is inside an allowed directory. Resolving
 * first is what stops `../` and a symlink out of the workspace.
 */
export function realPathOf(absolutePath, roots) {
    let realPath;
    try {
        realPath = realpathSync(absolutePath);
    }
    catch {
        throw new PtcScriptLoadError('not_found', withDirectories(`run_code script was not found: ${absolutePath}`, roots));
    }
    if (!allowedRealDirectories(roots).some((directory) => isWithin(directory, realPath))) {
        throw ptcScriptError(`run_code script is outside the allowed directories: ${absolutePath}`, roots);
    }
    return realPath;
}
/**
 * The same directory after following symlinks. A root that does not exist yet
 * has no realpath, and nothing inside it can be loaded either.
 */
function realDirectory(directory) {
    try {
        return realpathSync(directory);
    }
    catch {
        return resolve(directory);
    }
}
export function scopeOf(realPath, roots) {
    if (roots.project && isWithin(realDirectory(roots.project), realPath))
        return 'project';
    if (isWithin(realDirectory(roots.user), realPath))
        return 'user';
    return 'skill';
}
function isWithin(directory, candidate) {
    const root = directory.endsWith(sep) ? directory.slice(0, -1) : directory;
    return candidate === root || candidate.startsWith(root + sep);
}
//# sourceMappingURL=allowlist.js.map