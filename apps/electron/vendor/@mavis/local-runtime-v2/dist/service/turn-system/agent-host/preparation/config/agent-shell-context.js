/** This fact is derived from the same snapshot used by the native executor. */
export function agentShellInstructions(shell) {
    const common = `Agent command shell: ${shell.family} (version at binding: ${shell.version}). The host is Windows. ` +
        'Shell upgrades do not invalidate the conversation. Availability is checked only when executing commands; if unavailable, continue with other tools without switching shells. ' +
        'The bash tool executes commands in this shell, in a fresh non-interactive process rooted at the session workspace. ' +
        'Do not infer shell syntax from the tool name. Do not wrap ordinary commands in another shell. ' +
        'Changing directory or environment variables only affects the current invocation. ' +
        'Use dedicated read/write/edit/grep/glob tools when suitable. ' +
        'Deletion and permission restrictions remain in force; use one simple top-level rm command with literal targets for recoverable deletion. ';
    if (shell.family === 'git-bash')
        return (`${common}Use Bash syntax ($VAR, export, single-quoted literals). Windows PowerShell-specific syntax guidance does not apply to this session. ` +
            `This is Git for Windows, not WSL; dedicated file tools still use native Windows paths. ` +
            `MSYS may convert native Windows CLI slash options (such as /FO) into paths; when needed, set MSYS_NO_PATHCONV=1 only for that native command, not globally. ` +
            `Tool output is decoded as UTF-8. Native programs or nested Windows PowerShell may emit another encoding even with exit code 0. Determine the producer's encoding and convert only that producer's stdout/stderr to UTF-8; never guess an encoding for a mixed stream or change the global code page. ` +
            `Use statically resolvable literal write paths; dynamic targets that cannot be mapped safely are rejected. Do not bypass a permission denial. ` +
            `Check pipeline stage statuses (PIPESTATUS or pipefail); a successful final stage does not prove earlier stages succeeded. ` +
            `Do not use CMD or chain destructive operations across shells. Use run_in_background for long-running commands.`);
    return (`${common}Use PowerShell syntax ($env:VAR, Get-ChildItem, Get-Content, Select-String). ` +
        `Use single-quoted literal strings and regex patterns, not Bash-style backslash escaping. ` +
        `Use explicit UTF-8 for file IO, $ErrorActionPreference = 'Stop' for scripts, and check native exit codes. ${shell.family === 'windows-powershell' ? 'PowerShell 5.1 does not support && or ||. ' : ''}Do not use CMD. Use run_in_background for long-running commands.`);
}
//# sourceMappingURL=agent-shell-context.js.map