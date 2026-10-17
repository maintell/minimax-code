import {} from './pptx-diagnostic-policy.generated.js';
import { PPTX_RENDER_WIRE_LIMITS_V1, isSafePptxHyperlinkUrlV1, } from './pptx-rendering-contract.js';
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
export const PPT_DOCUMENT_ID = /^ppt-document:v1:[a-f0-9]{16}$/u;
export const PPT_DOCUMENT_REVISION = /^ppt-revision:v1:[a-f0-9]{16}$/u;
export const PPT_DOCUMENT_HASH = /^ppt-document-hash:v1:[a-f0-9]{16}$/u;
export const PPT_NODE_ID = /^ppt-node:v1:[a-f0-9]{16}$/u;
export const DIAGNOSTIC_REASON = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
export const PPTX_DIAGNOSTIC_STAGES_V1 = Object.freeze([
    'S01',
    'S02',
    'S03',
    'S04',
    'S05',
    'S06',
    'S07',
    'S08',
    'S09',
    'S10',
]);
export const NOTES_DIAGNOSTIC_CODE = /^PPTX-S07-[A-Z0-9-]+$/u;
export const NOTES_LANGUAGE_HINT = /^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8})*$/u;
export const NOTES_LIMITS_V1 = Object.freeze({
    maxTextBytes: 1024 * 1024,
    maxParagraphs: 10_000,
    maxParagraphBytes: 256 * 1024,
    maxDiagnostics: 256,
});
export const TEXT_SEARCH_LIMITS_V1 = Object.freeze({
    maxQueryLength: 256,
    maxMatches: 1_000,
    maxMatchTextLength: 4_096,
});
export function record(value, name) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`);
    }
    return value;
}
export function exactKeys(value, allowed, name) {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
        allowed.some((key) => !Object.hasOwn(value, key))) {
        throw new TypeError(`${name} contains missing or forbidden fields`);
    }
}
export function opaque(value, name) {
    if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
        throw new TypeError(`${name} must be an opaque identifier`);
    }
    return value;
}
export function nonNegativeInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) {
        throw new TypeError(`${name} must be a bounded non-negative integer`);
    }
    return value;
}
export function booleanValue(value, name) {
    if (typeof value !== 'boolean')
        throw new TypeError(`${name} must be boolean`);
    return value;
}
export function sha256(value, name) {
    if (typeof value !== 'string' || !SHA256.test(value)) {
        throw new TypeError(`${name} must be a SHA-256 digest`);
    }
    return value;
}
export function boundedText(value, name, max, allowEmpty = false) {
    if (typeof value !== 'string' ||
        value.length > max ||
        (!allowEmpty && value.length === 0) ||
        value !== value.normalize('NFC') ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} must be bounded normalized text`);
    }
    return value;
}
// Authored content may use decomposed Unicode. Preserve it verbatim: glyph
// clusters, source ranges and render hashes refer to those exact UTF-16 units.
// Protocol identifiers and metadata still use boundedText's NFC requirement.
export function boundedSourceText(value, name, max) {
    if (typeof value !== 'string' ||
        value.length > max ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} must be bounded source text`);
    }
    return value;
}
export function boundedNotesText(value, name, maxBytes) {
    if (typeof value !== 'string')
        throw new TypeError(`${name} must be text`);
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} contains forbidden control characters`);
    }
    if (new TextEncoder().encode(value).byteLength > maxBytes) {
        throw new RangeError(`${name} budget exceeded`);
    }
    return value;
}
export function decodeNotesSourceAnchorV1(value, name) {
    const input = record(value, name);
    exactKeys(input, ['partUri', 'elementOrdinal', 'xmlPath', 'namespaceUri', 'localName', 'sdkTypeId'], name);
    if (!Array.isArray(input.xmlPath) || input.xmlPath.length > 256) {
        throw new TypeError(`${name} XML path is invalid`);
    }
    const xmlPath = input.xmlPath.map((item, index) => nonNegativeInteger(item, `${name} XML path ${index}`, 100_000));
    const sdkTypeId = input.sdkTypeId === null ? null : boundedText(input.sdkTypeId, `${name} SDK type`, 512);
    return Object.freeze({
        partUri: partUri(input.partUri),
        elementOrdinal: nonNegativeInteger(input.elementOrdinal, `${name} element ordinal`, 100_000),
        xmlPath: Object.freeze(xmlPath),
        namespaceUri: boundedText(input.namespaceUri, `${name} namespace`, 2_048, true),
        localName: boundedText(input.localName, `${name} local name`, 256),
        sdkTypeId,
    });
}
export function boundedStrings(value, name, maxItems) {
    if (!Array.isArray(value) || value.length > maxItems) {
        throw new TypeError(`${name} must be a bounded string array`);
    }
    const values = value.map((item, index) => boundedText(item, `${name}[${index}]`, 256));
    if (new Set(values).size !== values.length)
        throw new TypeError(`${name} contains duplicates`);
    if (values.some((item, index) => index > 0 && values[index - 1] >= item)) {
        throw new TypeError(`${name} must use deterministic ordinal order`);
    }
    return Object.freeze(values);
}
export function pptIdentity(value, pattern, name) {
    const textValue = boundedText(value, name, 128);
    if (!pattern.test(textValue))
        throw new TypeError(`${name} has an invalid identity format`);
    return textValue;
}
export function partUri(value) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 4_096 ||
        value !== value.normalize('NFC') ||
        value.startsWith('/') ||
        value.endsWith('/') ||
        value.includes('\\') ||
        value.includes(':') ||
        value.includes('\u0000') ||
        value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
        throw new TypeError('invalid package part URI');
    }
    return value;
}
const PPT_RENDER_NODE_ID = /^ppt-render-node:v1:[a-f0-9]{16}$/u;
const PPT_RENDER_HASH = /^render:v1:[a-f0-9]{16}$/u;
const RENDER_RESOURCE_ID = /^(?:ppt-resource|ppt-font|glyph-path|media-poster):v1:[a-f0-9]{16,64}$/u;
export const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const SEMANTIC_ROLE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
export function finiteInteger(value, name, minimum = -Number.MAX_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new TypeError(`${name} must be a bounded finite integer`);
    }
    return value;
}
export function deepFreezeWire(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            deepFreezeWire(child);
        Object.freeze(value);
    }
    return value;
}
export function renderNodeId(value, name) {
    const id = boundedText(value, name, 128);
    if (!PPT_RENDER_NODE_ID.test(id))
        throw new TypeError(`${name} is invalid`);
    return id;
}
export function renderResourceId(value) {
    const id = boundedText(value, 'resourceId', 128);
    if (!RENDER_RESOURCE_ID.test(id) || /[\\/]/u.test(id))
        throw new TypeError('resourceId is not opaque');
    return id;
}
export function renderHash(value) {
    if (typeof value !== 'string' || !PPT_RENDER_HASH.test(value))
        throw new TypeError('invalid render hash');
    return value;
}
export function decodeRect(value, name) {
    const input = record(value, name);
    exactKeys(input, ['x', 'y', 'width', 'height'], name);
    return Object.freeze({
        x: finiteInteger(input.x, `${name}.x`),
        y: finiteInteger(input.y, `${name}.y`),
        width: finiteInteger(input.width, `${name}.width`, 0),
        height: finiteInteger(input.height, `${name}.height`, 0),
    });
}
function decodeTransform(value) {
    const input = record(value, 'worldTransform');
    exactKeys(input, ['a', 'b', 'c', 'd', 'tx', 'ty'], 'worldTransform');
    return Object.freeze(Object.fromEntries(['a', 'b', 'c', 'd', 'tx', 'ty'].map((key) => [
        key,
        finiteInteger(input[key], `worldTransform.${key}`),
    ])));
}
function decodePathCommand(value, index) {
    const input = record(value, `path command ${index}`);
    const coordinates = {
        move: ['x', 'y'],
        line: ['x', 'y'],
        cubic: ['control1X', 'control1Y', 'control2X', 'control2Y', 'x', 'y'],
        quadratic: ['controlX', 'controlY', 'x', 'y'],
        arc: ['radiusX', 'radiusY', 'rotation', 'largeArc', 'sweep', 'x', 'y'],
        close: [],
    };
    const keys = coordinates[String(input.kind)];
    if (!keys)
        throw new TypeError('unknown path command');
    exactKeys(input, ['kind', ...keys], `path command ${index}`);
    const output = { kind: input.kind };
    for (const key of keys) {
        if (key === 'largeArc' || key === 'sweep') {
            if (typeof input[key] !== 'boolean')
                throw new TypeError(`path command ${key} is invalid`);
            output[key] = input[key];
        }
        else {
            output[key] = finiteInteger(input[key], `path command ${key}`, key.startsWith('radius') ? 0 : -Number.MAX_SAFE_INTEGER);
        }
    }
    return Object.freeze(output);
}
function decodeCommands(value, budget) {
    if (!Array.isArray(value))
        throw new TypeError('path commands must be an array');
    budget.commands += value.length;
    if (budget.commands > PPTX_RENDER_WIRE_LIMITS_V1.maxPathCommands)
        throw new TypeError('path command budget exceeded');
    return Object.freeze(value.map(decodePathCommand));
}
function decodeColor(value) {
    if (typeof value !== 'string' || !/^#[A-F0-9]{8}$/u.test(value))
        throw new TypeError('render color is invalid');
    return value;
}
function decodeFill(value) {
    const input = record(value, 'render fill');
    switch (input.kind) {
        case 'none':
            exactKeys(input, ['kind'], 'render fill');
            return Object.freeze({ kind: 'none' });
        case 'solid':
            exactKeys(input, ['kind', 'color'], 'render fill');
            return Object.freeze({ kind: 'solid', color: decodeColor(input.color) });
        case 'linear-gradient':
        case 'radial-gradient':
        case 'rectangular-gradient': {
            const linear = input.kind === 'linear-gradient';
            exactKeys(input, linear ? ['kind', 'angle60000', 'stops'] : ['kind', 'fillToRect100000', 'stops'], 'render fill');
            if (!Array.isArray(input.stops) ||
                input.stops.length === 0 ||
                input.stops.length > PPTX_RENDER_WIRE_LIMITS_V1.maxGradientStops) {
                throw new TypeError('gradient stop budget exceeded');
            }
            const stops = input.stops.map((stop, index) => {
                const row = record(stop, `gradient stop ${index}`);
                exactKeys(row, ['position100000', 'color'], `gradient stop ${index}`);
                return Object.freeze({
                    position100000: finiteInteger(row.position100000, 'gradient position', 0, 100_000),
                    color: decodeColor(row.color),
                });
            });
            return Object.freeze({
                kind: input.kind,
                ...(linear
                    ? { angle60000: finiteInteger(input.angle60000, 'gradient angle') }
                    : (() => {
                        const fillToRect = record(input.fillToRect100000, 'gradient fill rectangle');
                        exactKeys(fillToRect, ['left', 'top', 'right', 'bottom'], 'gradient fill rectangle');
                        return {
                            fillToRect100000: Object.freeze({
                                left: finiteInteger(fillToRect.left, 'gradient fill rectangle left'),
                                top: finiteInteger(fillToRect.top, 'gradient fill rectangle top'),
                                right: finiteInteger(fillToRect.right, 'gradient fill rectangle right'),
                                bottom: finiteInteger(fillToRect.bottom, 'gradient fill rectangle bottom'),
                            }),
                        };
                    })()),
                stops: Object.freeze(stops),
            });
        }
        case 'image': {
            exactKeys(input, Object.hasOwn(input, 'tile')
                ? ['kind', 'resourceId', 'opacity100000', 'mode', 'tile']
                : ['kind', 'resourceId', 'opacity100000', 'mode'], 'render fill');
            if (input.mode !== 'stretch' && input.mode !== 'tile')
                throw new TypeError('image fill mode is invalid');
            const tile = Object.hasOwn(input, 'tile')
                ? (() => {
                    if (input.mode !== 'tile')
                        throw new TypeError('image fill tile requires tile mode');
                    const row = record(input.tile, 'image fill tile');
                    exactKeys(row, ['scaleX100000', 'scaleY100000', 'offsetXEmu', 'offsetYEmu', 'alignment', 'flip'], 'image fill tile');
                    const alignment = boundedText(row.alignment, 'image fill tile alignment', 3);
                    if (!['tl', 't', 'tr', 'l', 'ctr', 'r', 'bl', 'b', 'br'].includes(alignment)) {
                        throw new TypeError('image fill tile alignment is invalid');
                    }
                    const flip = boundedText(row.flip, 'image fill tile flip', 4);
                    if (!['none', 'x', 'y', 'xy'].includes(flip)) {
                        throw new TypeError('image fill tile flip is invalid');
                    }
                    return Object.freeze({
                        scaleX100000: finiteInteger(row.scaleX100000, 'image fill tile horizontal scale', 1),
                        scaleY100000: finiteInteger(row.scaleY100000, 'image fill tile vertical scale', 1),
                        offsetXEmu: finiteInteger(row.offsetXEmu, 'image fill tile horizontal offset'),
                        offsetYEmu: finiteInteger(row.offsetYEmu, 'image fill tile vertical offset'),
                        alignment,
                        flip,
                    });
                })()
                : undefined;
            return Object.freeze({
                kind: 'image',
                resourceId: renderResourceId(input.resourceId),
                opacity100000: finiteInteger(input.opacity100000, 'fill opacity', 0, 100_000),
                mode: input.mode,
                ...(tile ? { tile } : {}),
            });
        }
        case 'pattern':
            exactKeys(input, ['kind', 'preset', 'foreground', 'background'], 'render fill');
            return Object.freeze({
                kind: 'pattern',
                preset: boundedText(input.preset, 'pattern', 64),
                foreground: decodeColor(input.foreground),
                background: decodeColor(input.background),
            });
        default:
            throw new TypeError('unknown render fill kind');
    }
}
function decodeStroke(value) {
    if (value === null)
        return null;
    const input = record(value, 'render stroke');
    exactKeys(input, ['widthEmu', 'fill', 'dash', 'cap', 'join', 'compound', 'headEnd', 'tailEnd'], 'render stroke');
    const enumeration = (raw, allowed, name) => {
        if (typeof raw !== 'string' || !allowed.includes(raw))
            throw new TypeError(`${name} is invalid`);
        return raw;
    };
    return Object.freeze({
        widthEmu: finiteInteger(input.widthEmu, 'stroke width', 0),
        fill: decodeFill(input.fill),
        dash: boundedText(input.dash, 'stroke dash', 64),
        cap: enumeration(input.cap, ['flat', 'round', 'square'], 'stroke cap'),
        join: enumeration(input.join, ['round', 'bevel', 'miter'], 'stroke join'),
        compound: enumeration(input.compound, ['single', 'double', 'thick-thin', 'thin-thick', 'triple'], 'stroke compound'),
        headEnd: enumeration(input.headEnd, ['none', 'triangle', 'stealth', 'diamond', 'oval', 'arrow'], 'stroke head'),
        tailEnd: enumeration(input.tailEnd, ['none', 'triangle', 'stealth', 'diamond', 'oval', 'arrow'], 'stroke tail'),
    });
}
function decodeOuterShadow(value) {
    if (value === null)
        return null;
    const input = record(value, 'outer shadow');
    exactKeys(input, ['blurRadiusEmu', 'distanceEmu', 'direction60000', 'rotateWithShape', 'color'], 'outer shadow');
    if (typeof input.rotateWithShape !== 'boolean') {
        throw new TypeError('outer shadow rotation flag is invalid');
    }
    if (typeof input.color !== 'string' || !/^#[A-F0-9]{8}$/u.test(input.color)) {
        throw new TypeError('outer shadow color is invalid');
    }
    return Object.freeze({
        blurRadiusEmu: finiteInteger(input.blurRadiusEmu, 'outer shadow blur', 0),
        distanceEmu: finiteInteger(input.distanceEmu, 'outer shadow distance', 0),
        direction60000: finiteInteger(input.direction60000, 'outer shadow direction', -Number.MAX_SAFE_INTEGER),
        rotateWithShape: input.rotateWithShape,
        color: input.color,
    });
}
function decodeGlyphPaintColor(value) {
    const input = record(value, 'glyph paint color');
    exactKeys(input, ['red', 'green', 'blue', 'alpha'], 'glyph paint color');
    return Object.freeze({
        red: finiteInteger(input.red, 'glyph paint red', 0, 255),
        green: finiteInteger(input.green, 'glyph paint green', 0, 255),
        blue: finiteInteger(input.blue, 'glyph paint blue', 0, 255),
        alpha: finiteInteger(input.alpha, 'glyph paint alpha', 0, 255),
    });
}
function decodeGlyphPaintColorLine(value) {
    const input = record(value, 'glyph paint color line');
    exactKeys(input, ['extend', 'colorStops'], 'glyph paint color line');
    if (!Array.isArray(input.colorStops) ||
        input.colorStops.length === 0 ||
        input.colorStops.length > PPTX_RENDER_WIRE_LIMITS_V1.maxGradientStops) {
        throw new TypeError('glyph paint gradient stop budget exceeded');
    }
    return Object.freeze({
        extend: finiteInteger(input.extend, 'glyph paint extend', 0, 2),
        colorStops: Object.freeze(input.colorStops.map((stopValue, index) => {
            const stop = record(stopValue, `glyph paint color stop ${index}`);
            exactKeys(stop, ['offset', 'isForeground', 'color'], `glyph paint color stop ${index}`);
            if (typeof stop.isForeground !== 'boolean') {
                throw new TypeError('glyph paint foreground flag is invalid');
            }
            return Object.freeze({
                offset: finiteInteger(stop.offset, 'glyph paint color stop offset'),
                isForeground: stop.isForeground,
                color: decodeGlyphPaintColor(stop.color),
            });
        })),
    });
}
function decodeGlyphPaintCommand(value, index) {
    const input = record(value, `glyph paint command ${index}`);
    const kind = String(input.kind);
    const geometry = (fields) => Object.freeze(Object.fromEntries([
        ['kind', kind],
        ...fields.map((field) => [
            field,
            finiteInteger(input[field], `glyph paint ${kind}.${field}`),
        ]),
    ]));
    switch (kind) {
        case 'push-transform':
            exactKeys(input, ['kind', 'xx', 'yx', 'xy', 'yy', 'dx', 'dy'], `glyph paint command ${index}`);
            return geometry(['xx', 'yx', 'xy', 'yy', 'dx', 'dy']);
        case 'pop-transform':
        case 'pop-clip':
        case 'push-group':
            exactKeys(input, ['kind'], `glyph paint command ${index}`);
            return Object.freeze({ kind });
        case 'push-clip-glyph':
            exactKeys(input, ['kind', 'glyphId', 'path'], `glyph paint command ${index}`);
            return Object.freeze({
                kind,
                glyphId: finiteInteger(input.glyphId, 'glyph paint clip glyph id', 0),
                path: boundedText(input.path, 'glyph paint clip path', 1_000_000),
            });
        case 'push-clip-rectangle':
            exactKeys(input, ['kind', 'xMin', 'yMin', 'xMax', 'yMax'], `glyph paint command ${index}`);
            return geometry(['xMin', 'yMin', 'xMax', 'yMax']);
        case 'solid':
            exactKeys(input, ['kind', 'isForeground', 'color'], `glyph paint command ${index}`);
            if (typeof input.isForeground !== 'boolean') {
                throw new TypeError('glyph paint foreground flag is invalid');
            }
            return Object.freeze({
                kind,
                isForeground: input.isForeground,
                color: decodeGlyphPaintColor(input.color),
            });
        case 'linear-gradient':
            exactKeys(input, ['kind', 'colorLine', 'x0', 'y0', 'x1', 'y1', 'x2', 'y2'], `glyph paint command ${index}`);
            return Object.freeze({
                ...geometry(['x0', 'y0', 'x1', 'y1', 'x2', 'y2']),
                colorLine: decodeGlyphPaintColorLine(input.colorLine),
            });
        case 'radial-gradient':
            exactKeys(input, ['kind', 'colorLine', 'x0', 'y0', 'r0', 'x1', 'y1', 'r1'], `glyph paint command ${index}`);
            return Object.freeze({
                ...geometry(['x0', 'y0', 'r0', 'x1', 'y1', 'r1']),
                colorLine: decodeGlyphPaintColorLine(input.colorLine),
            });
        case 'sweep-gradient':
            exactKeys(input, ['kind', 'colorLine', 'x0', 'y0', 'startAngle', 'endAngle'], `glyph paint command ${index}`);
            return Object.freeze({
                ...geometry(['x0', 'y0', 'startAngle', 'endAngle']),
                colorLine: decodeGlyphPaintColorLine(input.colorLine),
            });
        case 'pop-group':
            exactKeys(input, ['kind', 'compositeMode'], `glyph paint command ${index}`);
            return Object.freeze({
                kind,
                compositeMode: finiteInteger(input.compositeMode, 'glyph paint composite mode', 0, 27),
            });
        default:
            throw new TypeError('unknown glyph paint command');
    }
}
function decodeGlyphColorPaint(value, budget) {
    if (value === null)
        return null;
    const input = record(value, 'glyph color paint');
    exactKeys(input, ['fixedScale', 'unitsPerEm', 'bounds', 'commands'], 'glyph color paint');
    if (input.fixedScale !== 1_000_000 || !Array.isArray(input.commands)) {
        throw new TypeError('glyph paint fixed-point contract is invalid');
    }
    budget.commands += input.commands.length;
    if (budget.commands > PPTX_RENDER_WIRE_LIMITS_V1.maxPathCommands) {
        throw new TypeError('glyph paint command budget exceeded');
    }
    const bounds = record(input.bounds, 'glyph paint bounds');
    exactKeys(bounds, ['xMin', 'yMin', 'xMax', 'yMax'], 'glyph paint bounds');
    const decodedBounds = Object.freeze({
        xMin: finiteInteger(bounds.xMin, 'glyph paint bounds.xMin'),
        yMin: finiteInteger(bounds.yMin, 'glyph paint bounds.yMin'),
        xMax: finiteInteger(bounds.xMax, 'glyph paint bounds.xMax'),
        yMax: finiteInteger(bounds.yMax, 'glyph paint bounds.yMax'),
    });
    if (decodedBounds.xMax <= decodedBounds.xMin || decodedBounds.yMax <= decodedBounds.yMin) {
        throw new TypeError('glyph paint bounds are empty');
    }
    return Object.freeze({
        fixedScale: 1_000_000,
        unitsPerEm: finiteInteger(input.unitsPerEm, 'glyph paint unitsPerEm', 1),
        bounds: decodedBounds,
        commands: Object.freeze(input.commands.map((command, index) => decodeGlyphPaintCommand(command, index))),
    });
}
export function decodePptxHyperlinkV1(value) {
    const input = record(value, 'hyperlink');
    const label = boundedSourceText(input.label, 'hyperlink label', 4096);
    if (input.kind === 'external') {
        exactKeys(input, ['kind', 'url', 'label'], 'hyperlink');
        if (!isSafePptxHyperlinkUrlV1(input.url))
            throw new TypeError('unsupported hyperlink URL');
        return Object.freeze({ kind: 'external', url: input.url, label });
    }
    if (input.kind === 'slide') {
        exactKeys(input, ['kind', 'slideIndex', 'label'], 'hyperlink');
        return Object.freeze({
            kind: 'slide',
            slideIndex: nonNegativeInteger(input.slideIndex, 'hyperlink slide', 100_000),
            label,
        });
    }
    if (input.kind === 'relative-slide') {
        exactKeys(input, ['kind', 'jump', 'label'], 'hyperlink');
        if (!['first', 'last', 'next', 'previous'].includes(String(input.jump)))
            throw new TypeError('unsupported slide jump');
        return Object.freeze({
            kind: 'relative-slide',
            jump: input.jump,
            label,
        });
    }
    throw new TypeError('unsupported hyperlink action');
}
export function decodeRenderNode(value, index, budget) {
    const input = record(value, `render node ${index}`);
    const baseKeys = [
        'kind',
        'nodeId',
        'sourceNodeId',
        'parentId',
        'semanticRole',
        'paintOrder',
        'worldTransform',
        'paintBounds',
        'opacity100000',
        'visible',
        'clipIds',
    ];
    const extra = {
        group: ['childIds'],
        path: ['commands', 'fill', 'stroke', 'fillRule'],
        image: ['resourceId', 'sourceRect', 'destinationRect', 'sampling', 'mode'],
        glyphRun: [
            'text',
            'fontId',
            'fontSha256',
            'fontSizeEmu',
            'direction',
            'script',
            'language',
            'lineOrigin',
            'fill',
            'glyphs',
            'rasterization',
        ],
        clip: ['clipKind', 'rect', 'commands'],
    };
    const kind = String(input.kind);
    if (!extra[kind])
        throw new TypeError('unknown render node kind');
    const optionalKeys = [
        ...(Object.hasOwn(input, 'hyperlink') ? ['hyperlink'] : []),
        ...(Object.hasOwn(input, 'animationSubNodeKey') ? ['animationSubNodeKey'] : []),
        ...(kind === 'path' && Object.hasOwn(input, 'outerShadow') ? ['outerShadow'] : []),
        ...(kind === 'path' && Object.hasOwn(input, 'shadowOnly') ? ['shadowOnly'] : []),
        ...(kind === 'image' && Object.hasOwn(input, 'mediaResourceId')
            ? [
                'mediaResourceId',
                'mediaKind',
                ...(Object.hasOwn(input, 'mediaVolume100000') ? ['mediaVolume100000'] : []),
            ]
            : []),
    ];
    exactKeys(input, [...baseKeys, ...extra[kind], ...optionalKeys], `render node ${index}`);
    if (!Array.isArray(input.clipIds) ||
        input.clipIds.length > PPTX_RENDER_WIRE_LIMITS_V1.maxClipDepth)
        throw new TypeError('clip depth budget exceeded');
    const base = {
        kind,
        nodeId: renderNodeId(input.nodeId, 'nodeId'),
        sourceNodeId: pptIdentity(input.sourceNodeId, PPT_NODE_ID, 'sourceNodeId'),
        parentId: input.parentId === null ? null : renderNodeId(input.parentId, 'parentId'),
        semanticRole: boundedText(input.semanticRole, 'semanticRole', 128),
        paintOrder: finiteInteger(input.paintOrder, 'paintOrder', 0, PPTX_RENDER_WIRE_LIMITS_V1.maxNodes * 4),
        worldTransform: decodeTransform(input.worldTransform),
        paintBounds: decodeRect(input.paintBounds, 'paintBounds'),
        opacity100000: finiteInteger(input.opacity100000, 'opacity', 0, 100_000),
        visible: input.visible,
        clipIds: Object.freeze(input.clipIds.map((id) => renderNodeId(id, 'clipId'))),
    };
    if (Object.hasOwn(input, 'hyperlink'))
        base.hyperlink = decodePptxHyperlinkV1(input.hyperlink);
    if (Object.hasOwn(input, 'animationSubNodeKey')) {
        if (input.animationSubNodeKey !== null &&
            (typeof input.animationSubNodeKey !== 'string' ||
                (input.animationSubNodeKey !== 'chart:background' &&
                    !/^(?:paragraph|series|diagram-child):[A-Za-z0-9:._-]+$/u.test(input.animationSubNodeKey))))
            throw new TypeError('render animation sub-node key is invalid');
        base.animationSubNodeKey = input.animationSubNodeKey;
    }
    if (!SEMANTIC_ROLE.test(base.semanticRole) || typeof input.visible !== 'boolean')
        throw new TypeError('render node base is invalid');
    if (kind === 'group') {
        if (!Array.isArray(input.childIds) ||
            input.childIds.length > PPTX_RENDER_WIRE_LIMITS_V1.maxNodes)
            throw new TypeError('group children are invalid');
        base.childIds = Object.freeze(input.childIds.map((child) => renderNodeId(child, 'childId')));
    }
    else if (kind === 'path') {
        base.commands = decodeCommands(input.commands, budget);
        base.fill = decodeFill(input.fill);
        base.stroke = decodeStroke(input.stroke);
        base.outerShadow = Object.hasOwn(input, 'outerShadow')
            ? decodeOuterShadow(input.outerShadow)
            : null;
        if (Object.hasOwn(input, 'shadowOnly')) {
            if (typeof input.shadowOnly !== 'boolean' ||
                (input.shadowOnly && (!base.outerShadow || base.stroke !== null))) {
                throw new TypeError('shadow-only path requires an outer shadow and no stroke');
            }
            base.shadowOnly = input.shadowOnly;
        }
        if (input.fillRule !== 'nonzero' && input.fillRule !== 'evenodd')
            throw new TypeError('path fill rule is invalid');
        base.fillRule = input.fillRule;
    }
    else if (kind === 'image') {
        base.resourceId = renderResourceId(input.resourceId);
        if (Object.hasOwn(input, 'mediaResourceId')) {
            base.mediaResourceId = renderResourceId(input.mediaResourceId);
            if (input.mediaKind !== 'audio' && input.mediaKind !== 'video')
                throw new TypeError('image media kind is invalid');
            base.mediaKind = input.mediaKind;
            if (input.mediaVolume100000 !== undefined) {
                const volume = finiteInteger(input.mediaVolume100000, 'media volume', 0, 100_000);
                if (volume < 0 || volume > 100_000)
                    throw new TypeError('media volume is out of range');
                base.mediaVolume100000 = volume;
            }
        }
        base.sourceRect = decodeRect(input.sourceRect, 'sourceRect');
        base.destinationRect = decodeRect(input.destinationRect, 'destinationRect');
        if (!['nearest', 'linear'].includes(String(input.sampling)) ||
            !['stretch', 'tile'].includes(String(input.mode)))
            throw new TypeError('image sampling is invalid');
        base.sampling = input.sampling;
        base.mode = input.mode;
    }
    else if (kind === 'glyphRun') {
        if (!Array.isArray(input.glyphs))
            throw new TypeError('glyphs must be an array');
        budget.glyphs += input.glyphs.length;
        if (budget.glyphs > PPTX_RENDER_WIRE_LIMITS_V1.maxGlyphs)
            throw new TypeError('glyph budget exceeded');
        const origin = record(input.lineOrigin, 'lineOrigin');
        exactKeys(origin, ['x', 'y'], 'lineOrigin');
        base.text = boundedSourceText(input.text, 'glyph text', 1_000_000);
        base.fontId = boundedText(input.fontId, 'fontId', 256);
        base.fontSha256 = sha256(input.fontSha256, 'fontSha256');
        base.fontSizeEmu = finiteInteger(input.fontSizeEmu, 'fontSizeEmu', 1);
        if (!['ltr', 'rtl', 'ttb', 'btt'].includes(String(input.direction)) ||
            !['glyph-outline', 'glyph-color-paint'].includes(String(input.rasterization)))
            throw new TypeError('glyph run mode is invalid');
        base.direction = input.direction;
        base.script = boundedText(input.script, 'script', 32);
        base.language = boundedText(input.language, 'language', 64);
        base.lineOrigin = Object.freeze({
            x: finiteInteger(origin.x, 'lineOrigin.x'),
            y: finiteInteger(origin.y, 'lineOrigin.y'),
        });
        base.fill = decodeFill(input.fill);
        base.rasterization = input.rasterization;
        base.glyphs = Object.freeze(input.glyphs.map((glyph, glyphIndex) => {
            const row = record(glyph, `glyph ${glyphIndex}`);
            const fields = [
                'glyphId',
                'cluster',
                'sourceStart',
                'sourceEnd',
                'x',
                'y',
                'advanceX',
                'advanceY',
                'offsetX',
                'offsetY',
                'glyphPathKey',
                'outlinePath',
                'unitsPerEm',
                'colorPaint',
            ];
            exactKeys(row, fields, `glyph ${glyphIndex}`);
            return Object.freeze(Object.fromEntries(fields.map((field) => [
                field,
                field === 'glyphPathKey'
                    ? renderResourceId(row[field])
                    : field === 'outlinePath'
                        ? boundedText(row[field], 'glyph outline', 1_000_000, true)
                        : field === 'colorPaint'
                            ? decodeGlyphColorPaint(row[field], budget)
                            : finiteInteger(row[field], `glyph.${field}`, field === 'glyphId' ||
                                field === 'cluster' ||
                                field.startsWith('source') ||
                                field === 'unitsPerEm'
                                ? 0
                                : -Number.MAX_SAFE_INTEGER),
            ])));
        }));
    }
    else {
        if (!['rect', 'path'].includes(String(input.clipKind)))
            throw new TypeError('clip kind is invalid');
        base.clipKind = input.clipKind;
        base.rect = input.rect === null ? null : decodeRect(input.rect, 'clip rect');
        base.commands = decodeCommands(input.commands, budget);
    }
    return deepFreezeWire(base);
}
export function decodeRenderResourceRef(value, index) {
    const input = record(value, `resource ${index}`);
    exactKeys(input, [
        'resourceId',
        'kind',
        'mediaType',
        'byteLength',
        'sha256',
        'crc32',
        'sourceNodeIds',
        'failureDisposition',
    ], `resource ${index}`);
    if (!['image', 'vector-image', 'font', 'glyph-path', 'media-poster', 'media'].includes(String(input.kind)))
        throw new TypeError('resource kind is invalid');
    if (typeof input.mediaType !== 'string' || !MEDIA_TYPE.test(input.mediaType))
        throw new TypeError('resource media type is invalid');
    if (input.failureDisposition !== 'omit-node' &&
        input.failureDisposition !== 'static-approximation' &&
        input.failureDisposition !== 'slide-terminal') {
        throw new TypeError('resource failure disposition is invalid');
    }
    return Object.freeze({
        resourceId: renderResourceId(input.resourceId),
        kind: input.kind,
        mediaType: input.mediaType,
        byteLength: nonNegativeInteger(input.byteLength, 'resource byteLength', PPTX_RENDER_WIRE_LIMITS_V1.maxResourceBytes),
        sha256: input.sha256 === null ? null : sha256(input.sha256, 'resource sha256'),
        crc32: typeof input.crc32 === 'string' && /^crc32:[a-f0-9]{8}$/u.test(input.crc32)
            ? input.crc32
            : (() => {
                throw new TypeError('resource crc32 is invalid');
            })(),
        sourceNodeIds: boundedStrings(input.sourceNodeIds, 'resource sourceNodeIds', 256).map((nodeId) => pptIdentity(nodeId, PPT_NODE_ID, 'resource sourceNodeId')),
        failureDisposition: input.failureDisposition,
    });
}
//# sourceMappingURL=pptx-wire-validation.js.map