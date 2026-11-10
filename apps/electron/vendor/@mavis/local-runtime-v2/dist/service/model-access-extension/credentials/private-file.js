import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ModelAccessCredentialError } from './credential-state.js';
const run = promisify(execFile);
function windowsSystemTool(name) {
    const root = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    return name === 'powershell.exe'
        ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', name)
        : path.win32.join(root, 'System32', name);
}
// A fresh descriptor only marks Access as modified. Set-Acl on a descriptor from
// Get-Acl also attempts to persist owner/group and can require privileges the
// desktop runtime does not hold. Never weaken the DACL or elevate to work around it.
const WINDOWS_PRIVATE_DACL_SCRIPT = `
$ErrorActionPreference='Stop'
$p=$env:MCODE_PRIVATE_PATH
$sid=[System.Security.Principal.SecurityIdentifier]::new($env:MCODE_PRIVATE_SID)
$directory=$env:MCODE_PRIVATE_KIND -eq 'directory'
$sections=[System.Security.AccessControl.AccessControlSections]::Access
$inherit=[System.Security.AccessControl.InheritanceFlags]::None
if($directory){
  $acl=[System.Security.AccessControl.DirectorySecurity]::new()
  $inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
}else{
  $acl=[System.Security.AccessControl.FileSecurity]::new()
}
$acl.SetAccessRuleProtection($true,$false)
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow')
$acl.AddAccessRule($rule)
if($directory){
  [System.IO.Directory]::SetAccessControl($p,$acl)
  $check=[System.IO.Directory]::GetAccessControl($p,$sections)
}else{
  [System.IO.File]::SetAccessControl($p,$acl)
  $check=[System.IO.File]::GetAccessControl($p,$sections)
}
if(-not $check.AreAccessRulesProtected){exit 2}
$rules=@($check.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
if($rules.Count -ne 1){exit 3}
$r=$rules[0]
if($r.IdentityReference.Value -ne $sid.Value -or $r.IsInherited -or $r.AccessControlType -ne 'Allow' -or $r.FileSystemRights -ne 'FullControl' -or $r.InheritanceFlags -ne $inherit -or $r.PropagationFlags -ne 'None'){exit 4}
`;
let userSid;
async function loadSid() {
    const { stdout } = await run(windowsSystemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
        windowsHide: true,
        timeout: 5000,
    });
    const sid = stdout.match(/S-1-5-(?:\d+-)*\d+/u)?.[0];
    if (!sid)
        throw new Error('sid_missing');
    return sid;
}
function currentSid() {
    userSid ??= loadSid();
    return userSid;
}
/** chmod is not a Windows ACL; restrict inheritance and verify the actual current user SID. @internal */
export async function restrictPrivatePath(file, directory) {
    try {
        if (process.platform !== 'win32') {
            await chmod(file, directory ? 0o700 : 0o600);
            return;
        }
        const sid = await currentSid();
        await run(windowsSystemTool('powershell.exe'), [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(WINDOWS_PRIVATE_DACL_SCRIPT, 'utf16le').toString('base64'),
        ], {
            windowsHide: true,
            timeout: 30000,
            maxBuffer: 64 * 1024,
            env: {
                ...process.env,
                MCODE_PRIVATE_PATH: file,
                MCODE_PRIVATE_SID: sid,
                MCODE_PRIVATE_KIND: directory ? 'directory' : 'file',
            },
        });
    }
    catch {
        throw new ModelAccessCredentialError('secret_store_locked_or_denied');
    }
}
export async function ensureModelAccessPrivateDirectory(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const st = await lstat(directory);
    const actualPath = await realpath(directory);
    const expectedPath = path.resolve(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || actualPath !== expectedPath) {
        throw new ModelAccessCredentialError('secret_store_locked_or_denied');
    }
    await restrictPrivatePath(directory, true);
}
export async function writeModelAccessPrivateFile(file, text, beforeCommit = () => { }) {
    const temporary = `${file}.${randomUUID()}.pending`;
    try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
            await restrictPrivatePath(temporary, false);
            await handle.writeFile(text);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        beforeCommit();
        await rename(temporary, file);
        if (process.platform !== 'win32') {
            const directory = await open(path.dirname(file), 'r');
            try {
                await directory.sync();
            }
            finally {
                await directory.close();
            }
        }
    }
    finally {
        try {
            await unlink(temporary);
        }
        catch {
            /* Rename committed or no file was created. */
        }
    }
}
//# sourceMappingURL=private-file.js.map