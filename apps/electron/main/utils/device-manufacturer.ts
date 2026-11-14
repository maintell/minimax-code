import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export async function readDeviceManufacturer() {
    try {
        if (process.platform === 'darwin')
            return 'Apple';
        if (process.platform === 'linux') {
            return (await readFile('/sys/class/dmi/id/sys_vendor', 'utf8')).trim() || undefined;
        }
        if (process.platform === 'win32' && process.env.SystemRoot) {
            const { stdout } = await execFileAsync(join(process.env.SystemRoot, 'System32', 'reg.exe'), ['query', 'HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS', '/v', 'SystemManufacturer'], { windowsHide: true, timeout: 1500 });
            return (/^\s*SystemManufacturer\s+REG_SZ[ \t]+([^\r\n]*)/im.exec(stdout)?.[1]?.trim() || undefined);
        }
    }
    catch {
        // Some devices do not expose a firmware vendor.
    }
    return undefined;
}
