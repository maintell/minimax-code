import { BrowserWindow, ipcMain } from "electron";
import { execFile } from "child_process";
import { promises } from "fs";
import path from "path";
import os from "os";
import { IPC_CHANNELS } from "../config/constants";
import { getPPTPreviewViewController } from "../modules/ppt-preview/index";
import { pptHtmlPreviewCache } from "../modules/ppt-preview/html-preview-cache";
import { normalizeQuickLookHtml } from "../modules/ppt-preview/html-preview-processing";
import { renderQuickLookSlideImages } from "../modules/ppt-preview/slide-image-renderer";
import logger from "../utils/logger";
import { documentPreviewSourceRegistry } from "../modules/document-preview/runtime";
// ---------------------------------------------------------------------------
// HTML preview cache: filePath → processed QuickLook HTML in a process-local LRU cache.
// Avoids re-running qlmanage + sips for the same unmodified file.
// ---------------------------------------------------------------------------
const ORIGINAL_HTML_FILE = 'Preview.html';
const PROCESSED_HTML_FILE = 'Preview.processed.html';
const RASTER_HTML_FILE = 'Preview.raster.html';
const HTML_PREVIEW_PROCESSOR_VERSION = 8;
const PDF_CONVERSION_CONCURRENCY = 4;
let currentLoadedHtmlFilePath = null;
function elapsedMs(startMs) {
    return Date.now() - startMs;
}
function isTruthyDebugValue(value) {
    return /^(1|true|yes|on)$/iu.test(String(value ?? '').trim());
}
function isPptPreviewDebugEnabled() {
    return (isTruthyDebugValue(process.env.MAVIS_PPT_DEBUG) ||
        isTruthyDebugValue(process.env.MAVIS_PPT_PREVIEW_DEBUG) ||
        isTruthyDebugValue(process.env.MAVIS_PPT_SELECTION_DEBUG));
}
function safePreviewText(value, fallback = '[redacted-sensitive-value]') {
    const message = String(value);
    if (message.length > 1024 ||
        /[/\\<\u0000-\u001f\u007f-\u009f]/u.test(message) ||
        /(?:file|data):/iu.test(message)) {
        return fallback;
    }
    return message;
}
function preserveStagedSource(value) {
    return (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        value.preserveSource === true);
}
function logPreviewTiming(stage, data) {
    if (!isPptPreviewDebugEnabled())
        return;
    const redacted = Object.fromEntries(Object.entries(data).map(([key, value]) => [
        key,
        typeof value === 'string' ? safePreviewText(value) : value,
    ]));
    logger.info({ msg: '[PPTPreviewTiming]', stage, ...redacted });
}
async function mapWithConcurrency(items, limit, task) {
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, limit), items.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            const item = items[index];
            if (item === undefined)
                continue;
            await task(item, index);
        }
    }));
}
// ---------------------------------------------------------------------------
// PDF → PNG conversion using macOS built-in `sips` (zero external deps)
// ---------------------------------------------------------------------------
/**
 * Convert a single PDF file to PNG using macOS `sips`.
 * Produces RGBA PNG with alpha channel preserved.
 */
async function convertPdfToPng(pdfPath, pngPath) {
    return new Promise((resolve, reject) => {
        execFile('sips', ['-s', 'format', 'png', pdfPath, '--out', pngPath], { timeout: 15000 }, (error, _stdout, stderr) => {
            if (error) {
                reject(new Error(`sips failed: ${stderr || error.message}`));
                return;
            }
            resolve();
        });
    });
}
/**
 * Run qlmanage -p to generate HTML preview, then convert PDF attachments to PNG.
 * Returns the processed HTML file path.
 */
async function generateHtmlPreview(filePath, keepProcessedHtmlPaths = [], options = {}) {
    const totalStartMs = Date.now();
    logPreviewTiming('generate:start', {
        filePath,
        processorVersion: HTML_PREVIEW_PROCESSOR_VERSION,
    });
    // macOS only
    if (process.platform !== 'darwin') {
        logPreviewTiming('generate:unsupported-platform', {
            filePath,
            platform: process.platform,
            totalMs: elapsedMs(totalStartMs),
        });
        return { success: false, error: 'qlmanage is only available on macOS' };
    }
    // ---- Cache check ----
    const cacheStartMs = Date.now();
    let sourceStat = null;
    try {
        const stat = await promises.stat(filePath);
        sourceStat = { mtimeMs: stat.mtimeMs, size: stat.size };
        const memoryCached = await pptHtmlPreviewCache.lookup(filePath, sourceStat, HTML_PREVIEW_PROCESSOR_VERSION, { keepProcessedHtmlPaths });
        if (memoryCached.hit) {
            const needsSlideImages = options.renderSlideImages && !memoryCached.entry.slideImages?.length;
            if (needsSlideImages) {
                logPreviewTiming('generate:cache-hit-missing-slide-images', {
                    filePath,
                    processedHtmlPath: memoryCached.entry.processedHtmlPath,
                });
            }
            if (!needsSlideImages) {
                const { entry } = memoryCached;
                logger.info('[PPTPreview] Cache hit');
                logPreviewTiming('generate:cache-hit', {
                    filePath,
                    processedHtmlPath: entry.processedHtmlPath,
                    rasterHtmlPath: entry.rasterHtmlPath,
                    slideImageCount: entry.slideImages?.length ?? 0,
                    slideCount: entry.slideCount,
                    source: 'memory',
                    cacheCheckMs: elapsedMs(cacheStartMs),
                    totalMs: elapsedMs(totalStartMs),
                });
                return {
                    success: true,
                    processedHtmlPath: entry.processedHtmlPath,
                    rasterHtmlPath: entry.rasterHtmlPath,
                    slideImages: entry.slideImages,
                    slideCount: entry.slideCount,
                };
            }
        }
        else if (memoryCached.reason === 'miss:cached-file-missing') {
            logPreviewTiming('generate:cache-miss', {
                filePath,
                reason: memoryCached.reason,
                error: memoryCached.error,
                cacheCheckMs: elapsedMs(cacheStartMs),
            });
        }
        else {
            logPreviewTiming('generate:cache-miss', {
                filePath,
                reason: memoryCached.reason,
                cacheCheckMs: elapsedMs(cacheStartMs),
            });
        }
    }
    catch (error) {
        // stat failed — file doesn't exist, will fail below
        logPreviewTiming('generate:cache-miss', {
            filePath,
            reason: 'stat-failed',
            error: safePreviewText(error, 'PPT preview source stat failed'),
            cacheCheckMs: elapsedMs(cacheStartMs),
        });
    }
    // ---- Generate ----
    const tmpDir = path.join(os.tmpdir(), `ql_preview_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const tmpStartMs = Date.now();
    await promises.mkdir(tmpDir, { recursive: true });
    logPreviewTiming('generate:tmp-created', {
        filePath,
        tmpDir,
        ms: elapsedMs(tmpStartMs),
    });
    return new Promise((resolve) => {
        const qlmanageStartMs = Date.now();
        execFile('qlmanage', ['-p', filePath, '-o', tmpDir, '-z'], { timeout: 30000 }, async (qlError, stdout, stderr) => {
            const qlmanageMs = elapsedMs(qlmanageStartMs);
            logPreviewTiming('generate:qlmanage-complete', {
                filePath,
                tmpDir,
                ms: qlmanageMs,
                exitError: Boolean(qlError),
                stdoutBytes: stdout.length,
                stderrBytes: stderr.length,
            });
            // NOTE: qlmanage often exits with non-zero even on success.
            // Ignore the exit code — check for output directory instead.
            try {
                // Find the .qlpreview directory
                const resolveOutputStartMs = Date.now();
                const entries = await promises.readdir(tmpDir);
                let qlDirPath;
                const qlEntry = entries.find((e) => e.endsWith('.qlpreview'));
                if (qlEntry) {
                    qlDirPath = path.join(tmpDir, qlEntry);
                }
                else if (entries.length > 0) {
                    qlDirPath = tmpDir;
                }
                else {
                    const match = (stderr + stdout).match(/([^\s]+\.qlpreview)/);
                    if (match) {
                        qlDirPath = match[1];
                    }
                    else {
                        throw new Error('qlmanage produced no output directory');
                    }
                }
                logPreviewTiming('generate:resolve-output', {
                    filePath,
                    qlDirPath,
                    entryCount: entries.length,
                    ms: elapsedMs(resolveOutputStartMs),
                });
                const htmlFile = path.join(qlDirPath, ORIGINAL_HTML_FILE);
                const readHtmlStartMs = Date.now();
                let htmlContent = await promises.readFile(htmlFile, 'utf-8');
                const slideCount = (htmlContent.match(/<div class="slide"/g) || []).length;
                logPreviewTiming('generate:read-html', {
                    filePath,
                    htmlFile,
                    slideCount,
                    htmlBytes: Buffer.byteLength(htmlContent, 'utf-8'),
                    ms: elapsedMs(readHtmlStartMs),
                });
                const normalizeHtmlStartMs = Date.now();
                htmlContent = normalizeQuickLookHtml(htmlContent);
                logPreviewTiming('generate:normalize-html', {
                    filePath,
                    ms: elapsedMs(normalizeHtmlStartMs),
                });
                // Convert all *.pdf img sources to PNG using sips
                const pdfMatches = [...htmlContent.matchAll(/<img[^>]+src="([^"]+\.pdf)"/gi)];
                const pdfRelPaths = [
                    ...new Set(pdfMatches
                        .map((match) => match[1])
                        .filter((value) => Boolean(value))),
                ];
                const pdfConvertStartMs = Date.now();
                let convertedPdfCount = 0;
                let failedPdfCount = 0;
                const convertedPdfRelPaths = new Set();
                await mapWithConcurrency(pdfRelPaths, PDF_CONVERSION_CONCURRENCY, async (pdfRelPath) => {
                    const pdfAbsPath = path.join(qlDirPath, pdfRelPath);
                    const pngBaseName = pdfRelPath.replace(/\.pdf$/i, '.png');
                    const pngAbsPath = path.join(qlDirPath, pngBaseName);
                    try {
                        const singlePdfStartMs = Date.now();
                        await promises.access(pdfAbsPath);
                        await convertPdfToPng(pdfAbsPath, pngAbsPath);
                        convertedPdfCount += 1;
                        convertedPdfRelPaths.add(pdfRelPath);
                        logPreviewTiming('generate:pdf-converted', {
                            filePath,
                            pdfRelPath,
                            ms: elapsedMs(singlePdfStartMs),
                        });
                    }
                    catch (pdfErr) {
                        failedPdfCount += 1;
                        logger.warn({
                            msg: `[PPTPreview] Failed to convert PDF: ${pdfRelPath}`,
                            error: safePreviewText(pdfErr, 'PPT preview PDF conversion failed'),
                        });
                    }
                });
                for (const pdfRelPath of convertedPdfRelPaths) {
                    const escapedSrc = pdfRelPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    htmlContent = htmlContent.replace(new RegExp(`src="${escapedSrc}"`, 'g'), `src="${pdfRelPath.replace(/\.pdf$/i, '.png')}"`);
                }
                logPreviewTiming('generate:pdf-convert-complete', {
                    filePath,
                    pdfCount: pdfMatches.length,
                    convertedPdfCount,
                    failedPdfCount,
                    ms: elapsedMs(pdfConvertStartMs),
                });
                const rasterPath = path.join(qlDirPath, RASTER_HTML_FILE);
                let slideImages = [];
                const rasterHtmlStartMs = Date.now();
                await promises.writeFile(rasterPath, htmlContent);
                logPreviewTiming('generate:write-raster-html', {
                    filePath,
                    rasterPath,
                    rasterHtmlBytes: Buffer.byteLength(htmlContent, 'utf-8'),
                    ms: elapsedMs(rasterHtmlStartMs),
                });
                if (options.renderSlideImages) {
                    const renderSlideImagesStartMs = Date.now();
                    slideImages = await renderQuickLookSlideImages({
                        htmlFilePath: rasterPath,
                        outputDir: path.join(qlDirPath, 'slide-images'),
                    });
                    logPreviewTiming('generate:slide-images-complete', {
                        filePath,
                        rasterPath,
                        slideImageCount: slideImages.length,
                        ms: elapsedMs(renderSlideImagesStartMs),
                    });
                }
                // Inject responsive scaling so QuickLook slides fit the WebContentsView width.
                // Keep body as a stable viewport and transform a dedicated stage instead of body
                // itself; body transforms make Chromium's layout/cropping disagree with the visual
                // position and can leave PPT slides horizontally offset.
                const responsiveSnippet = `
<!-- mavis-ppt-preview-processor:${HTML_PREVIEW_PROCESSOR_VERSION} -->
<style id="mavis-ppt-fit-style">
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    min-width: 0 !important;
    width: 100% !important;
    overflow-x: hidden !important;
    background: #f5f7fb !important;
  }
  html, body { min-height: 100%; }
  body { position: relative !important; }
  #mavis-ppt-stage {
    position: relative;
    transform-origin: top left;
    will-change: transform;
  }
  #mavis-ppt-stage .slide,
  #mavis-ppt-stage .loading-slide {
    margin-left: 0 !important;
    margin-right: 0 !important;
    margin-bottom: 0 !important;
    -webkit-box-shadow: none !important;
    box-shadow: none !important;
  }
  #mavis-ppt-stage .slide {
    margin-top: 12px !important;
  }
  #mavis-ppt-stage .slide:first-of-type {
    margin-top: 0 !important;
  }
  #mavis-ppt-stage .slide {
    background-clip: padding-box !important;
  }
</style>`;
                // Inject before closing </body> or append to end
                const processHtmlStartMs = Date.now();
                if (htmlContent.includes('</body>')) {
                    htmlContent = htmlContent.replace('</body>', responsiveSnippet + '\n</body>');
                }
                else {
                    htmlContent += responsiveSnippet;
                }
                // Write processed HTML
                const processedPath = path.join(qlDirPath, PROCESSED_HTML_FILE);
                await promises.writeFile(processedPath, htmlContent);
                logPreviewTiming('generate:process-html', {
                    filePath,
                    processedPath,
                    processedHtmlBytes: Buffer.byteLength(htmlContent, 'utf-8'),
                    ms: elapsedMs(processHtmlStartMs),
                });
                // Update the process-local preview cache
                const cacheUpdateStartMs = Date.now();
                try {
                    const stat = sourceStat ?? (await promises.stat(filePath));
                    const cacheStat = { mtimeMs: stat.mtimeMs, size: stat.size };
                    await pptHtmlPreviewCache.put({
                        filePath,
                        processedHtmlPath: processedPath,
                        rasterHtmlPath: rasterPath,
                        tmpDir,
                        mtimeMs: cacheStat.mtimeMs,
                        size: cacheStat.size,
                        processorVersion: HTML_PREVIEW_PROCESSOR_VERSION,
                        slideCount,
                        slideImages,
                    }, { keepProcessedHtmlPaths: [...keepProcessedHtmlPaths, processedPath] });
                    logPreviewTiming('generate:cache-updated', {
                        filePath,
                        processedPath,
                        rasterPath,
                        slideImageCount: slideImages.length,
                        ms: elapsedMs(cacheUpdateStartMs),
                    });
                }
                catch {
                    // stat failed, skip caching
                    logPreviewTiming('generate:cache-update-skipped', {
                        filePath,
                        ms: elapsedMs(cacheUpdateStartMs),
                    });
                }
                logPreviewTiming('generate:success', {
                    filePath,
                    processedPath,
                    rasterPath,
                    slideCount,
                    slideImageCount: slideImages.length,
                    pdfCount: pdfMatches.length,
                    qlmanageMs,
                    totalMs: elapsedMs(totalStartMs),
                });
                resolve({
                    success: true,
                    processedHtmlPath: processedPath,
                    rasterHtmlPath: rasterPath,
                    slideImages,
                    slideCount,
                });
            }
            catch (err) {
                await promises.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
                logPreviewTiming('generate:error', {
                    filePath,
                    tmpDir,
                    qlmanageMs,
                    totalMs: elapsedMs(totalStartMs),
                    error: safePreviewText(err, 'PPT preview generation failed'),
                });
                resolve({ success: false, error: safePreviewText(err, 'PPT preview generation failed') });
            }
        });
    });
}
export function cleanupPPTPreviewCache() {
    pptHtmlPreviewCache.clearSync();
}
async function loadPreviewFromPath(filePath, options, context = { filePath }) {
    const totalStartMs = Date.now();
    try {
        const preferSlideImages = options?.renderMode === 'images';
        logPreviewTiming('load:start', { filePath, renderMode: options?.renderMode ?? 'html' });
        const generateStartMs = Date.now();
        const htmlResult = await generateHtmlPreview(filePath, [currentLoadedHtmlFilePath], {
            renderSlideImages: preferSlideImages,
        });
        logPreviewTiming('load:generate-complete', {
            filePath,
            success: htmlResult.success,
            processedHtmlPath: htmlResult.processedHtmlPath,
            rasterHtmlPath: htmlResult.rasterHtmlPath,
            slideImageCount: htmlResult.slideImages?.length ?? 0,
            slideCount: htmlResult.slideCount,
            ms: elapsedMs(generateStartMs),
        });
        if (!htmlResult.success || !htmlResult.processedHtmlPath) {
            logPreviewTiming('load:error', {
                filePath,
                totalMs: elapsedMs(totalStartMs),
                error: htmlResult.error || 'Failed to generate HTML preview',
            });
            return { success: false, error: htmlResult.error || 'Failed to generate HTML preview' };
        }
        if (preferSlideImages) {
            if (htmlResult.slideImages?.length) {
                await pptHtmlPreviewCache.prune({ keepProcessedHtmlPath: currentLoadedHtmlFilePath });
                logPreviewTiming('load:success', {
                    filePath,
                    renderer: 'images',
                    slideCount: htmlResult.slideCount,
                    slideImageCount: htmlResult.slideImages.length,
                    totalMs: elapsedMs(totalStartMs),
                });
                return {
                    success: true,
                    renderer: 'images',
                    slideCount: htmlResult.slideCount,
                    slideImages: htmlResult.slideImages,
                };
            }
            logPreviewTiming('load:error', {
                filePath,
                renderer: 'images',
                totalMs: elapsedMs(totalStartMs),
                error: 'Failed to render slide images',
            });
            return {
                success: false,
                error: 'Failed to render slide images',
                slideCount: htmlResult.slideCount,
            };
        }
        const controller = getPPTPreviewViewController();
        const loadHtmlStartMs = Date.now();
        const loadResult = await controller.loadHTML(htmlResult.processedHtmlPath, {
            ...context,
            slideCount: htmlResult.slideCount,
        });
        logPreviewTiming('load:webcontents-complete', {
            filePath,
            processedHtmlPath: htmlResult.processedHtmlPath,
            success: loadResult.success,
            ms: elapsedMs(loadHtmlStartMs),
        });
        if (!loadResult.success) {
            await pptHtmlPreviewCache.prune({ keepProcessedHtmlPath: currentLoadedHtmlFilePath });
            logPreviewTiming('load:error', {
                filePath,
                totalMs: elapsedMs(totalStartMs),
                error: loadResult.error,
            });
            return loadResult;
        }
        currentLoadedHtmlFilePath = path.resolve(htmlResult.processedHtmlPath);
        await pptHtmlPreviewCache.prune({ keepProcessedHtmlPath: currentLoadedHtmlFilePath });
        logPreviewTiming('load:success', {
            filePath,
            slideCount: htmlResult.slideCount,
            totalMs: elapsedMs(totalStartMs),
        });
        return { success: true, renderer: 'html', slideCount: htmlResult.slideCount };
    }
    catch (error) {
        logger.error({ msg: '[PPTPreview] ppt-preview:load failed' });
        logPreviewTiming('load:error', {
            filePath,
            totalMs: elapsedMs(totalStartMs),
            error: 'PPT preview load failed',
        });
        return { success: false, error: safePreviewText(error, 'PPT preview load failed') };
    }
}
async function removeSlideImagePaths(result) {
    if (!result.slideImages?.length)
        return result;
    const slideImages = await Promise.all(result.slideImages.map(async (slide) => {
        const png = await promises.readFile(slide.imagePath);
        return {
            ...slide,
            imagePath: '',
            imageUrl: `data:image/png;base64,${png.toString('base64')}`,
        };
    }));
    return { ...result, slideImages };
}
// ---------------------------------------------------------------------------
// IPC setup
// ---------------------------------------------------------------------------
export function setupPPTPreviewIPC(options = {}) {
    const registry = options.registry ?? documentPreviewSourceRegistry;
    const loadPreview = options.loadPreview ?? loadPreviewFromPath;
    const currentSourceBySender = new WeakMap();
    const currentRasterRequestBySender = new WeakMap();
    const boundSourceSenders = new WeakSet();
    const destroyedSourceSenders = new WeakSet();
    let nextLoadId = 0;
    const ownerRequired = { success: false, error: 'PPT preview owner required' };
    const getOwnedController = (sender) => {
        const controller = getPPTPreviewViewController();
        return controller.isOwnedBy(sender) ? controller : null;
    };
    const isTopLevelRenderer = (sender) => {
        const mainWindow = BrowserWindow.fromWebContents(sender);
        return Boolean(mainWindow && mainWindow.webContents === sender);
    };
    const rasterRequestIsLive = (sender, expected) => {
        const current = currentRasterRequestBySender.get(sender);
        const copyIsLive = expected.kind === 'legacy'
            ? registry.isLegacyCopyLive(sender.id, expected.sourceId, expected.generation, sender)
            : registry.isSanitizedCopyLive(sender.id, expected.sourceId, expected.generation, sender);
        return Boolean(!destroyedSourceSenders.has(sender) &&
            isTopLevelRenderer(sender) &&
            copyIsLive &&
            current?.sourceId === expected.sourceId &&
            current.generation === expected.generation &&
            current.kind === expected.kind &&
            current.loadId === expected.loadId);
    };
    // A sender can issue overlapping loads while the previous conversion is
    // still in flight. Only clear the map when the completion belongs to the
    // entry that is still current; an older request must not remove a newer
    // request's ownership record.
    const clearCurrentSourceIfMatches = (sender, expected) => {
        const current = currentSourceBySender.get(sender);
        if (current?.sourceId === expected.sourceId &&
            current.generation === expected.generation &&
            current.kind === expected.kind &&
            current.loadId === expected.loadId) {
            currentSourceBySender.delete(sender);
        }
    };
    const deleteStagedCopy = async (sender, sourceId, kind) => {
        if (kind === 'legacy' && typeof registry.deleteLegacyCopy === 'function') {
            await registry.deleteLegacyCopy(sender.id, sourceId, sender);
        }
        else {
            await registry.deleteSanitizedCopy(sender.id, sourceId, sender);
        }
    };
    const bindSourceSender = (sender) => {
        if (boundSourceSenders.has(sender))
            return;
        boundSourceSenders.add(sender);
        sender.once('destroyed', () => {
            destroyedSourceSenders.add(sender);
            currentRasterRequestBySender.delete(sender);
            const current = currentSourceBySender.get(sender);
            if (current) {
                deleteStagedCopy(sender, current.sourceId, current.kind).catch((error) => {
                    logger.warn('[PPTPreview] Staged copy cleanup failed on sender teardown', {
                        sourceId: current.sourceId,
                        kind: current.kind,
                        error: error instanceof Error ? error.message : String(error),
                    });
                });
            }
            currentSourceBySender.delete(sender);
            currentLoadedHtmlFilePath = null;
            void pptHtmlPreviewCache.prune();
            const controller = getPPTPreviewViewController();
            if (controller.isOwnedBy(sender))
                controller.destroy();
        });
    };
    // ---- PPT Preview WebContentsView IPC ----
    ipcMain.handle(IPC_CHANNELS.PPT_PREVIEW_CREATE, async (event, bounds, viewport) => {
        const mainWindow = BrowserWindow.fromWebContents(event.sender);
        if (!mainWindow)
            return { success: false, error: 'Main window not found' };
        if (mainWindow.webContents !== event.sender)
            return ownerRequired;
        const controller = getPPTPreviewViewController();
        const result = await controller.create(mainWindow, bounds, viewport);
        if (result.success)
            controller.bringToFront();
        return result;
    });
    ipcMain.handle(IPC_CHANNELS.PPT_PREVIEW_LOAD, async (event) => {
        if (!getOwnedController(event.sender))
            return ownerRequired;
        return { success: false, error: 'Opaque PPT preview source required' };
    });
    ipcMain.handle(IPC_CHANNELS.PPT_PREVIEW_RENDER_SLIDES, async (event, sourceId) => {
        if (!isTopLevelRenderer(event.sender)) {
            return { success: false, error: 'PPT preview top-level renderer required' };
        }
        bindSourceSender(event.sender);
        if (destroyedSourceSenders.has(event.sender)) {
            return { success: false, error: 'Opaque PPT preview source is unavailable' };
        }
        const entry = registry.resolveForBackend(event.sender.id, sourceId, event.sender);
        if (!entry) {
            return { success: false, error: 'Opaque PPT preview source is unavailable' };
        }
        const legacyLease = typeof registry.acquireLegacyCopy === 'function'
            ? registry.acquireLegacyCopy(event.sender.id, sourceId, event.sender)
            : null;
        const sanitizedLease = legacyLease
            ? null
            : registry.acquireSanitizedCopy(event.sender.id, sourceId, event.sender);
        const lease = legacyLease ?? sanitizedLease;
        const stagedKind = legacyLease ? 'legacy' : 'sanitized';
        if (!lease) {
            return { success: false, error: 'Opaque PPT preview source is unavailable' };
        }
        const currentRequest = {
            sourceId,
            generation: lease.generation,
            kind: stagedKind,
            loadId: ++nextLoadId,
        };
        currentRasterRequestBySender.set(event.sender, currentRequest);
        let response;
        try {
            const result = await loadPreview(lease.path, { renderMode: 'images' }, { fileName: entry.source.fileName, mimeType: entry.source.mimeType });
            if (!rasterRequestIsLive(event.sender, currentRequest)) {
                response = { success: false, error: 'Opaque PPT preview source is unavailable' };
            }
            else if (!result.success || result.renderer !== 'images') {
                response = { success: false, error: 'Opaque PPT preview could not be rendered' };
            }
            else {
                response = await removeSlideImagePaths(result);
            }
        }
        catch {
            response = { success: false, error: 'Opaque PPT preview could not be rendered' };
        }
        const released = await lease.release();
        const completionIsLive = rasterRequestIsLive(event.sender, currentRequest);
        if (currentRasterRequestBySender.get(event.sender) === currentRequest) {
            currentRasterRequestBySender.delete(event.sender);
        }
        if (!released.ok) {
            return { success: false, error: 'Sanitized PPT preview cleanup failed' };
        }
        return completionIsLive
            ? response
            : { success: false, error: 'Opaque PPT preview source is unavailable' };
    });
    ipcMain.handle(IPC_CHANNELS.PPT_PREVIEW_LOAD_SOURCE, async (event, sourceId) => {
        if (!getOwnedController(event.sender))
            return ownerRequired;
        const entry = registry.resolveForBackend(event.sender.id, sourceId, event.sender);
        const legacyLease = typeof registry.acquireLegacyCopy === 'function'
            ? registry.acquireLegacyCopy(event.sender.id, sourceId, event.sender)
            : null;
        const sanitizedLease = legacyLease
            ? null
            : registry.acquireSanitizedCopy(event.sender.id, sourceId, event.sender);
        const lease = legacyLease ?? sanitizedLease;
        const stagedKind = legacyLease ? 'legacy' : 'sanitized';
        if (!entry || !lease) {
            return { success: false, error: 'Opaque PPT preview source is unavailable' };
        }
        const previous = currentSourceBySender.get(event.sender);
        if (previous && previous.sourceId !== sourceId) {
            await deleteStagedCopy(event.sender, previous.sourceId, previous.kind);
        }
        bindSourceSender(event.sender);
        const currentLoad = {
            sourceId,
            generation: lease.generation,
            kind: stagedKind,
            loadId: ++nextLoadId,
        };
        currentSourceBySender.set(event.sender, currentLoad);
        let response;
        try {
            const result = await loadPreview(lease.path, { renderMode: 'html' }, {
                fileName: entry.source.fileName,
                mimeType: entry.source.mimeType,
            });
            const current = currentSourceBySender.get(event.sender);
            if (!getOwnedController(event.sender) ||
                (stagedKind === 'legacy'
                    ? !registry.isLegacyCopyLive(event.sender.id, sourceId, lease.generation, event.sender)
                    : !registry.isSanitizedCopyLive(event.sender.id, sourceId, lease.generation, event.sender)) ||
                current?.sourceId !== sourceId ||
                current.generation !== lease.generation ||
                current.kind !== stagedKind ||
                current.loadId !== currentLoad.loadId) {
                clearCurrentSourceIfMatches(event.sender, currentLoad);
                response = { success: false, error: 'Opaque PPT preview source is unavailable' };
            }
            else if (!result.success) {
                response = { success: false, error: 'Opaque PPT preview could not be loaded' };
            }
            else {
                response = await removeSlideImagePaths(result);
            }
        }
        catch {
            response = { success: false, error: 'Opaque PPT preview could not be loaded' };
        }
        const released = await lease.release();
        return released.ok
            ? response
            : { success: false, error: 'Sanitized PPT preview cleanup failed' };
    });
    ipcMain.handle(IPC_CHANNELS.PPT_PREVIEW_SET_BOUNDS, (event, bounds, viewport) => {
        const controller = getOwnedController(event.sender);
        return controller ? controller.setBounds(bounds, viewport) : ownerRequired;
    });
    ipcMain.handle(IPC_CHANNELS.PPT_PREVIEW_CAPTURE_FRAME, (event) => {
        const controller = getOwnedController(event.sender);
        return controller ? controller.captureFrame() : ownerRequired;
    });
    ipcMain.handle(IPC_CHANNELS.PPT_PREVIEW_GET_DEBUG_STATE, (event) => {
        const controller = getOwnedController(event.sender);
        if (!controller)
            return ownerRequired;
        if (currentSourceBySender.has(event.sender)) {
            return { success: true, debug: { source: 'opaque-preview', renderer: 'quicklook' } };
        }
        return controller.getDebugState();
    });
    ipcMain.handle(IPC_CHANNELS.PPT_PREVIEW_SET_SELECTION_MODE, (event, options) => {
        const controller = getOwnedController(event.sender);
        if (!controller)
            return ownerRequired;
        if (options.sourceId) {
            const entry = registry.resolveForBackend(event.sender.id, options.sourceId, event.sender);
            if (!entry)
                return { success: false, error: 'PPT preview source is unavailable' };
            return controller.setSelectionMode({
                enabled: options.enabled,
                fileName: entry.source.fileName,
                mimeType: entry.source.mimeType,
                placeholder: options.placeholder,
            });
        }
        return controller.setSelectionMode(options);
    });
    ipcMain.handle(IPC_CHANNELS.PPT_PREVIEW_CLEAR_SELECTION, (event) => {
        const controller = getOwnedController(event.sender);
        return controller ? controller.clearSelection() : ownerRequired;
    });
    ipcMain.handle(IPC_CHANNELS.PPT_PREVIEW_GET_SELECTION_EVENTS, (event) => {
        const controller = getOwnedController(event.sender);
        return controller ? controller.getSelectionEvents() : ownerRequired;
    });
    ipcMain.handle(IPC_CHANNELS.PPT_PREVIEW_CAPTURE_SELECTION, (event, rect) => {
        const controller = getOwnedController(event.sender);
        return controller ? controller.captureSelection(rect) : ownerRequired;
    });
    ipcMain.on(IPC_CHANNELS.PPT_PREVIEW_SELECTION_BRIDGE_EVENT, (event, envelope) => {
        void getPPTPreviewViewController()
            .handleSelectionBridgeEvent(event.sender, envelope)
            .catch((error) => {
            logger.warn({
                msg: '[PPTPreview] selection bridge event failed',
                error: safePreviewText(error, 'PPT preview selection bridge failed'),
            });
        });
    });
    ipcMain.handle(IPC_CHANNELS.PPT_PREVIEW_DESTROY, async (event, options) => {
        const controller = getOwnedController(event.sender);
        if (!controller)
            return ownerRequired;
        const current = currentSourceBySender.get(event.sender);
        // The renderer may park the native view while handing the same staged
        // source to the terminal system-open fallback. Sender destruction still
        // performs unconditional cleanup, so this is a bounded explicit opt-in.
        const preserveSource = preserveStagedSource(options);
        if (current && !preserveSource) {
            await deleteStagedCopy(event.sender, current.sourceId, current.kind);
        }
        // Keep the ownership record while preserving so sender teardown and a
        // subsequent source load can still clean the staged copy. Normal destroy
        // removes it after the copy has been retired.
        if (!preserveSource)
            currentSourceBySender.delete(event.sender);
        currentLoadedHtmlFilePath = null;
        void pptHtmlPreviewCache.prune();
        return controller.destroy();
    });
}
