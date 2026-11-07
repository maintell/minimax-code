/** Matches Chromium's maximum single-capture texture height. */
export let WEBVIEW_FULL_PAGE_MAX_HEIGHT_PX = 16384;
const MAX_TILES = 64;
const CAPTURE_TIMEOUT_MS = 8000;
// `behavior: 'instant'` bypasses `scroll-behavior: smooth`; two frames let the
// compositor present the new scroll offset before the viewport is captured.
// An in-flight smooth scroll can still move the offset once, so re-apply until
// it settles on the clamped target.
const scrollExpression = (y) => `(async () => {
  const root = document.scrollingElement || document.documentElement;
  const target = Math.min(${y}, Math.max(0, root.scrollHeight - window.innerHeight));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    window.scrollTo({ left: 0, top: target, behavior: 'instant' });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 150);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
    });
    if (Math.abs(window.scrollY - target) < 1) break;
  }
  return window.scrollY;
})()`;
async function evaluate(cdp, expression) {
    const result = (await cdp.sendCommand('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
    }));
    if (result.exceptionDetails)
        throw new Error('Full-page scroll script failed');
    return result.result?.value;
}
async function captureViewport(cdp, deps) {
    const result = (await cdp.sendCommand('Page.captureScreenshot', { format: 'png' }, CAPTURE_TIMEOUT_MS));
    if (!result.data)
        throw new Error('SCREENSHOT_EMPTY');
    return deps.decodePng(result.data);
}
/**
 * Full-page capture for `<webview>` guests.
 *
 * Chromium's guest view ignores `captureBeyondViewport` and viewport metric
 * overrides: the compositor only produces the visible frame, so a tall clip is
 * filled by repeating the first screen. Scrolling the guest and stitching
 * viewport captures yields the real page. Fixed/sticky elements repeat on each
 * tile, the same trade-off as other scroll-stitch capturers.
 */
export async function captureWebviewFullPage(cdp, deps) {
    const metrics = (await cdp.sendCommand('Page.getLayoutMetrics'));
    const content = metrics.cssContentSize ?? metrics.contentSize;
    const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
    const viewportHeight = Math.max(1, Math.floor(viewport?.clientHeight ?? 1));
    const pageHeight = Math.max(viewportHeight, Math.ceil(content?.height ?? viewportHeight));
    if (pageHeight <= viewportHeight) {
        const tile = await captureViewport(cdp, deps);
        return { data: deps.encodePng(tile), width: tile.width, height: tile.height };
    }
    const original = await evaluate(cdp, '[window.scrollX, window.scrollY]');
    const rows = [];
    let outputWidth = 0;
    let outputHeight = 0;
    try {
        let nextY = 0;
        for (let index = 0; index < MAX_TILES && nextY < pageHeight; index += 1) {
            const scrollY = Math.max(0, Math.round(await evaluate(cdp, scrollExpression(nextY))));
            // The last tile is clamped to the page bottom, so skip rows already copied.
            // An overshoot (e.g. scroll snapping) leaves a seam instead of failing the capture.
            const skipCss = Math.max(0, nextY - scrollY);
            if (skipCss >= viewportHeight)
                break;
            const tile = await captureViewport(cdp, deps);
            if (outputWidth === 0)
                outputWidth = tile.width;
            const scale = tile.height / viewportHeight;
            const visibleCss = Math.min(viewportHeight, pageHeight - scrollY);
            const startRow = Math.round(skipCss * scale);
            const endRow = Math.min(tile.height, Math.round(visibleCss * scale), startRow + WEBVIEW_FULL_PAGE_MAX_HEIGHT_PX - outputHeight);
            const rowBytes = outputWidth * 4;
            const tileRowBytes = tile.width * 4;
            for (let row = startRow; row < endRow; row += 1) {
                const line = Buffer.alloc(rowBytes);
                tile.bitmap.copy(line, 0, row * tileRowBytes, row * tileRowBytes + Math.min(rowBytes, tileRowBytes));
                rows.push(line);
            }
            outputHeight += Math.max(0, endRow - startRow);
            if (outputHeight >= WEBVIEW_FULL_PAGE_MAX_HEIGHT_PX)
                break;
            nextY = scrollY + viewportHeight;
        }
    }
    finally {
        await evaluate(cdp, `window.scrollTo({ left: ${Number(original?.[0]) || 0}, top: ${Number(original?.[1]) || 0}, behavior: 'instant' })`).catch(() => undefined);
    }
    if (outputHeight === 0)
        throw new Error('SCREENSHOT_EMPTY');
    const stitched = { width: outputWidth, height: outputHeight, bitmap: Buffer.concat(rows) };
    return { data: deps.encodePng(stitched), width: outputWidth, height: outputHeight };
}
