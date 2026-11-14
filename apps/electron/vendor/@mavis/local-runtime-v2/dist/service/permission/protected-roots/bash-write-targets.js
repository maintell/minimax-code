import { homedir } from 'node:os';
import path from 'node:path';
import { extractBashPathIntents, readBashCommand, resolvePermissionPath, splitCommand, unwrapBashCommandWrappers, } from '@mavis/permission';
import { canonicalPath, isInside } from './canonical-paths.js';
/**
 * Write and delete targets the shared bash path model recognizes: redirects,
 * `tee`, `cp`/`mv` destinations, `mv` and `rm` operands, and `sed -i` files,
 * including commands wrapped in `bash -c`. Reads are never targets here.
 * Relative targets resolve from the session directories and from every literal
 * `cd` in the command, so an earlier `cd` cannot hide the directory.
 */
export function bashWritesInside(root, sessionBases, toolInput, protects) {
    const command = [toolInput.command, toolInput.cmd].find((value) => typeof value === 'string');
    if (!command?.trim())
        return false;
    const windowsPosix = process.platform === 'win32';
    const home = homedir();
    for (const script of unwrapBashCommandWrappers(command)) {
        const bases = [...sessionBases, ...literalCdTargets(script, sessionBases, home)];
        const targets = extractBashPathIntents(script, windowsPosix, {
            retainDynamicTargets: true,
        }).filter((intent) => intent.action === 'write' || intent.action === 'delete');
        for (const target of targets) {
            if (bashTargetReaches({ root, bases, home, protects }, target))
                return true;
        }
    }
    return false;
}
function bashTargetReaches({ root, bases, home, protects, }, target) {
    const glob = firstGlobIndex(target.path);
    const raw = glob === undefined ? target.path : staticGlobDirectory(target.path, glob);
    const pathSyntax = glob === undefined || !target.pathSyntax
        ? target.pathSyntax
        : { ...target.pathSyntax, glob: false };
    const resolved = resolveBashPath(raw, bases, home, pathSyntax);
    // Variables and other expansions cannot be resolved here; a target that
    // still names the protected directory by its last segments is treated as it.
    if (resolved === undefined)
        return namesDirectory(root, target.path);
    return resolved.some((candidate) => {
        const canonical = canonicalPath(candidate);
        if (protects(root, canonical))
            return true;
        // Deleting or moving away a literal parent removes the protected directory too.
        return target.action === 'delete' && glob === undefined && isInside(canonical, root);
    });
}
function resolveBashPath(raw, bases, home, pathSyntax) {
    const context = {
        homeDir: home,
        platform: process.platform,
        ...(pathSyntax ? { pathSyntax } : {}),
    };
    const first = resolvePermissionPath(raw, context, 'posix');
    if (first.dynamic)
        return undefined;
    if (first.resolution !== 'relative')
        return first.resolved ? [first.resolved] : undefined;
    return bases.flatMap((workingDirectory) => {
        const value = resolvePermissionPath(raw, { ...context, workingDirectory }, 'posix');
        return value.resolved ? [value.resolved] : [];
    });
}
/** Every `cd`/`pushd` to a literal directory, resolved from the session directories. */
function literalCdTargets(script, bases, home) {
    return splitCommand(script).flatMap((segment) => {
        const parsed = readBashCommand(segment.trim());
        if (!parsed || !['cd', 'pushd'].includes(parsed.executable))
            return [];
        const operand = parsed.args.find((arg) => !arg.startsWith('-'));
        if (!operand)
            return [];
        return resolveBashPath(operand, bases, home, undefined) ?? [];
    });
}
function firstGlobIndex(raw) {
    const index = raw.search(/[*?[]/);
    return index < 0 ? undefined : index;
}
/** The literal directory a glob expands inside, e.g. `memory` for `memory/*.md`. */
function staticGlobDirectory(raw, globIndex) {
    const slash = raw.lastIndexOf('/', globIndex);
    if (slash < 0)
        return '.';
    return slash === 0 ? '/' : raw.slice(0, slash);
}
function namesDirectory(root, raw) {
    const tail = `${path.basename(path.dirname(root))}/${path.basename(root)}`;
    const normalized = `/${raw.replaceAll('\\', '/')}/`;
    return normalized.includes(`/${tail}/`);
}
//# sourceMappingURL=bash-write-targets.js.map