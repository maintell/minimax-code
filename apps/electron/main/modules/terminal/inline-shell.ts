import { join } from "node:path";
const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
/** Private startup script avoids echoing shell integration commands into the user's terminal. */
export function inlineShellStartup(shell, command, token, directory) {
    if (shell === 'cmd')
        throw new Error('Inline terminal requires Bash, Zsh or PowerShell');
    if (shell === 'pwsh') {
        const scriptPath = join(directory, 'startup.ps1');
        // Capture both status values before any integration command changes them. Clear the native
        // code at each prompt so a later cmdlet failure cannot inherit an earlier native exit code.
        const initialExit = 'MCodeInlineInitialExit';
        const prompt = `function global:prompt { $ok = $global:?; $native = $global:LASTEXITCODE; $global:LASTEXITCODE = 0; $code = if ($null -ne $global:${initialExit}) { $global:${initialExit}; Remove-Variable ${initialExit} -Scope Global } elseif ($ok) { 0 } elseif ($native) { $native } else { 1 }; [Console]::Write(([char]27).ToString() + ']777;${token};' + $code + [char]7); 'PS ' + $PWD + '> ' }`;
        const quotedCommand = "'" + command.replace(/['\u2018-\u201b]/g, '$&$&') + "'";
        // Capture inside the evaluated script: returning from a successful startup file resets $?.
        const captureInitialExit = `$global:${initialExit} = if ($?) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }`;
        return {
            scriptPath,
            // BOM is required by Windows PowerShell 5.1 for non-ASCII source. Parse user input
            // separately: a syntax error must not prevent the integration/ready handshake.
            script: `\uFEFFif ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 1 }
if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) { Set-PSReadLineOption -HistorySaveStyle SaveNothing }; ${prompt}
[Console]::Write(([char]27).ToString() + ']777;${token};ready;' + $PSVersionTable.PSVersion.ToString() + [char]7)
$global:LASTEXITCODE = 0
$global:${initialExit} = 1
try { Invoke-Expression (${quotedCommand} + "\n" + '${captureInitialExit}') } catch { Write-Error -ErrorRecord $_ }
`,
            // Process-local only; MachinePolicy/UserPolicy still take precedence. Never change
            // the user's persistent execution policy. A blocked startup fails the handshake.
            args: ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        };
    }
    const marker = `printf '\\033]777;${token};%s\\007' "$?"`;
    const setup = shell === 'bash'
        ? `unset HISTFILE; set +o history; PROMPT_COMMAND=${quote(marker)}`
        : `unset HISTFILE ZDOTDIR; HISTSIZE=0; SAVEHIST=0; precmd() { ${marker}; }`;
    const scriptPath = join(directory, shell === 'bash' ? 'bashrc' : '.zshrc');
    return {
        scriptPath,
        script: `${setup}\nprintf '\\033]777;${token};ready;%s\\007' "${shell === 'bash' ? '$BASH_VERSION' : '$ZSH_VERSION'}"\neval ${quote(command)}\n`,
        args: shell === 'bash' ? ['--noprofile', '--rcfile', scriptPath, '-i'] : ['-d', '-i'],
        ...(shell === 'zsh' ? { env: { ZDOTDIR: directory } } : {}),
    };
}
