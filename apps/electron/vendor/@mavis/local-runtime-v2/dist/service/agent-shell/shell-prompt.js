const WINDOWS_COMMAND_SHELL_RULES = `### Session command shell

The host supplies the actual Agent command shell and version for each conversation.
Follow that shell's syntax, regardless of the bash tool name. Do not assume PowerShell,
CMD, or WSL from the Windows platform alone. Do not wrap ordinary commands in another shell.
Prefer dedicated Read / Write / Edit / Grep tools for file operations and use UTF-8 explicitly.
Use one simple top-level rm command with literal targets for recoverable deletion. Never compose destructive file operations across shells.
Never fall back to permanent deletion if recoverable deletion fails.

`;
/** Older online snapshots predate selectable shells. Adapt only the named host shell layer. */
export function normalizeWindowsShellBase(content) {
    return content
        .replace(/### PowerShell only[^]*?(?=\n### |$)/u, WINDOWS_COMMAND_SHELL_RULES)
        .replace('`Test-Path -Path <path> -PathType Leaf` or read the file back.', 'read the file back; in PowerShell, `Test-Path -LiteralPath <path> -PathType Leaf` is also available.');
}
//# sourceMappingURL=shell-prompt.js.map