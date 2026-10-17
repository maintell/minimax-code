import fs from "fs";
const ELEMENT_MAP_SCHEMA = 'mavis.ppt_element_map.v1';
const MAX_ELEMENT_MAP_BYTES = 2 * 1024 * 1024;
const MAX_RESOLVED_TEXT_LENGTH = 2000;
const DEFAULT_LAYOUT = {
    widthIn: 10,
    heightIn: 5.625,
};
function round(value) {
    return Math.round(value * 10000) / 10000;
}
function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function finiteNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}
function normalizeText(value) {
    return String(value ?? '')
        .replace(/\s+/g, '')
        .trim()
        .toLowerCase();
}
function limitString(value, maxLength) {
    if (typeof value !== 'string')
        return undefined;
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized ? normalized.slice(0, maxLength) : undefined;
}
function rectArea(rect) {
    return Math.max(0, rect.w) * Math.max(0, rect.h);
}
function intersectRect(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    return {
        x: x1,
        y: y1,
        w: Math.max(0, x2 - x1),
        h: Math.max(0, y2 - y1),
    };
}
function getRectScore(selectionRect, elementRect) {
    const intersection = rectArea(intersectRect(selectionRect, elementRect));
    if (intersection <= 0)
        return 0;
    const selectionArea = rectArea(selectionRect);
    const elementArea = rectArea(elementRect);
    if (selectionArea <= 0 || elementArea <= 0)
        return 0;
    const union = selectionArea + elementArea - intersection;
    const iou = union > 0 ? intersection / union : 0;
    const coverage = intersection / Math.min(selectionArea, elementArea);
    return round(Math.max(iou, coverage * 0.85));
}
function getTextScore(selectedText, elementText) {
    const selected = normalizeText(selectedText);
    const candidate = normalizeText(elementText);
    if (!selected || !candidate)
        return 0;
    if (selected === candidate)
        return 1;
    if (candidate.includes(selected) || selected.includes(candidate))
        return 0.85;
    const selectedChars = new Set([...selected]);
    const candidateChars = new Set([...candidate]);
    if (selectedChars.size === 0 || candidateChars.size === 0)
        return 0;
    const overlap = [...selectedChars].filter((char) => candidateChars.has(char)).length;
    const ratio = overlap / Math.max(selectedChars.size, candidateChars.size);
    return ratio >= 0.5 ? round(ratio * 0.6) : 0;
}
function getRoleScore(instruction, role, kind) {
    const normalizedInstruction = normalizeText(instruction);
    const normalizedRole = normalizeText(role);
    const normalizedKind = normalizeText(kind);
    if (!normalizedInstruction)
        return 0;
    if ((normalizedInstruction.includes('标题') ||
        normalizedInstruction.includes('title') ||
        normalizedInstruction.includes('heading')) &&
        (normalizedRole.includes('title') || normalizedRole.includes('heading'))) {
        return 1;
    }
    if ((normalizedInstruction.includes('图片') || normalizedInstruction.includes('image')) &&
        (normalizedKind === 'image' || normalizedRole.includes('image'))) {
        return 1;
    }
    if ((normalizedInstruction.includes('表格') || normalizedInstruction.includes('table')) &&
        (normalizedKind === 'table' || normalizedRole.includes('table'))) {
        return 1;
    }
    return 0;
}
function confidenceFromScore(score) {
    if (score >= 0.75)
        return 'high';
    if (score >= 0.45)
        return 'medium';
    return 'low';
}
function getNormalizedRectFromElement(element, layout) {
    const normalized = element.normalizedRect;
    if (normalized) {
        const x = finiteNumber(normalized.x);
        const y = finiteNumber(normalized.y);
        const w = finiteNumber(normalized.w);
        const h = finiteNumber(normalized.h);
        if (x !== null && y !== null && w !== null && h !== null && w >= 0 && h >= 0) {
            return { x, y, w, h };
        }
    }
    const rectIn = element.rectIn;
    if (!rectIn)
        return null;
    const x = finiteNumber(rectIn.x);
    const y = finiteNumber(rectIn.y);
    const w = finiteNumber(rectIn.w);
    const h = finiteNumber(rectIn.h);
    if (x === null || y === null || w === null || h === null || w < 0 || h < 0)
        return null;
    return {
        x: round(x / layout.widthIn),
        y: round(y / layout.heightIn),
        w: round(w / layout.widthIn),
        h: round(h / layout.heightIn),
    };
}
function getSelectionRects(item, layout) {
    const slideWidth = finiteNumber(item.slideSize.width);
    const slideHeight = finiteNumber(item.slideSize.height);
    if (!slideWidth || !slideHeight || slideWidth <= 0 || slideHeight <= 0)
        return null;
    const rect = item.selection.slideRect;
    const x = finiteNumber(rect.x);
    const y = finiteNumber(rect.y);
    const width = finiteNumber(rect.width);
    const height = finiteNumber(rect.height);
    if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
        return null;
    }
    const normalizedSelectionRect = {
        x: round(x / slideWidth),
        y: round(y / slideHeight),
        w: round(width / slideWidth),
        h: round(height / slideHeight),
    };
    const selectionRectIn = {
        x: round(normalizedSelectionRect.x * layout.widthIn),
        y: round(normalizedSelectionRect.y * layout.heightIn),
        w: round(normalizedSelectionRect.w * layout.widthIn),
        h: round(normalizedSelectionRect.h * layout.heightIn),
    };
    return { normalizedSelectionRect, selectionRectIn };
}
function getLayout(map) {
    const widthIn = finiteNumber(map.layout?.widthIn);
    const heightIn = finiteNumber(map.layout?.heightIn);
    return {
        widthIn: widthIn && widthIn > 0 ? widthIn : DEFAULT_LAYOUT.widthIn,
        heightIn: heightIn && heightIn > 0 ? heightIn : DEFAULT_LAYOUT.heightIn,
    };
}
function scoreElement(element, item, selectionRect, layout) {
    if (!element.elementId || !element.kind)
        return null;
    const elementRect = getNormalizedRectFromElement(element, layout);
    if (!elementRect)
        return null;
    const textScore = getTextScore(item.selection.text, element.text);
    const rectScore = getRectScore(selectionRect, elementRect);
    const roleScore = getRoleScore(item.instruction, element.role, element.kind);
    const score = round(textScore * 0.5 + rectScore * 0.4 + roleScore * 0.1);
    const reasons = [];
    if (textScore >= 1)
        reasons.push('text:exact');
    else if (textScore >= 0.85)
        reasons.push('text:contains');
    else if (textScore > 0)
        reasons.push('text:partial');
    if (rectScore >= 0.75)
        reasons.push('rect:strong-overlap');
    else if (rectScore > 0)
        reasons.push('rect:overlap');
    if (roleScore > 0)
        reasons.push('role:instruction-compatible');
    return { element, score, textScore, rectScore, roleScore, reasons };
}
function pickBestElement(elements, item, selectionRect, layout) {
    const scored = elements
        .map((element) => scoreElement(element, item, selectionRect, layout))
        .filter((element) => Boolean(element))
        .sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        if (b.textScore !== a.textScore)
            return b.textScore - a.textScore;
        return b.rectScore - a.rectScore;
    });
    return scored[0] ?? null;
}
function readElementMap(mapPath) {
    const stat = fs.lstatSync(mapPath);
    if (stat.isSymbolicLink())
        throw new Error('PPT element map must not be a symbolic link');
    if (!stat.isFile())
        throw new Error('PPT element map must be a regular file');
    if (stat.size > MAX_ELEMENT_MAP_BYTES) {
        throw new Error(`PPT element map is too large: ${stat.size} bytes`);
    }
    const content = fs.readFileSync(mapPath, 'utf8');
    const parsed = JSON.parse(content);
    if (!isObject(parsed)) {
        throw new Error('PPT element map must be a JSON object');
    }
    return parsed;
}
function safeLocatorSourceRef(value) {
    if (!isObject(value))
        return undefined;
    const result = {};
    if (typeof value.file === 'string' && value.file.length <= 512) {
        const file = value.file.replace(/\\/gu, '/');
        if (file &&
            !file.startsWith('/') &&
            !/^[A-Za-z]:\//u.test(file) &&
            !/(?:^|[^A-Za-z])(?:https?|file|data):/iu.test(file) &&
            !file.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
            result.file = file;
        }
    }
    if (typeof value.method === 'string' &&
        value.method.length <= 128 &&
        /^[A-Za-z_$][A-Za-z0-9_$.-]*$/u.test(value.method)) {
        result.method = value.method;
    }
    return result.file || result.method ? result : undefined;
}
function lookupOutcome(resolution) {
    const lookup = resolution.elementMapLookup;
    if (!lookup.attempted)
        return 'not-applicable';
    if (!lookup.found)
        return 'missing';
    if (lookup.error?.includes('too large'))
        return 'too-large';
    if (lookup.error?.includes('Unsupported PPT element map schema'))
        return 'unsupported-schema';
    if (lookup.error)
        return 'invalid';
    if (lookup.slideFound === false)
        return 'slide-missing';
    if (resolution.resolvedElement)
        return 'resolved';
    return 'no-match';
}
/** Remove local paths, raw errors, URLs, and arbitrary sidecar fields before IPC. */
export function sanitizePptElementMapResolution(resolution) {
    const rawLookup = resolution.elementMapLookup;
    const schema = typeof rawLookup.schema === 'string' && /^[A-Za-z0-9._-]{1,128}$/u.test(rawLookup.schema)
        ? rawLookup.schema
        : undefined;
    const elementMapLookup = {
        attempted: rawLookup.attempted,
        outcome: lookupOutcome(resolution),
        ...(schema ? { schema } : {}),
        ...(typeof rawLookup.slideFound === 'boolean'
            ? { slideFound: rawLookup.slideFound }
            : {}),
    };
    const element = resolution.resolvedElement;
    if (!element || elementMapLookup.outcome !== 'resolved')
        return { elementMapLookup };
    const sourceRef = safeLocatorSourceRef(element.sourceRef);
    return {
        elementMapLookup,
        resolvedElement: {
            source: 'mavis-ppt-map',
            elementId: element.elementId,
            confidence: element.confidence,
            score: element.score,
            matchReasons: [...element.matchReasons],
            slideNumber: element.slideNumber,
            ...(element.slideId ? { slideId: element.slideId } : {}),
            ...(element.slideTitle ? { slideTitle: element.slideTitle } : {}),
            kind: element.kind,
            ...(element.role ? { role: element.role } : {}),
            ...(element.text ? { text: element.text } : {}),
            ...(element.rectIn ? { rectIn: { ...element.rectIn } } : {}),
            ...(element.normalizedRect ? { normalizedRect: { ...element.normalizedRect } } : {}),
            ...(element.pptShapeId !== undefined ? { pptShapeId: element.pptShapeId } : {}),
            ...(sourceRef ? { sourceRef } : {}),
            ...(element.selectionRectIn
                ? { selectionRectIn: { ...element.selectionRectIn } }
                : {}),
            ...(element.normalizedSelectionRect
                ? { normalizedSelectionRect: { ...element.normalizedSelectionRect } }
                : {}),
        },
    };
}
export function derivePptElementMapPath(filePath) {
    if (!filePath || !/\.pptx$/iu.test(filePath))
        return null;
    return filePath.replace(/\.pptx$/iu, '.mavis-ppt-map.json');
}
export function resolvePptSelectionElementFromSidecar(item) {
    const mapPath = derivePptElementMapPath(item.filePath);
    if (!mapPath) {
        return {
            elementMapLookup: {
                attempted: false,
                found: false,
            },
        };
    }
    const baseLookup = {
        attempted: true,
        found: false,
        mapPath,
    };
    if (!fs.existsSync(mapPath)) {
        return { elementMapLookup: baseLookup };
    }
    try {
        const map = readElementMap(mapPath);
        const schema = typeof map.schema === 'string' ? map.schema : undefined;
        const lookup = {
            ...baseLookup,
            found: true,
            schema,
        };
        if (schema !== ELEMENT_MAP_SCHEMA) {
            return {
                elementMapLookup: {
                    ...lookup,
                    error: `Unsupported PPT element map schema: ${schema || 'unknown'}`,
                },
            };
        }
        const slide = map.slides?.find((candidate) => candidate.slideNumber === item.slideNumber);
        if (!slide) {
            return { elementMapLookup: { ...lookup, slideFound: false } };
        }
        const layout = getLayout(map);
        const selectionRects = getSelectionRects(item, layout);
        if (!selectionRects) {
            return {
                elementMapLookup: {
                    ...lookup,
                    slideFound: true,
                    error: 'Invalid PPT selection rectangle for element map resolution',
                },
            };
        }
        const best = pickBestElement(slide.elements ?? [], item, selectionRects.normalizedSelectionRect, layout);
        if (!best || !best.element.elementId || !best.element.kind) {
            return { elementMapLookup: { ...lookup, slideFound: true } };
        }
        const elementText = limitString(best.element.text, MAX_RESOLVED_TEXT_LENGTH);
        return {
            elementMapLookup: { ...lookup, slideFound: true },
            resolvedElement: {
                source: 'mavis-ppt-map',
                mapPath,
                elementId: best.element.elementId,
                confidence: confidenceFromScore(best.score),
                score: best.score,
                matchReasons: best.reasons,
                slideNumber: item.slideNumber,
                ...(slide.slideId ? { slideId: slide.slideId } : {}),
                ...(slide.title ? { slideTitle: slide.title } : {}),
                kind: best.element.kind,
                ...(best.element.role ? { role: best.element.role } : {}),
                ...(elementText ? { text: elementText } : {}),
                ...(best.element.rectIn ? { rectIn: best.element.rectIn } : {}),
                ...(best.element.normalizedRect ? { normalizedRect: best.element.normalizedRect } : {}),
                ...(best.element.pptShapeId !== undefined ? { pptShapeId: best.element.pptShapeId } : {}),
                ...(best.element.source ? { sourceRef: best.element.source } : {}),
                selectionRectIn: selectionRects.selectionRectIn,
                normalizedSelectionRect: selectionRects.normalizedSelectionRect,
            },
        };
    }
    catch (error) {
        return {
            elementMapLookup: {
                ...baseLookup,
                found: true,
                error: error instanceof Error ? error.message : String(error),
            },
        };
    }
}
