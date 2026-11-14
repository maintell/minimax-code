import { withTimeout } from "@mavis/browser-core";
import { withAgentCursorHiddenForCapture } from "./embedded-browser-agent-cursor";
const CAPTURE_TIMEOUT_MS = 600;
const MAX_WIDTH_PX = 1200;
const MAX_HEIGHT_PX = 900;
/** Capture only the visible, loaded Mini App page; never fetch or re-render its data. */
export async function captureMiniAppPageSnapshot(tab, isCurrent) {
    const contents = tab.controller.getWebContents();
    if (!contents || !tab.miniApp)
        return null;
    const runId = tab.miniApp.runId;
    const pageUrl = contents.getURL();
    const current = () => {
        if (!isCurrent() || contents.isDestroyed() || tab.controller.getWebContents() !== contents)
            return false;
        if (tab.miniApp?.runId !== runId || contents.getURL() !== pageUrl)
            return false;
        if (tab.lastLoadError || contents.isLoadingMainFrame() || tab.hiddenAt !== null)
            return false;
        if (tab.bounds.width <= 0 || tab.bounds.height <= 0)
            return false;
        if (tab.detachedWindow?.isMinimized() || tab.detachedWindow?.isDestroyed())
            return false;
        try {
            return new URL(pageUrl).origin === tab.miniApp.origin;
        }
        catch {
            return false;
        }
    };
    try {
        if (!current())
            return null;
        const capturedAt = Date.now();
        return await withTimeout(async () => {
            const captured = await withAgentCursorHiddenForCapture(tab, () => contents.capturePage());
            if (!current() || captured.isEmpty())
                return null;
            const image = tab.controller.normalizeCapturedImage?.(captured) ?? captured;
            const { width, height } = image.getSize();
            if (!width || !height)
                return null;
            const scale = Math.min(1, MAX_WIDTH_PX / width, MAX_HEIGHT_PX / height);
            const resized = scale < 1
                ? image.resize({
                    width: Math.max(1, Math.round(width * scale)),
                    height: Math.max(1, Math.round(height * scale)),
                })
                : image;
            const dataUrl = `data:image/jpeg;base64,${resized.toJPEG(80).toString('base64')}`;
            return dataUrl.length <= 500000 ? { dataUrl, capturedAt } : null;
        }, CAPTURE_TIMEOUT_MS, 'miniapp-page-preview');
    }
    catch {
        // A missing/late frame must not delay closing or replace the last usable snapshot.
        return null;
    }
}
