import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
// Use native file lists so receiving applications can paste attachments with their original bytes.
const MAC_COPY_FILES = `ObjC.import('AppKit');
function run(paths) {
  const files = $.NSMutableArray.alloc.init;
  for (const path of paths) files.addObject($.NSURL.fileURLWithPath(path));
  const board = $.NSPasteboard.generalPasteboard;
  board.clearContents;
  if (!board.writeObjects(files)) throw Error('Pasteboard write failed');
}`;
const WINDOWS_COPY_FILES = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$paths = [System.Collections.Specialized.StringCollection]::new()
$paths.AddRange([string[]](ConvertFrom-Json ([Console]::In.ReadToEnd())))
[System.Windows.Forms.Clipboard]::SetFileDropList($paths)
`;
export async function copyWorkspaceFilesToClipboard(workspaceDir, relativePaths) {
    const root = await realpath(workspaceDir);
    const files = await Promise.all(relativePaths.map(async (relativePath) => {
        if (path.isAbsolute(relativePath))
            throw new Error('Expected a workspace-relative path');
        const file = await realpath(path.resolve(root, relativePath));
        const relative = path.relative(root, file);
        if (!relative ||
            relative === '..' ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative) ||
            !(await stat(file)).isFile()) {
            throw new Error('Expected a file within the session workspace');
        }
        return file;
    }));
    if (process.platform === 'darwin') {
        await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_COPY_FILES, ...files], { timeout: 5000 });
        return;
    }
    if (process.platform !== 'win32')
        throw new Error('File clipboard unavailable');
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)\n' + WINDOWS_COPY_FILES;
    const running = execFileAsync(executable, [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
    ], { timeout: 10000, windowsHide: true });
    running.child.stdin?.on('error', () => {
        /* execFile reports process startup failures. */
    });
    running.child.stdin?.end(JSON.stringify(files), 'utf8');
    await running;
}
