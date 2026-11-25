import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const SCREENCAPTURE = '/usr/sbin/screencapture';
const SNAPSHOT_TIMEOUT_MS = 3000;
/** Width and height from a PNG IHDR chunk, or undefined for anything else. */
function pngSize(bytes) {
    if (bytes.length < 24 || bytes.toString('ascii', 12, 16) !== 'IHDR')
        return undefined;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
/**
 * Frozen frame of one display, taken with the macOS screenshot tool.
 *
 * ScreenCaptureKit display captures (desktopCapturer thumbnails) drop window shadows and
 * borders, so overlapping windows merge into one surface. `screencapture` keeps them, uses
 * the same Screen Recording permission and returns native pixels. Resolves null on other
 * platforms or on any failure, so the caller keeps the desktopCapturer thumbnail.
 */
export async function captureNativeDisplaySnapshot(display, signal) {
    if (process.platform !== 'darwin' || signal?.aborted)
        return null;
    const { x, y, width, height } = display.bounds;
    const file = path.join(os.tmpdir(), `mcode-capture-${randomUUID()}.png`);
    try {
        await new Promise((resolve, reject) => {
            const child = execFile(SCREENCAPTURE, ['-x', '-t', 'png', `-R${x},${y},${width},${height}`, file], { timeout: SNAPSHOT_TIMEOUT_MS, signal }, (error) => {
                // Abort reports an error before the child necessarily exits. Wait before unlinking,
                // otherwise the tool could create its PNG after cleanup has already run.
                if (signal?.aborted && child.exitCode === null && child.signalCode === null)
                    child.once('close', () => reject(error));
                else if (error)
                    reject(error);
                else
                    resolve();
            });
        });
        const bytes = await readFile(file, { signal });
        const size = pngSize(bytes);
        // A different size means a different display or scale; never stretch it under the overlay.
        if (!size ||
            size.width !== Math.round(width * display.scaleFactor) ||
            size.height !== Math.round(height * display.scaleFactor))
            return null;
        return `data:image/png;base64,${bytes.toString('base64')}`;
    }
    catch {
        return null;
    }
    finally {
        await unlink(file).catch(() => undefined);
    }
}
