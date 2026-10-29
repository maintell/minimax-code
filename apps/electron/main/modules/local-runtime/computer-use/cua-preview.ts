import path from "node:path";
import { isDev } from "../../../config";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nativeImage, app, desktopCapturer, screen } from "electron";
import { getScreenPermissionStatus } from "../../screenshot/permission";
import { getCategoryLogger } from "../../../utils/logger";
const logger = getCategoryLogger('main', 'computer-use-preview');
const targets = new Map();
let revision = 0;
const icons = new Map();
async function appIcon(appPath) {
    if (!appPath || !path.isAbsolute(appPath) || !appPath.endsWith('.app'))
        return undefined;
    let pending = icons.get(appPath);
    if (!pending) {
        pending = (async () => {
            // macOS getFileIcon can return the generic application document icon.
            // Read the bundle-declared icon, including binary Info.plist files.
            try {
                const { stdout } = await promisify(execFile)('/usr/bin/plutil', [
                    '-extract',
                    'CFBundleIconFile',
                    'raw',
                    '-o',
                    '-',
                    path.join(appPath, 'Contents', 'Info.plist'),
                ], { timeout: 1500, maxBuffer: 16384 });
                const name = stdout.trim();
                if (name && path.basename(name) === name) {
                    const iconPath = path.join(appPath, 'Contents', 'Resources', path.extname(name) ? name : `${name}.icns`);
                    // Decode ICNS through macOS: Electron may select an empty small-size
                    // representation even when the bundle's full-resolution icon is valid.
                    const directory = await mkdtemp(path.join(os.tmpdir(), 'mcode-app-icon-'));
                    try {
                        const output = path.join(directory, 'icon.png');
                        await promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'png', iconPath, '--out', output], { timeout: 1500, maxBuffer: 16384 });
                        const icon = nativeImage.createFromBuffer(await readFile(output));
                        if (!icon.isEmpty())
                            return icon.resize({ width: 32, height: 32 }).toDataURL();
                    }
                    finally {
                        await rm(directory, { recursive: true, force: true });
                    }
                }
            }
            catch {
                /* Some bundles use an asset catalog instead. */
            }
            const icon = await app.getFileIcon(appPath, { size: 'normal' });
            return icon.isEmpty() ? undefined : icon.toDataURL();
        })().catch(() => undefined);
        icons.set(appPath, pending);
        const oldest = icons.keys().next().value;
        if (icons.size > 32 && oldest)
            icons.delete(oldest);
    }
    return pending;
}
export function publishCuaPreviewTarget(target) {
    if (process.platform !== 'darwin')
        return;
    const previous = targets.get(target.sessionId);
    if (previous &&
        previous.kind === target.kind &&
        previous.windowId === target.windowId &&
        previous.pid === target.pid &&
        previous.turnId === target.turnId &&
        previous.appName === target.appName &&
        previous.appPath === target.appPath)
        return;
    targets.set(target.sessionId, { ...target, revision: ++revision });
    const oldest = targets.keys().next().value;
    if (targets.size > 32 && oldest)
        targets.delete(oldest);
    if (isDev)
        logger.info('target_changed', { ...target, revision });
}
/** A late release from an older turn must not clear a newer target. */
export function releaseCuaPreviewTarget(sessionId, turnId) {
    for (const [id, target] of targets) {
        if ((!sessionId || id === sessionId) && (!turnId || target.turnId === turnId)) {
            targets.delete(id);
        }
    }
}
export function clearCuaPreviewTargets() {
    targets.clear();
    icons.clear();
}
export function selectCuaPreviewSource(target, sources, primaryDisplayId) {
    // The current desktop action facade is primary-display scoped, regardless
    // of which display contains our own app or the user's mouse pointer.
    return target.kind === 'desktop'
        ? sources.find((source) => source.id.startsWith('screen:') && source.display_id === String(primaryDisplayId))
        : sources.find((source) => source.id.split(':')[0] === 'window' &&
            source.id.split(':')[1] === String(target.windowId));
}
/** Never accepts a renderer-chosen source/window id. */
export async function inspectCuaPreview(sessionId, capture) {
    const target = targets.get(sessionId);
    if (!target || process.platform !== 'darwin')
        return null;
    const metadata = {
        ...target,
        sourceId: undefined,
        icon: await appIcon(target.appPath),
        available: false,
        unavailableReason: undefined,
    };
    if (targets.get(sessionId) !== target)
        return null;
    if (!capture)
        return metadata;
    // Preview runs in this Desktop process; the Computer Use component grant does not cover it.
    const permission = getScreenPermissionStatus();
    if (permission !== 'granted') {
        logger.warn('desktop_screen_permission_missing', {
            sessionId,
            revision: target.revision,
            permission,
        });
        return { ...metadata, unavailableReason: 'desktop-screen-permission' };
    }
    try {
        const sources = await desktopCapturer.getSources({
            types: [target.kind === 'desktop' ? 'screen' : 'window'],
            thumbnailSize: { width: 0, height: 0 },
            fetchWindowIcons: !metadata.icon && target.kind === 'window',
        });
        if (targets.get(sessionId) !== target)
            return null;
        const source = selectCuaPreviewSource(target, sources, screen.getPrimaryDisplay().id);
        if (!source)
            return metadata;
        return {
            ...metadata,
            available: true,
            sourceId: source.id,
            icon: metadata.icon ??
                (source.appIcon && !source.appIcon.isEmpty()
                    ? source.appIcon.resize({ width: 32, height: 32 }).toDataURL()
                    : undefined),
        };
    }
    catch (error) {
        logger.warn('capture_source_unavailable', {
            sessionId,
            revision: target.revision,
            error: String(error),
        });
        return metadata;
    }
}
