import { shell } from "electron";
import { fileURLToPath } from "node:url";
export async function openExternalTarget(target, platform = process.platform) {
    let url;
    try {
        url = new URL(target);
    }
    catch {
        await shell.openExternal(target);
        return;
    }
    if (url.protocol !== 'file:') {
        await shell.openExternal(target);
        return;
    }
    const nativePath = fileURLToPath(url, { windows: platform === 'win32' });
    const error = await shell.openPath(nativePath);
    if (error) {
        throw new Error(error);
    }
}
