import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { readBashSubstitutions } from './bash-substitutions.js';
import { candidateDirectories, collectLiteralCdTargets, readLeadingLiteralCd, } from './git-bash-cwd.js';
import { extractBashPathIntents, commandHasShellScriptHeredocBody, findHeredocBodies, gitBashCommandName, readBashCommand, readBashInlineScript, resolvePermissionPath, splitCommand, splitShellSourceSegments, unwrapBashCommandWrappers, } from '@mavis/permission';
const NATIVE_SHELL_COMMANDS = new Set(['cmd', 'powershell', 'pwsh']);
/** Permanent POSIX deletes that native deletion leaves to the shell's own syntax. */
const NATIVE_DELETE_COMMANDS = new Set(['rm', 'rmdir', 'unlink']);
/**
 * One POSIX operand surface for protected paths and recursive workspace
 * boundaries. Protected, home, drive-root and unproven recursive targets are
 * bypass-immune; a single write whose target cannot be mapped is `policy`.
 */
export function evaluateGitBashPathSafety(command, workspaceDir, homeDir = homedir(), context = {}) {
    const confirmable = {};
    const reason = scanGitBashScript(command, {
        workspaceDir,
        additionalWorkspaceDirs: context.additionalWorkspaceDirs ?? [],
        homeDir,
        tmpDir: context.tmpDir ?? tmpdir(),
        cdTargets: [],
        nesting: context.nesting ?? 0,
        checkNative: context.checkNative,
        nativeDelete: context.nativeDelete === true,
        confirmable,
    }, context.uncertainCwd ?? false);
    if (reason)
        return { reason, denyKind: 'bypass-immune' };
    return confirmable.reason ? { reason: confirmable.reason, denyKind: 'policy' } : undefined;
}
function scanGitBashScript(command, outer, uncertainCwd) {
    if (outer.nesting > 8)
        return 'nested executable script cannot be verified safely.';
    const leading = uncertainCwd ? undefined : enterLeadingCd(command, outer);
    if (leading)
        return scanGitBashScript(leading.rest, leading.scan, false);
    const scan = { ...outer, cdTargets: [...outer.cdTargets, ...collectLiteralCdTargets(command)] };
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
/** `cd <literal> && rest` proves rest's cwd; every other cd keeps it uncertain. */
function enterLeadingCd(command, scan) {
    const cd = readLeadingLiteralCd(command);
    if (!cd)
        return undefined;
    const directory = resolveGitBashDirectory(cd.directory, scan.cwd ?? scan.workspaceDir, scan);
    return directory ? { rest: cd.rest, scan: { ...scan, cwd: directory } } : undefined;
}
function resolveGitBashDirectory(target, workingDirectory, scan) {
    const value = resolveGitBashPath(target, undefined, {
        workingDirectory,
        homeDir: scan.homeDir,
        tmpDir: scan.tmpDir,
    });
    return value.dynamic ? undefined : value.resolved;
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
        // After a leading cd the native checker's entry cwd is no longer Bash's cwd.
        const native = scan.checkNative?.(surface, scan.nesting, cwdUncertain || scan.cwd !== undefined);
        if (native?.denyKind === 'bypass-immune')
            return native.reason;
        if (native)
            scan.confirmable.reason ??= native.reason;
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
            additionalWorkspaceDirs: scan.additionalWorkspaceDirs,
            homeDir: scan.homeDir,
            tmpDir: scan.tmpDir,
            cwd: scan.cwd,
            cdTargets: scan.cdTargets,
            confirmable: scan.confirmable,
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
    const base = pathBaseFor(opts);
    const value = resolveGitBashPath(intent.path, intent.pathSyntax, base);
    // A glob retains its static parent for protected-path checks, but never
    // supplies an authorization or a proven recursive destination.
    const staticPrefix = intent.path.split(/[*?[]/, 1)[0] ?? '';
    const prefix = value.resolution === 'glob'
        ? resolveGitBashPath(staticPrefix, intent.pathSyntax ? { ...intent.pathSyntax, glob: false } : undefined, base)
        : value;
    if (!prefix.resolved)
        return unmappedGitBashPathReason(intent.path, opts);
    const normalized = normalizeGitBashPath(prefix.resolved);
    const globReason = value.resolution === 'glob'
        ? checkGlobParent({ raw: intent.path, staticPrefix, resolved: prefix.resolved }, opts)
        : undefined;
    return (globReason ??
        checkProtectedGitBashPath(normalized, prefix.resolved) ??
        checkRecursiveGitBashPath(intent, { normalized, value }, opts));
}
/** An uncertain cwd resolves no relative path; otherwise a leading cd's directory wins. */
function pathBaseFor(opts) {
    return {
        workingDirectory: opts.cwdUncertain ? undefined : (opts.cwd ?? opts.workspaceDir),
        homeDir: opts.homeDir,
        tmpDir: opts.tmpDir,
    };
}
/** `normalized` is a lowercase, forward-slash Windows path without a trailing slash. */
function isInsideWorkspace(normalized, opts) {
    if (!opts.workspaceDir)
        return false;
    return [opts.workspaceDir, ...opts.additionalWorkspaceDirs].some((root) => {
        const workspace = path.win32
            .resolve(root)
            .replaceAll('\\', '/')
            .toLowerCase()
            .replace(/\/$/, '');
        return normalized === workspace || normalized.startsWith(`${workspace}/`);
    });
}
function resolveGitBashPath(raw, pathSyntax, base) {
    return resolvePermissionPath(mapGitBashMountPath(raw, base.tmpDir), {
        platform: 'win32',
        workingDirectory: base.workingDirectory,
        homeDir: base.homeDir,
        ...(pathSyntax ? { pathSyntax } : {}),
    }, 'posix');
}
/**
 * Git for Windows mounts /tmp at the user's TEMP (`usertemp` in /etc/fstab).
 * /usr, /etc, /var/tmp and other mounts live under the Git installation and
 * stay unmapped. Dot segments fold first, as MSYS does, so /tmp/../c/Windows
 * is the /c drive mount rather than a temp path. Expansions are left intact.
 */
function mapGitBashMountPath(raw, tmpDir) {
    if (!raw.startsWith('/') || raw.startsWith('//') || /[$`]/.test(raw))
        return raw;
    const normalized = path.posix.normalize(raw);
    const temp = /^\/tmp(?=\/|$)/.exec(normalized);
    if (!temp || !tmpDir || !/^[A-Za-z]:[\\/]/.test(tmpDir))
        return normalized;
    return path.win32.join(tmpDir, normalized.slice(temp[0].length));
}
function normalizeGitBashPath(resolved) {
    return path.win32.normalize(resolved).replaceAll('\\', '/').toLowerCase();
}
/**
 * An unmapped target is neither proven protected nor proven safe. Recursive
 * writes keep the hard workspace proof, and so does a single write whose
 * literal part reaches a protected directory from any possible cwd. Any other
 * single write needs confirmation. Native deletion leaves it to ordinary
 * permissions.
 */
function unmappedGitBashPathReason(raw, opts) {
    if (opts.nativeDelete)
        return undefined;
    const reason = `Git Bash write path "${raw}" cannot be mapped safely; use a native Windows or /c/... path.`;
    if (opts.recursive)
        return reason;
    const protectedReason = findProtectedLiteralTarget(raw, opts);
    if (protectedReason)
        return protectedReason;
    opts.confirmable.reason ??= reason;
    return undefined;
}
/** Checks the static part before the first expansion or glob: `C:/Windows/$(x)` is protected. */
function findProtectedLiteralTarget(raw, opts) {
    const literal = raw.split(/[$`*?[]/, 1)[0] ?? '';
    const target = literal === raw ? literal : literal.replace(/[^\\/]*$/, '');
    if (!target)
        return undefined;
    const directories = literalTargetDirectories(target, opts);
    if (!directories) {
        return `Git Bash write path "${raw}" cannot be verified after several directory changes.`;
    }
    for (const workingDirectory of directories) {
        const { resolved } = resolveGitBashPath(target, undefined, { ...opts, workingDirectory });
        const reason = resolved
            ? checkProtectedGitBashPath(normalizeGitBashPath(resolved), resolved)
            : undefined;
        if (reason)
            return reason;
    }
    return undefined;
}
/** A relative literal is checked from every directory an unproven cd may have entered. */
function literalTargetDirectories(target, opts) {
    if (/^(?:\/|~|[A-Za-z]:[\\/])/.test(target))
        return [undefined];
    const start = opts.cwd ?? opts.workspaceDir;
    if (!opts.cwdUncertain)
        return [start];
    return candidateDirectories(start, opts.cdTargets, (cdTarget, base) => resolveGitBashDirectory(cdTarget, base, opts));
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
    if (!isInsideWorkspace(parent, opts)) {
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
    if (value.dynamic || !value.resolved || !isInsideWorkspace(normalized, opts)) {
        return `recursive write/delete target "${intent.path}" is outside the workspace or cannot be verified.`;
    }
    return undefined;
}
//# sourceMappingURL=git-bash-path-safety.js.map