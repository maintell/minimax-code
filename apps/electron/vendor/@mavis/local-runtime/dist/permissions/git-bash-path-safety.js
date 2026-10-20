import path from 'node:path';
import { homedir } from 'node:os';
import { readBashSubstitutions } from './bash-substitutions.js';
import { extractBashPathIntents, commandHasExecutedHeredocBody, findHeredocBodies, gitBashCommandName, readBashCommand, readBashInlineScript, resolvePermissionPath, splitCommand, splitShellSourceSegments, unwrapBashCommandWrappers, } from '@mavis/permission';
/** One POSIX operand surface for protected paths and recursive workspace boundaries. */
export function gitBashPathSafetyReason(command, workspaceDir, homeDir = homedir(), nesting = 0, checkNative, uncertainCwd = false) {
    if (nesting > 8)
        return 'nested executable script cannot be verified safely.';
    const substitutions = readBashSubstitutions(command);
    if (substitutions.malformed)
        return 'Bash substitution cannot be parsed safely.';
    const embeddedCwdUncertain = uncertainCwd || changesDirectory(command);
    for (const script of substitutions.scripts) {
        const reason = gitBashPathSafetyReason(script, workspaceDir, homeDir, nesting + 1, checkNative, embeddedCwdUncertain);
        if (reason)
            return reason;
    }
    for (const body of findHeredocBodies(command)) {
        if (!commandHasExecutedHeredocBody(body.header))
            continue;
        const reason = gitBashPathSafetyReason(command.slice(body.start, body.end), workspaceDir, homeDir, nesting + 1, checkNative, embeddedCwdUncertain);
        if (reason)
            return reason;
    }
    // A later cd in a loop changes the cwd of an earlier write on the next
    // iteration. Preserve the native-delete gate's conservative loop policy.
    const mayRepeat = splitShellSourceSegments(command).some((segment) => /^(?:for|while|until|do)\b/.test(segment));
    let cwdUncertain = uncertainCwd || (mayRepeat && embeddedCwdUncertain);
    for (const segment of splitCommand(command)) {
        // Branches, pipelines, eval and sourced scripts can change cwd. Until a
        // control-flow-aware cwd is proven, only absolute write paths are safe.
        cwdUncertain ||= changesDirectory(segment);
        // Native Windows payloads belong to the Windows checker in checkers.ts.
        // Keep the invocation intact here: Bash still owns its outer redirects,
        // but must not interpret PowerShell variables or CMD payload syntax.
        for (const surface of unwrapBashCommandWrappers(segment)) {
            if (readBashInlineScript(surface)?.dynamic) {
                return 'dynamic Bash script cannot be verified safely; use direct commands with literal targets.';
            }
            if (surface !== segment) {
                // A wrapper payload is a script, not a single command. Re-enter the
                // splitter so identity, flags and operands belong to the same command.
                const reason = gitBashPathSafetyReason(surface, workspaceDir, homeDir, nesting + 1, checkNative, cwdUncertain);
                if (reason)
                    return reason;
                continue;
            }
            // Assignment-only redirects still write files without a parsed executable.
            const parsed = readBashCommand(surface);
            const name = parsed ? gitBashCommandName(parsed.executable) : '';
            const paths = extractBashPathIntents(surface, true, { retainDynamicTargets: true }).filter((intent) => intent.action === 'write' || intent.action === 'delete');
            // Supported bare env prefixes are already consumed by readBashCommand.
            // Unknown flags (-C/-S) and unparsed absolute env launchers must not hide
            // a different cwd or an executable script from write/delete inspection.
            if (parsed &&
                (parsed.executable.startsWith('-') || (name === 'env' && parsed.args.length > 0))) {
                return 'Bash env wrapper cannot be inspected safely; use a direct command with explicit paths.';
            }
            if (['cmd', 'powershell', 'pwsh'].includes(name)) {
                const nativeReason = checkNative?.(surface, nesting, cwdUncertain);
                if (nativeReason)
                    return nativeReason;
            }
            const args = parsed?.args ?? [];
            const flags = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
            const recursive = name === 'mv' ||
                (name === 'xcopy' && args.some((arg) => /^\/(?:e|s|t)$/i.test(arg))) ||
                (name === 'robocopy' && args.some((arg) => /^\/(?:e|s|mir|purge|move|mov)$/i.test(arg))) ||
                (['cp', 'rm', 'mavis-trash'].includes(name) &&
                    flags.some((arg) => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(arg) ||
                        arg === '--recursive' ||
                        (name === 'cp' && (arg === '--archive' || /^-[A-Za-z]*a[A-Za-z]*$/.test(arg)))));
            if (['robocopy', 'xcopy'].includes(name) &&
                !paths.some((intent) => intent.action === 'write')) {
                return 'native copy destination cannot be verified safely.';
            }
            if (recursive && (!workspaceDir || paths.length === 0)) {
                return 'recursive write/delete target cannot be verified inside the workspace.';
            }
            for (const intent of paths) {
                const reason = checkWriteOrDeletePath(intent, {
                    workspaceDir,
                    homeDir,
                    cwdUncertain,
                    recursive,
                });
                if (reason)
                    return reason;
            }
        }
    }
    return undefined;
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
    const value = resolvePermissionPath(intent.path, {
        platform: 'win32',
        workingDirectory: opts.cwdUncertain ? undefined : opts.workspaceDir,
        homeDir: opts.homeDir,
        pathSyntax: intent.pathSyntax,
    }, 'posix');
    // A glob retains its static parent for protected-path checks, but never
    // supplies an authorization or a proven recursive destination.
    const staticPrefix = intent.path.split(/[*?[]/, 1)[0] ?? '';
    const prefix = value.resolution === 'glob'
        ? resolvePermissionPath(staticPrefix, {
            platform: 'win32',
            workingDirectory: opts.cwdUncertain ? undefined : opts.workspaceDir,
            homeDir: opts.homeDir,
            ...(intent.pathSyntax ? { pathSyntax: { ...intent.pathSyntax, glob: false } } : {}),
        }, 'posix')
        : value;
    if (!prefix.resolved)
        return `Git Bash write path "${intent.path}" cannot be mapped safely; use a native Windows or /c/... path.`;
    const normalized = path.win32.normalize(prefix.resolved).replaceAll('\\', '/').toLowerCase();
    if (value.resolution === 'glob') {
        const parent = (/[\\/]$/.test(staticPrefix) ? prefix.resolved : path.win32.dirname(prefix.resolved))
            .replaceAll('\\', '/')
            .toLowerCase()
            .replace(/\/$/, '');
        const workspace = opts.workspaceDir &&
            path.win32.resolve(opts.workspaceDir).replaceAll('\\', '/').toLowerCase().replace(/\/$/, '');
        if (!workspace || (parent !== workspace && !parent.startsWith(`${workspace}/`))) {
            return `Git Bash wildcard write target "${intent.path}" cannot be verified inside the workspace.`;
        }
    }
    if (/^[a-z]:\/?$/i.test(normalized) ||
        /^[a-z]:\/(?:windows|program files(?: \(x86\))?)(?:\/|$)/i.test(normalized)) {
        return `protected Windows path "${prefix.resolved}" cannot be written or deleted.`;
    }
    if (opts.recursive &&
        intent.action === 'delete' &&
        normalized.replace(/\/$/, '') ===
            path.win32.normalize(opts.homeDir).replaceAll('\\', '/').toLowerCase().replace(/\/$/, '')) {
        return 'recursive deletion of the home directory is not allowed; choose a specific sub-path.';
    }
    if (opts.recursive) {
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
    }
    return undefined;
}
//# sourceMappingURL=git-bash-path-safety.js.map