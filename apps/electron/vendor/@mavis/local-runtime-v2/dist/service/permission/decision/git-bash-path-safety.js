import path from 'node:path';
import { homedir } from 'node:os';
import { readBashSubstitutions } from './bash-substitutions.js';
import { extractBashPathIntents, commandHasShellScriptHeredocBody, findHeredocBodies, gitBashCommandName, readBashCommand, readBashInlineScript, resolvePermissionPath, splitCommand, splitShellSourceSegments, unwrapBashCommandWrappers, } from '@mavis/permission';
const NATIVE_SHELL_COMMANDS = new Set(['cmd', 'powershell', 'pwsh']);
/** Permanent POSIX deletes that native deletion leaves to the shell's own syntax. */
const NATIVE_DELETE_COMMANDS = new Set(['rm', 'rmdir', 'unlink']);
/** One POSIX operand surface for protected paths and recursive workspace boundaries. */
export function gitBashPathSafetyReason(command, workspaceDir, homeDir = homedir(), context = {}) {
    return scanGitBashScript(command, {
        workspaceDir,
        homeDir,
        nesting: context.nesting ?? 0,
        checkNative: context.checkNative,
        nativeDelete: context.nativeDelete === true,
    }, context.uncertainCwd ?? false);
}
function scanGitBashScript(command, scan, uncertainCwd) {
    if (scan.nesting > 8)
        return 'nested executable script cannot be verified safely.';
    const substitutions = readBashSubstitutions(command);
    if (substitutions.malformed)
        return 'Bash substitution cannot be parsed safely.';
    const embeddedCwdUncertain = uncertainCwd || changesDirectory(command);
    const embeddedReason = scanEmbeddedScripts(command, substitutions.scripts, scan, embeddedCwdUncertain);
    if (embeddedReason)
        return embeddedReason;
    // A later cd in a loop changes the cwd of an earlier write on the next
    // iteration. Preserve the native-delete gate's conservative loop policy.
    const mayRepeat = splitShellSourceSegments(command).some((segment) => /^(?:for|while|until|do)\b/.test(segment));
    return scanGitBashSegments(command, scan, uncertainCwd || (mayRepeat && embeddedCwdUncertain));
}
/**
 * Substitutions and heredoc bodies run by a shell are scripts of their own.
 * A body fed to python/node/ruby is a program in another language: reading its
 * comparisons (`a>b`, `-> int`, `=>`) as redirects reports bogus write targets.
 * File writes made by such programs are outside this static Bash path scan.
 */
function scanEmbeddedScripts(command, substitutionScripts, scan, uncertainCwd) {
    const heredocScripts = findHeredocBodies(command)
        .filter((body) => commandHasShellScriptHeredocBody(body.header))
        .map((body) => command.slice(body.start, body.end));
    const nested = { ...scan, nesting: scan.nesting + 1 };
    for (const script of [...substitutionScripts, ...heredocScripts]) {
        const reason = scanGitBashScript(script, nested, uncertainCwd);
        if (reason)
            return reason;
    }
    return undefined;
}
function scanGitBashSegments(command, scan, uncertainCwd) {
    let cwdUncertain = uncertainCwd;
    for (const segment of splitCommand(command)) {
        // Branches, pipelines, eval and sourced scripts can change cwd. Until a
        // control-flow-aware cwd is proven, only absolute write paths are safe.
        cwdUncertain ||= changesDirectory(segment);
        // Native Windows payloads belong to the Windows checker in windows/path-safety.ts.
        // Keep the invocation intact here: Bash still owns its outer redirects,
        // but must not interpret PowerShell variables or CMD payload syntax.
        for (const surface of unwrapBashCommandWrappers(segment)) {
            const reason = scanGitBashSurface({ segment, surface }, scan, cwdUncertain);
            if (reason)
                return reason;
        }
    }
    return undefined;
}
function scanGitBashSurface(input, scan, cwdUncertain) {
    const { segment, surface } = input;
    if (readBashInlineScript(surface)?.dynamic) {
        return 'dynamic Bash script cannot be verified safely; use direct commands with literal targets.';
    }
    if (surface !== segment) {
        // A wrapper payload is a script, not a single command. Re-enter the
        // splitter so identity, flags and operands belong to the same command.
        return scanGitBashScript(surface, { ...scan, nesting: scan.nesting + 1 }, cwdUncertain);
    }
    return scanGitBashCommand(surface, scan, cwdUncertain);
}
function scanGitBashCommand(surface, scan, cwdUncertain) {
    // Assignment-only redirects still write files without a parsed executable.
    const parsed = readBashCommand(surface);
    const name = parsed ? gitBashCommandName(parsed.executable) : '';
    const paths = extractBashPathIntents(surface, true, { retainDynamicTargets: true }).filter((intent) => intent.action === 'write' || intent.action === 'delete');
    // Supported bare env prefixes are already consumed by readBashCommand.
    // Unknown flags (-C/-S) and unparsed absolute env launchers must not hide
    // a different cwd or an executable script from write/delete inspection.
    if (parsed && hidesEnvWrapper(parsed, name)) {
        return 'Bash env wrapper cannot be inspected safely; use a direct command with explicit paths.';
    }
    if (NATIVE_SHELL_COMMANDS.has(name)) {
        const nativeReason = scan.checkNative?.(surface, scan.nesting, cwdUncertain);
        if (nativeReason)
            return nativeReason;
    }
    return checkGitBashWriteTargets({ name, args: parsed?.args ?? [], paths }, scan, cwdUncertain);
}
function hidesEnvWrapper(parsed, name) {
    return parsed.executable.startsWith('-') || (name === 'env' && parsed.args.length > 0);
}
function checkGitBashWriteTargets(command, scan, cwdUncertain) {
    const { name, args, paths } = command;
    const recursive = isRecursiveGitBashWrite(name, args);
    const nativeDelete = scan.nativeDelete && NATIVE_DELETE_COMMANDS.has(name);
    if (['robocopy', 'xcopy'].includes(name) && !paths.some((intent) => intent.action === 'write')) {
        return 'native copy destination cannot be verified safely.';
    }
    if (recursive && needsRecursiveWorkspaceProof(scan, paths, nativeDelete)) {
        return 'recursive write/delete target cannot be verified inside the workspace.';
    }
    for (const intent of paths) {
        const reason = checkWriteOrDeletePath(intent, {
            workspaceDir: scan.workspaceDir,
            homeDir: scan.homeDir,
            cwdUncertain,
            recursive,
            nativeDelete: nativeDelete && intent.action === 'delete',
        });
        if (reason)
            return reason;
    }
    return undefined;
}
/** Only native delete operands skip the workspace proof; other writes keep it. */
function needsRecursiveWorkspaceProof(scan, paths, nativeDelete) {
    if (nativeDelete && paths.every((intent) => intent.action === 'delete'))
        return false;
    return !scan.workspaceDir || paths.length === 0;
}
function isRecursiveGitBashWrite(name, args) {
    if (name === 'mv')
        return true;
    if (name === 'xcopy')
        return args.some((arg) => /^\/(?:e|s|t)$/i.test(arg));
    if (name === 'robocopy')
        return args.some((arg) => /^\/(?:e|s|mir|purge|move|mov)$/i.test(arg));
    if (!['cp', 'rm', 'mavis-trash'].includes(name))
        return false;
    const delimiter = args.indexOf('--');
    const flags = args.slice(0, delimiter < 0 ? args.length : delimiter);
    return flags.some((arg) => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(arg) ||
        arg === '--recursive' ||
        (name === 'cp' && (arg === '--archive' || /^-[A-Za-z]*a[A-Za-z]*$/.test(arg))));
}
function changesDirectory(command, nesting = 0) {
    if (nesting > 8)
        return true;
    return splitCommand(command).some((segment) => unwrapBashCommandWrappers(segment).some((surface) => {
        if (surface !== segment)
            return changesDirectory(surface, nesting + 1);
        const parsed = readBashCommand(surface);
        return (!!parsed &&
            ['cd', 'pushd', 'popd', 'source', '.'].includes(gitBashCommandName(parsed.executable)));
    }));
}
/**
 * Verify a single write/delete path intent against the workspace and the
 * Windows protected-path policy. Returns a deny reason when the path
 * cannot be authorized, or undefined when the intent is safe.
 */
function checkWriteOrDeletePath(intent, opts) {
    if (['/dev/null', '/dev/stdout', '/dev/stderr'].includes(intent.path))
        return undefined;
    const value = resolveGitBashPath(intent.path, intent.pathSyntax, opts);
    // A glob retains its static parent for protected-path checks, but never
    // supplies an authorization or a proven recursive destination.
    const staticPrefix = intent.path.split(/[*?[]/, 1)[0] ?? '';
    const prefix = value.resolution === 'glob'
        ? resolveGitBashPath(staticPrefix, intent.pathSyntax ? { ...intent.pathSyntax, glob: false } : undefined, opts)
        : value;
    if (!prefix.resolved)
        return unmappedGitBashPathReason(intent.path, opts);
    const normalized = path.win32.normalize(prefix.resolved).replaceAll('\\', '/').toLowerCase();
    const globReason = value.resolution === 'glob'
        ? checkGlobParent({ raw: intent.path, staticPrefix, resolved: prefix.resolved }, opts)
        : undefined;
    return (globReason ??
        checkProtectedGitBashPath(normalized, prefix.resolved) ??
        checkRecursiveGitBashPath(intent, { normalized, value }, opts));
}
function resolveGitBashPath(raw, pathSyntax, opts) {
    return resolvePermissionPath(raw, {
        platform: 'win32',
        workingDirectory: opts.cwdUncertain ? undefined : opts.workspaceDir,
        homeDir: opts.homeDir,
        ...(pathSyntax ? { pathSyntax } : {}),
    }, 'posix');
}
/** Native deletion leaves an unmapped delete operand to ordinary permissions. */
function unmappedGitBashPathReason(raw, opts) {
    if (opts.nativeDelete)
        return undefined;
    return `Git Bash write path "${raw}" cannot be mapped safely; use a native Windows or /c/... path.`;
}
function checkGlobParent(glob, opts) {
    // The static parent still reaches the protected/home checks; only the
    // workspace proof is skipped for native deletion.
    if (opts.nativeDelete)
        return undefined;
    const parent = (/[\\/]$/.test(glob.staticPrefix) ? glob.resolved : path.win32.dirname(glob.resolved))
        .replaceAll('\\', '/')
        .toLowerCase()
        .replace(/\/$/, '');
    const workspace = opts.workspaceDir &&
        path.win32.resolve(opts.workspaceDir).replaceAll('\\', '/').toLowerCase().replace(/\/$/, '');
    if (!workspace || (parent !== workspace && !parent.startsWith(`${workspace}/`))) {
        return `Git Bash wildcard write target "${glob.raw}" cannot be verified inside the workspace.`;
    }
    return undefined;
}
function checkProtectedGitBashPath(normalized, resolved) {
    if (/^[a-z]:\/?$/i.test(normalized) ||
        /^[a-z]:\/(?:windows|program files(?: \(x86\))?)(?:\/|$)/i.test(normalized)) {
        return `protected Windows path "${resolved}" cannot be written or deleted.`;
    }
    return undefined;
}
function checkRecursiveGitBashPath(intent, target, opts) {
    if (!opts.recursive)
        return undefined;
    const { normalized, value } = target;
    if (intent.action === 'delete' &&
        normalized.replace(/\/$/, '') ===
            path.win32.normalize(opts.homeDir).replaceAll('\\', '/').toLowerCase().replace(/\/$/, '')) {
        return 'recursive deletion of the home directory is not allowed; choose a specific sub-path.';
    }
    if (opts.nativeDelete)
        return undefined;
    const workspace = path.win32
        .resolve(opts.workspaceDir)
        .replaceAll('\\', '/')
        .toLowerCase()
        .replace(/\/$/, '');
    if (value.dynamic ||
        !value.resolved ||
        (normalized !== workspace && !normalized.startsWith(`${workspace}/`))) {
        return `recursive write/delete target "${intent.path}" is outside the workspace or cannot be verified.`;
    }
    return undefined;
}
//# sourceMappingURL=git-bash-path-safety.js.map