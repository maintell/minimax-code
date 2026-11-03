/**
 * Windows opt-in "enhanced" Open With registration for text-like files.
 *
 * The installer only lists MCode through `Applications\<exe>\SupportedTypes`,
 * which never makes it a default handler. When the user opts in, this module
 * adds the installer's `<APP_ID>.Document` ProgID to
 * `HKCU\Software\Classes\.<ext>\OpenWithProgids` for text-like types, like VS
 * Code does. Windows may then pick MCode as the implicit default for a type no
 * other application handles; the setting copy states that trade-off.
 *
 * The installer removes these candidates on every install and upgrade, so an
 * enabled preference is re-applied on startup. Full uninstall removes them too.
 * Nothing here writes UserChoice, extension defaults or Explorer MRU entries.
 */
import { execFile } from "node:child_process";
import * as path from "node:path";
import { ENHANCED_OPEN_WITH_EXTENSIONS } from "./text-file-types.generated";
const POWERSHELL_TIMEOUT_MS = 30000;
// The ProgID is read from the installer's ownership marker instead of the
// runtime App ID: internal builds install under a different builder appId.
// It is used only when that ProgID's open command launches this executable.
const OPEN_WITH_SCRIPT = String.raw `
$ErrorActionPreference = 'Stop'
$exe = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__EXE_BASE64__'))
$enable = '__ENABLE__' -eq '1'
$extensions = '__EXTENSIONS__'.Split(',')
$classes = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Classes', $true)
$appKey = $classes.OpenSubKey('Applications\' + [IO.Path]::GetFileName($exe))
$appId = if ($null -ne $appKey) { [string]$appKey.GetValue('MCodeAppId') } else { '' }
if ($null -ne $appKey) { $appKey.Close() }
if (-not $appId) { 'status=not-registered'; exit 0 }
$progId = $appId + '.Document'
$commandKey = $classes.OpenSubKey($progId + '\shell\open\command')
$command = if ($null -ne $commandKey) { [string]$commandKey.GetValue('') } else { '' }
if ($null -ne $commandKey) { $commandKey.Close() }
if ($command -ne ('"' + $exe + '" --open-file "%1"')) { 'status=not-registered'; exit 0 }
foreach ($ext in $extensions) {
  $path = '.' + $ext + '\OpenWithProgids'
  if ($enable) {
    $key = $classes.CreateSubKey($path)
    $key.SetValue($progId, [byte[]]@(), [Microsoft.Win32.RegistryValueKind]::None)
    $key.Close()
    continue
  }
  $key = $classes.OpenSubKey($path, $true)
  if ($null -eq $key) { continue }
  $key.DeleteValue($progId, $false)
  $empty = $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0
  $key.Close()
  # Keep other applications' candidates; drop only a key this left empty.
  if ($empty) { $classes.DeleteSubKey($path, $false) }
}
$classes.Close()
try {
  Add-Type -Namespace MCode -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);'
  [MCode.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
} catch {}
'status=applied'
`;
export function buildFileOpenWithScript(options) {
    const extensions = options.extensions ?? ENHANCED_OPEN_WITH_EXTENSIONS;
    if (extensions.length === 0 || extensions.some((ext) => !/^[a-z0-9]+$/.test(ext))) {
        throw new Error('Open With extensions must be literal lowercase extensions');
    }
    return OPEN_WITH_SCRIPT.replace('__EXE_BASE64__', Buffer.from(options.exePath, 'utf8').toString('base64'))
        .replace('__ENABLE__', options.enabled ? '1' : '0')
        .replace('__EXTENSIONS__', extensions.join(','));
}
function runPowerShell(script) {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
        return Promise.reject(new Error('SystemRoot is unavailable'));
    }
    return new Promise((resolve, reject) => {
        execFile(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
        ], { windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
            // Do not surface error.message: it embeds the encoded command and user path.
            if (error) {
                reject(new Error(`Open With registration ${error.killed ? 'timed out' : `failed (code=${error.code ?? 'unknown'})`}`));
                return;
            }
            resolve(stdout);
        });
    });
}
export async function applyFileOpenWithRegistration(options) {
    const output = await runPowerShell(buildFileOpenWithScript(options));
    const status = output.match(/status=(applied|not-registered)/)?.[1];
    if (!status)
        throw new Error('Open With registration returned no status');
    return status;
}
let queue = Promise.resolve();
/**
 * Serializes registry updates so quick toggles land in the order requested.
 */
export function queueFileOpenWithRegistration(options) {
    const next = queue.then(() => applyFileOpenWithRegistration(options));
    queue = next.catch(() => undefined);
    return next;
}
