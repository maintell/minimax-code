import { BrowserWindow } from "electron";
import { createHash } from "crypto";
import { promises } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import logger from "../../utils/logger";
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function finitePositiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}
function buildLocalImagePreviewUrl(filePath) {
    return `/mavis/api/file/preview?path=${encodeURIComponent(filePath)}`;
}
function hashPng(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}
function getSlideTextSignature(slide) {
    return [
        ...slide.textItems.map((item) => item.text),
        ...slide.selectionTargets.map((target) => target.text ?? ''),
    ]
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000);
}
function normalizeSlideMetric(value) {
    if (!value || typeof value !== 'object')
        return null;
    const input = value;
    const index = Number(input.index);
    const documentX = Number(input.documentX);
    const documentY = Number(input.documentY);
    const width = finitePositiveNumber(input.width);
    const height = finitePositiveNumber(input.height);
    if (!Number.isInteger(index) || !Number.isFinite(documentX) || !Number.isFinite(documentY)) {
        return null;
    }
    if (width === null || height === null)
        return null;
    const textItems = Array.isArray(input.textItems)
        ? input.textItems
            .map((item) => {
            if (!item || typeof item !== 'object')
                return null;
            const textInput = item;
            const rectInput = textInput.rect && typeof textInput.rect === 'object'
                ? textInput.rect
                : null;
            const text = String(textInput.text ?? '')
                .replace(/\s+/g, ' ')
                .trim();
            const x = Number(rectInput?.x);
            const y = Number(rectInput?.y);
            const rectWidth = finitePositiveNumber(rectInput?.width);
            const rectHeight = finitePositiveNumber(rectInput?.height);
            if (!text ||
                !Number.isFinite(x) ||
                !Number.isFinite(y) ||
                rectWidth === null ||
                rectHeight === null) {
                return null;
            }
            return {
                text: text.slice(0, 500),
                rect: {
                    x: Math.round(x * 100) / 100,
                    y: Math.round(y * 100) / 100,
                    width: Math.round(rectWidth * 100) / 100,
                    height: Math.round(rectHeight * 100) / 100,
                },
            };
        })
            .filter((item) => Boolean(item))
        : [];
    const selectionTargets = Array.isArray(input.selectionTargets)
        ? input.selectionTargets
            .map((item) => {
            if (!item || typeof item !== 'object')
                return null;
            const targetInput = item;
            const rectInput = targetInput.rect && typeof targetInput.rect === 'object'
                ? targetInput.rect
                : null;
            const kind = String(targetInput.kind ?? '');
            if (!['text', 'image', 'block', 'slide'].includes(kind))
                return null;
            const id = String(targetInput.id ?? '').slice(0, 120);
            const x = Number(rectInput?.x);
            const y = Number(rectInput?.y);
            const rectWidth = finitePositiveNumber(rectInput?.width);
            const rectHeight = finitePositiveNumber(rectInput?.height);
            if (!id ||
                !Number.isFinite(x) ||
                !Number.isFinite(y) ||
                rectWidth === null ||
                rectHeight === null) {
                return null;
            }
            const text = String(targetInput.text ?? '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 1000);
            const domPath = String(targetInput.domPath ?? '')
                .trim()
                .slice(0, 500);
            const priority = Number(targetInput.priority);
            return {
                id,
                kind: kind,
                rect: {
                    x: Math.round(x * 100) / 100,
                    y: Math.round(y * 100) / 100,
                    width: Math.round(rectWidth * 100) / 100,
                    height: Math.round(rectHeight * 100) / 100,
                },
                ...(text ? { text } : {}),
                ...(domPath ? { domPath } : {}),
                ...(Number.isFinite(priority) ? { priority } : {}),
            };
        })
            .filter((item) => Boolean(item))
            .slice(0, 120)
        : [];
    return {
        index,
        documentX,
        documentY,
        width: Math.round(width),
        height: Math.round(height),
        textItems,
        selectionTargets,
    };
}
async function waitForSlidePaint(window) {
    await window.webContents
        .executeJavaScript(`new Promise((resolve) => {
        const waitFonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
        waitFonts
          .catch(() => undefined)
          .then(() => Promise.all(
            Array.from(document.images)
              .filter((image) => !image.complete)
              .map((image) => new Promise((imageResolve) => {
                image.addEventListener('load', imageResolve, { once: true });
                image.addEventListener('error', imageResolve, { once: true });
              }))
          ))
          .catch(() => undefined)
          .then(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })`, true)
        .catch(() => undefined);
}
async function readSlideMetrics(window) {
    const rawMetrics = await window.webContents.executeJavaScript(`(() => {
      const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const area = (rect) => Math.max(0, rect.width) * Math.max(0, rect.height);
      const isVisibleElement = (node) => {
        const style = window.getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01;
      };
      const rectRelativeToSlide = (node, slideRect) => {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const left = Math.max(rect.left, slideRect.left);
        const top = Math.max(rect.top, slideRect.top);
        const right = Math.min(rect.right, slideRect.right);
        const bottom = Math.min(rect.bottom, slideRect.bottom);
        if (right - left <= 0 || bottom - top <= 0) return null;
        return {
          x: left - slideRect.left,
          y: top - slideRect.top,
          width: right - left,
          height: bottom - top,
        };
      };
      const domPathFor = (node, slide) => {
        const parts = [];
        let current = node;
        while (current && current !== slide && current.nodeType === 1) {
          const parent = current.parentElement;
          if (!parent) break;
          const sameTag = Array.from(parent.children).filter(
            (child) => child.tagName === current.tagName,
          );
          const index = sameTag.indexOf(current) + 1;
          parts.unshift(
            current.tagName.toLowerCase() + (sameTag.length > 1 ? ':nth-of-type(' + index + ')' : ''),
          );
          current = parent;
        }
        return '.slide' + (parts.length ? ' > ' + parts.join(' > ') : '');
      };
      const depthFromSlide = (node, slide) => {
        let depth = 0;
        let current = node;
        while (current && current !== slide) {
          depth += 1;
          current = current.parentElement;
        }
        return depth;
      };
      const makeTarget = (slide, slideRect, node, kind, priority, idSuffix) => {
        if (!node || !isVisibleElement(node)) return null;
        const rect = rectRelativeToSlide(node, slideRect);
        if (!rect || area(rect) < 64) return null;
        const text = normalizeText(node.textContent).slice(0, 1000);
        return {
          id: kind + '-' + idSuffix,
          kind,
          rect,
          text,
          domPath: domPathFor(node, slide),
          priority,
        };
      };
      return Array.from(document.querySelectorAll('.slide')).map((slide, index) => {
        const slideRect = slide.getBoundingClientRect();
        const slideArea = Math.max(1, slideRect.width * slideRect.height);
        const textItems = Array.from(slide.querySelectorAll('span, p, div'))
          .filter((node) =>
            !Array.from(node.children).some((child) => normalizeText(child.textContent))
          )
          .map((node) => {
            const text = normalizeText(node.textContent);
            if (!text || text === '\\u00a0') return null;
            const rect = node.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return null;
            return {
              text,
              rect: {
                x: rect.left - slideRect.left,
                y: rect.top - slideRect.top,
                width: rect.width,
                height: rect.height,
              },
            };
          })
          .filter(Boolean);
        const targetMap = new Map();
        const pushTarget = (target) => {
          if (!target) return;
          const rect = target.rect;
          const key = [
            target.kind,
            Math.round(rect.x),
            Math.round(rect.y),
            Math.round(rect.width),
            Math.round(rect.height),
            target.text || '',
          ].join('|');
          if (!targetMap.has(key)) targetMap.set(key, target);
        };
        Array.from(slide.children).forEach((node, childIndex) => {
          const target = makeTarget(slide, slideRect, node, 'block', 80, 'top-' + childIndex);
          if (!target) return;
          const targetArea = area(target.rect);
          const tooLarge =
            target.rect.width >= slideRect.width * 0.94 && target.rect.height >= slideRect.height * 0.84;
          if (targetArea < slideArea * 0.9 && !tooLarge) pushTarget(target);
        });
        Array.from(slide.querySelectorAll('div, p, section, article, aside')).forEach((node, nodeIndex) => {
          const depth = depthFromSlide(node, slide);
          if (depth > 4) return;
          const target = makeTarget(slide, slideRect, node, 'block', Math.max(50, 74 - depth * 4), 'block-' + nodeIndex);
          if (!target) return;
          const targetArea = area(target.rect);
          if (targetArea < 900 || targetArea > slideArea * 0.82) return;
          if (!target.text && !node.querySelector('img, svg, canvas')) return;
          pushTarget(target);
        });
        Array.from(slide.querySelectorAll('img, svg, canvas')).forEach((node, nodeIndex) => {
          const target = makeTarget(slide, slideRect, node, 'image', 68, 'image-' + nodeIndex);
          if (!target || area(target.rect) < 300) return;
          pushTarget(target);
        });
        textItems.forEach((item, itemIndex) => {
          pushTarget({
            id: 'text-' + itemIndex,
            kind: 'text',
            rect: item.rect,
            text: item.text,
            domPath: '',
            priority: 42,
          });
        });
        const selectionTargets = Array.from(targetMap.values())
          .sort((a, b) => (b.priority || 0) - (a.priority || 0))
          .slice(0, 100);
        if (!selectionTargets.length) {
          selectionTargets.push({
            id: 'slide-fallback',
            kind: 'slide',
            rect: { x: 0, y: 0, width: slideRect.width, height: slideRect.height },
            text: normalizeText(slide.textContent).slice(0, 1000),
            domPath: '.slide',
            priority: 1,
          });
        }
        return {
          index,
          documentX: slideRect.left + window.scrollX,
          documentY: slideRect.top + window.scrollY,
          width: slideRect.width,
          height: slideRect.height,
          textItems,
          selectionTargets,
        };
      });
    })()`, true);
    if (!Array.isArray(rawMetrics))
        return [];
    return rawMetrics
        .map(normalizeSlideMetric)
        .filter((metric) => Boolean(metric));
}
export async function renderQuickLookSlideImages(options) {
    const timeoutMs = Math.max(1000, options.timeoutMs ?? 15000);
    const outputDir = path.resolve(options.outputDir);
    await promises.mkdir(outputDir, { recursive: true });
    const window = new BrowserWindow({
        show: false,
        width: 1200,
        height: 800,
        paintWhenInitiallyHidden: true,
        webPreferences: {
            offscreen: true,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            backgroundThrottling: false,
        },
    });
    try {
        const fileUrl = pathToFileURL(path.resolve(options.htmlFilePath)).toString();
        await Promise.race([
            window.loadURL(fileUrl),
            delay(timeoutMs).then(() => {
                throw new Error(`Timed out loading QuickLook raster HTML after ${timeoutMs}ms`);
            }),
        ]);
        await waitForSlidePaint(window);
        const slideMetrics = await readSlideMetrics(window);
        if (!slideMetrics.length)
            return [];
        const maxWidth = Math.max(...slideMetrics.map((slide) => slide.width));
        const maxHeight = Math.max(...slideMetrics.map((slide) => slide.height));
        window.setContentSize(Math.ceil(maxWidth), Math.ceil(maxHeight));
        await waitForSlidePaint(window);
        const images = [];
        const imageTextByHash = new Map();
        for (const slide of slideMetrics) {
            await window.webContents.executeJavaScript(`new Promise((resolve) => {
          window.scrollTo(${Math.max(0, Math.floor(slide.documentX))}, ${Math.max(0, Math.floor(slide.documentY))});
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        })`, true);
            const viewportRect = await window.webContents.executeJavaScript(`(() => {
          const slide = document.querySelectorAll('.slide')[${slide.index}];
          if (!slide) return null;
          const rect = slide.getBoundingClientRect();
          return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
        })()`, true);
            const normalizedRect = normalizeSlideMetric({
                ...slide,
                documentX: 0,
                documentY: 0,
                width: viewportRect?.width ?? slide.width,
                height: viewportRect?.height ?? slide.height,
            });
            const rect = viewportRect && typeof viewportRect === 'object'
                ? viewportRect
                : null;
            const x = Number(rect?.x ?? 0);
            const y = Number(rect?.y ?? 0);
            const width = Math.max(1, Math.ceil(normalizedRect?.width ?? slide.width));
            const height = Math.max(1, Math.ceil(normalizedRect?.height ?? slide.height));
            await waitForSlidePaint(window);
            const image = await Promise.race([
                window.webContents.capturePage({
                    x: Math.max(0, Math.floor(Number.isFinite(x) ? x : 0)),
                    y: Math.max(0, Math.floor(Number.isFinite(y) ? y : 0)),
                    width,
                    height,
                }),
                delay(timeoutMs).then(() => {
                    throw new Error(`Timed out capturing slide ${slide.index + 1} after ${timeoutMs}ms`);
                }),
            ]);
            if (image.isEmpty())
                continue;
            const png = image.toPNG();
            const imageHash = hashPng(png);
            const textSignature = getSlideTextSignature(slide);
            const previous = imageTextByHash.get(imageHash);
            if (previous && previous.textSignature !== textSignature) {
                logger.warn({
                    msg: '[PPTPreview] Duplicate slide image hash with different text; falling back to native preview',
                    previousSlideNumber: previous.slideNumber,
                    slideNumber: slide.index + 1,
                });
                return [];
            }
            imageTextByHash.set(imageHash, {
                slideNumber: slide.index + 1,
                textSignature,
            });
            const imagePath = path.join(outputDir, `slide-${String(slide.index + 1).padStart(3, '0')}.png`);
            await promises.writeFile(imagePath, png);
            images.push({
                slideNumber: slide.index + 1,
                imagePath,
                imageUrl: buildLocalImagePreviewUrl(imagePath),
                width,
                height,
                textItems: slide.textItems,
                selectionTargets: slide.selectionTargets,
                source: 'quicklook-raster',
            });
        }
        return images;
    }
    catch (error) {
        logger.warn({ msg: '[PPTPreview] Failed to render slide images', error: String(error) });
        return [];
    }
    finally {
        if (!window.isDestroyed())
            window.destroy();
    }
}
