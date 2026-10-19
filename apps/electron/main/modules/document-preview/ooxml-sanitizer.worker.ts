import { posix } from "node:path";
import { parentPort } from "node:worker_threads";
import { crc32 } from "node:zlib";
import jszip from "jszip";
import yauzl from "yauzl";
import { PPTX_PREVIEW_LIMITS_V1 } from "@mavis/shared/document-preview";
const DEFAULT_LIMITS = Object.freeze({
    maxInputBytes: PPTX_PREVIEW_LIMITS_V1.maxInputBytes,
    maxEntries: PPTX_PREVIEW_LIMITS_V1.maxEntries,
    maxEntryUncompressedBytes: PPTX_PREVIEW_LIMITS_V1.maxEntryUncompressedBytes,
    maxTotalUncompressedBytes: PPTX_PREVIEW_LIMITS_V1.maxTotalUncompressedBytes,
    maxMediaBytes: PPTX_PREVIEW_LIMITS_V1.maxMediaBytes,
    maxConcurrentEntryReads: PPTX_PREVIEW_LIMITS_V1.maxConcurrentEntryReads,
    maxSlideNodes: PPTX_PREVIEW_LIMITS_V1.maxSlideNodes,
});
const XML_ENTRY = /(?:\.xml|\.rels|\.svg|\.vml|\.css)$/iu;
const MEDIA_ENTRY = /(?:^|\/)(?:ppt|word|xl)\/media\//iu;
const FORBIDDEN_ELEMENTS = new Set(['foreignobject', 'script', 'iframe', 'object', 'embed']);
const SMIL_ELEMENTS = new Set(['animate', 'animatemotion', 'animatetransform', 'set']);
const URL_ATTRIBUTES = new Set([
    'href',
    'src',
    'fill',
    'stroke',
    'clip-path',
    'style',
    'action',
    'link',
    'hyperlink',
    'data',
    'formaction',
    'poster',
    'background',
    'cursor',
    'filter',
    'mask',
    'marker-start',
    'marker-mid',
    'marker-end',
]);
const ALLOWED_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/iu;
const PRESENTATION_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const SVG_PAINT_ATTRIBUTES = new Set([
    'fill',
    'stroke',
    'clip-path',
    'filter',
    'mask',
    'marker-start',
    'marker-mid',
    'marker-end',
    'cursor',
]);
const SAFE_XML_DECLARATION = /^<\?xml\s+version\s*=\s*(["'])1\.[01]\1(?:\s+encoding\s*=\s*(["'])(?:utf-8|utf-16)\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>$/iu;
// SharePoint stores a benign content-type marker in custom XML parts. It is a
// processing instruction with no payload or external target; keep the
// sanitizer fail-closed for every other non-declaration processing
// instruction (notably xml-stylesheet).
const SAFE_OFFICE_METADATA_PROCESSING_INSTRUCTION = /^\s*mso-contenttype\s*$/iu;
const FEATURE_SEVERITIES = Object.freeze({
    animation: 'info',
    'speaker-notes': 'info',
    ole: 'fallback',
    'emf-wmf': 'fallback',
    'external-relationship': 'info',
    'embedded-font': 'info',
    formula: 'fallback',
    'unknown-graphic-frame': 'fallback',
});
const KNOWN_GRAPHIC_DATA_URIS = [
    '/drawingml/2006/table',
    '/drawingml/2006/chart',
    '/drawingml/2006/diagram',
    '/presentationml/2006/ole',
    '/office/word/2010/wordprocessingShape',
];
function failure(code, message, retryable = false) {
    return {
        ok: false,
        error: { schema: 'mavis.preview_error.v1', code, message, retryable },
    };
}
function localName(name) {
    const separator = name.lastIndexOf(':');
    return name.slice(separator + 1).toLowerCase();
}
function isNameCharacter(value) {
    return value !== undefined && !/[\s=/>]/u.test(value);
}
function skipMarkup(text, index) {
    if (text.startsWith('<!--', index)) {
        const end = text.indexOf('-->', index + 4);
        return end < 0 ? null : end + 3;
    }
    if (text.startsWith('<![CDATA[', index)) {
        const end = text.indexOf(']]>', index + 9);
        return end < 0 ? null : end + 3;
    }
    if (text.startsWith('<?', index)) {
        const end = text.indexOf('?>', index + 2);
        if (end < 0)
            return null;
        const firstNonWhitespace = text.search(/\S/u);
        const declaration = text.slice(index, end + 2);
        if (index === firstNonWhitespace && SAFE_XML_DECLARATION.test(declaration))
            return end + 2;
        const processingInstruction = text.slice(index + 2, end);
        return SAFE_OFFICE_METADATA_PROCESSING_INSTRUCTION.test(processingInstruction)
            ? end + 2
            : null;
    }
    if (text.startsWith('<!', index)) {
        return null;
    }
    return index;
}
function tokenizeTags(text) {
    const tokens = [];
    let cursor = 0;
    while (cursor < text.length) {
        const start = text.indexOf('<', cursor);
        if (start < 0)
            break;
        const markupEnd = skipMarkup(text, start);
        if (markupEnd === null)
            return null;
        if (markupEnd !== start) {
            cursor = markupEnd;
            continue;
        }
        let index = start + 1;
        let closing = false;
        if (text[index] === '/') {
            closing = true;
            index += 1;
        }
        while (/\s/u.test(text[index] ?? ''))
            index += 1;
        const nameStart = index;
        while (isNameCharacter(text[index]))
            index += 1;
        const name = text.slice(nameStart, index);
        if (!name)
            return null;
        const attributes = [];
        let selfClosing = false;
        let closed = false;
        while (index < text.length && index - start <= 1024 * 1024) {
            while (/\s/u.test(text[index] ?? ''))
                index += 1;
            if (text[index] === '>') {
                index += 1;
                closed = true;
                break;
            }
            if (text[index] === '/' && text[index + 1] === '>') {
                index += 2;
                selfClosing = true;
                closed = true;
                break;
            }
            if (closing)
                return null;
            const attributeStart = index;
            while (isNameCharacter(text[index]))
                index += 1;
            const attributeName = text.slice(attributeStart, index);
            if (!attributeName || attributes.length >= 1024)
                return null;
            while (/\s/u.test(text[index] ?? ''))
                index += 1;
            let value = null;
            if (text[index] === '=') {
                index += 1;
                while (/\s/u.test(text[index] ?? ''))
                    index += 1;
                const quote = text[index];
                if (quote !== '"' && quote !== "'")
                    return null;
                index += 1;
                const valueStart = index;
                const valueEnd = text.indexOf(quote, valueStart);
                if (valueEnd < 0 || valueEnd - start > 1024 * 1024)
                    return null;
                value = text.slice(valueStart, valueEnd);
                index = valueEnd + 1;
            }
            attributes.push({ name: attributeName, localName: localName(attributeName), value });
        }
        if (!closed)
            return null;
        tokens.push({
            start,
            end: index,
            name,
            localName: localName(name),
            closing,
            selfClosing,
            attributes,
        });
        cursor = index;
    }
    return tokens;
}
function decodeXmlEntities(value) {
    return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/giu, (_match, decimal, hex, named) => {
        if (decimal)
            return String.fromCodePoint(Number.parseInt(decimal, 10));
        if (hex)
            return String.fromCodePoint(Number.parseInt(hex, 16));
        switch (String(named).toLowerCase()) {
            case 'amp':
                return '&';
            case 'lt':
                return '<';
            case 'gt':
                return '>';
            case 'quot':
                return '"';
            case 'apos':
                return "'";
            default:
                return _match;
        }
    });
}
function decodeCssEscapes(value) {
    return value.replace(/\\([0-9a-f]{1,6})\s?|\\(.)/giu, (_match, hex, escaped) => {
        if (hex)
            return String.fromCodePoint(Number.parseInt(hex, 16));
        return escaped ?? '';
    });
}
function normalizedUrlValue(value) {
    let decoded = decodeCssEscapes(decodeXmlEntities(value)).trim();
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded)
                break;
            decoded = next;
        }
        catch {
            break;
        }
    }
    return decoded.replace(/[\u0000-\u0020\u007f]/gu, '').toLowerCase();
}
function isUnsafeUrl(value) {
    const normalized = normalizedUrlValue(value);
    if (!normalized || normalized.startsWith('#'))
        return false;
    if (normalized.startsWith('//') || normalized.startsWith('\\\\')) {
        return true;
    }
    if (normalized.startsWith('data:'))
        return !ALLOWED_DATA_URL.test(decodeXmlEntities(value).trim());
    if (/^[a-z][a-z0-9+.-]*:/iu.test(normalized))
        return true;
    return false;
}
function isUnsafeSvgUrl(value) {
    const normalized = normalizedUrlValue(value);
    if (!normalized || normalized.startsWith('#'))
        return false;
    if (normalized.startsWith('data:')) {
        return !ALLOWED_DATA_URL.test(decodeXmlEntities(value).trim());
    }
    return true;
}
function cssUrlValues(value) {
    const urls = [];
    let cursor = 0;
    const consumeComment = (index) => {
        const end = value.indexOf('*/', index + 2);
        return end < 0 ? null : end + 2;
    };
    const consumeEscape = (index) => {
        if (value[index] !== '\\' || index + 1 >= value.length)
            return null;
        const hex = value.slice(index + 1).match(/^[0-9a-f]{1,6}/iu)?.[0];
        if (hex) {
            let end = index + 1 + hex.length;
            if (/\s/u.test(value[end] ?? ''))
                end += 1;
            const codePoint = Number.parseInt(hex, 16);
            return {
                end,
                decoded: codePoint === 0 || codePoint > 0x10ffff ? '\ufffd' : String.fromCodePoint(codePoint),
            };
        }
        return { end: index + 2, decoded: value[index + 1] ?? '' };
    };
    const consumeString = (index) => {
        const quote = value[index];
        let current = index + 1;
        while (current < value.length) {
            if (value[current] === quote)
                return current + 1;
            if (value[current] === '\\') {
                const escape = consumeEscape(current);
                if (!escape)
                    return null;
                current = escape.end;
            }
            else {
                current += 1;
            }
        }
        return null;
    };
    const skipTrivia = (index) => {
        let current = index;
        while (current < value.length) {
            if (/\s/u.test(value[current] ?? '')) {
                current += 1;
            }
            else if (value.startsWith('/*', current)) {
                const end = consumeComment(current);
                if (end === null)
                    return null;
                current = end;
            }
            else {
                break;
            }
        }
        return current;
    };
    const consumeIdentifier = (index) => {
        let current = index;
        let decoded = '';
        while (current < value.length) {
            const character = value[current];
            if (character === '\\') {
                const escape = consumeEscape(current);
                if (!escape)
                    return null;
                decoded += escape.decoded;
                current = escape.end;
            }
            else if (character && /[a-z0-9_-]/iu.test(character)) {
                decoded += character;
                current += 1;
            }
            else {
                break;
            }
        }
        return current === index ? null : { end: current, decoded };
    };
    while (cursor < value.length) {
        if (value.startsWith('/*', cursor)) {
            const end = consumeComment(cursor);
            if (end === null)
                return null;
            cursor = end;
            continue;
        }
        if (value[cursor] === '"' || value[cursor] === "'") {
            const end = consumeString(cursor);
            if (end === null)
                return null;
            cursor = end;
            continue;
        }
        const identifier = consumeIdentifier(cursor);
        if (!identifier) {
            cursor += 1;
            continue;
        }
        cursor = identifier.end;
        if (identifier.decoded.toLowerCase() !== 'url')
            continue;
        let index = skipTrivia(cursor);
        if (index === null)
            return null;
        if (value[index] !== '(') {
            continue;
        }
        index += 1;
        index = skipTrivia(index);
        if (index === null)
            return null;
        const quote = value[index] === '"' || value[index] === "'" ? value[index++] : null;
        if (quote) {
            const start = index;
            const end = consumeString(index - 1);
            if (end === null)
                return null;
            urls.push(value.slice(start, end - 1));
            index = skipTrivia(end);
            if (index === null)
                return null;
            if (value[index] !== ')')
                return null;
            cursor = index + 1;
        }
        else {
            let url = '';
            let closed = false;
            while (index < value.length) {
                if (value[index] === ')') {
                    closed = true;
                    index += 1;
                    break;
                }
                if (value.startsWith('/*', index)) {
                    const end = consumeComment(index);
                    if (end === null)
                        return null;
                    url += ' ';
                    index = end;
                    continue;
                }
                if (value[index] === '"' || value[index] === "'" || value[index] === '(')
                    return null;
                if (value[index] === '\\') {
                    const escape = consumeEscape(index);
                    if (!escape)
                        return null;
                    url += value.slice(index, escape.end);
                    index = escape.end;
                    continue;
                }
                url += value[index];
                index += 1;
            }
            if (!closed)
                return null;
            urls.push(url.trim());
            cursor = index;
        }
    }
    return urls;
}
function hasUnsafeCss(value, urlPolicy = isUnsafeUrl) {
    const decoded = decodeCssEscapes(decodeXmlEntities(value));
    if (/(?:expression\s*\(|@import\b|-moz-binding\s*:)/iu.test(decoded))
        return true;
    const urls = cssUrlValues(decoded);
    return urls === null || urls.some(urlPolicy);
}
function hasUnsafeSvgAttribute(name, value) {
    if (name === 'style')
        return hasUnsafeCss(value, isUnsafeSvgUrl);
    if (!SVG_PAINT_ATTRIBUTES.has(name))
        return isUnsafeSvgUrl(value);
    const decoded = decodeCssEscapes(decodeXmlEntities(value));
    const urls = cssUrlValues(decoded);
    if (urls === null)
        return true;
    if (urls.length > 0)
        return urls.some(isUnsafeSvgUrl);
    const normalized = normalizedUrlValue(value);
    return (normalized.startsWith('data:') ||
        normalized.startsWith('//') ||
        normalized.startsWith('\\\\') ||
        /^[a-z][a-z0-9+.-]*:/iu.test(normalized));
}
function attributeValue(token, name) {
    return token.attributes.find((attribute) => attribute.localName === name)?.value ?? null;
}
function removeExternalRelationships(text, tokens) {
    const ranges = [];
    for (const token of tokens) {
        if (token.closing || token.localName !== 'relationship')
            continue;
        const targetMode = decodeXmlEntities(attributeValue(token, 'targetmode') ?? '')
            .trim()
            .toLowerCase();
        const target = normalizedUrlValue(attributeValue(token, 'target') ?? '');
        if (targetMode === 'external' ||
            /^(?:https?|file):/iu.test(target) ||
            target.startsWith('//') ||
            target.startsWith('\\\\')) {
            ranges.push({ start: token.start, end: token.end });
        }
    }
    if (ranges.length === 0)
        return { text, removed: 0 };
    let cursor = 0;
    let output = '';
    for (const range of ranges) {
        output += text.slice(cursor, range.start);
        cursor = range.end;
    }
    output += text.slice(cursor);
    return { text: output, removed: ranges.length };
}
function hasUnsafeXml(text, tokens, svgContext = false) {
    for (const token of tokens) {
        if (token.closing)
            continue;
        if (FORBIDDEN_ELEMENTS.has(token.localName))
            return true;
        for (const attribute of token.attributes) {
            if (attribute.name.toLowerCase() === 'xml:base')
                return true;
            if (/^on/u.test(attribute.localName))
                return true;
            if (attribute.value === null)
                continue;
            const isRelationshipTarget = token.localName === 'relationship' && attribute.localName === 'target';
            if (isRelationshipTarget || !URL_ATTRIBUTES.has(attribute.localName))
                continue;
            if (svgContext
                ? hasUnsafeSvgAttribute(attribute.localName, attribute.value)
                : attribute.localName === 'style'
                    ? hasUnsafeCss(attribute.value)
                    : isUnsafeUrl(attribute.value)) {
                return true;
            }
        }
        if (SMIL_ELEMENTS.has(token.localName)) {
            const dynamicTarget = localName(attributeValue(token, 'attributename') ?? '');
            if (URL_ATTRIBUTES.has(dynamicTarget)) {
                for (const dynamicName of ['from', 'to', 'by', 'values']) {
                    const dynamicValue = attributeValue(token, dynamicName);
                    if (dynamicValue === null)
                        continue;
                    const candidates = dynamicName === 'values' ? dynamicValue.split(';') : [dynamicValue];
                    if (candidates.some((candidate) => svgContext
                        ? hasUnsafeSvgAttribute(dynamicTarget, candidate)
                        : dynamicTarget === 'style'
                            ? hasUnsafeCss(candidate)
                            : isUnsafeUrl(candidate))) {
                        return true;
                    }
                }
            }
        }
    }
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.closing || token.selfClosing || token.localName !== 'style')
            continue;
        const closing = tokens
            .slice(index + 1)
            .find((candidate) => candidate.closing && candidate.localName === 'style');
        if (!closing ||
            hasUnsafeCss(text.slice(token.end, closing.start), svgContext ? isUnsafeSvgUrl : isUnsafeUrl))
            return true;
    }
    return false;
}
function contentTypeDeclaredSvgEntries(entryBytes) {
    const contentTypesEntry = entryBytes.get('[Content_Types].xml');
    if (!contentTypesEntry)
        return new Set();
    const text = contentTypesEntry.toString('utf8');
    const tokens = tokenizeTags(text);
    if (!tokens || hasUnsafeXml(text, tokens))
        return null;
    const overrideParts = new Set();
    const defaultExtensions = new Set();
    for (const token of tokens) {
        if (token.closing)
            continue;
        const contentType = decodeXmlEntities(attributeValue(token, 'contenttype') ?? '')
            .trim()
            .toLowerCase();
        if (contentType !== 'image/svg+xml')
            continue;
        if (token.localName === 'override') {
            const partName = decodeXmlEntities(attributeValue(token, 'partname') ?? '').trim();
            if (partName.startsWith('/'))
                overrideParts.add(partName.slice(1));
        }
        else if (token.localName === 'default') {
            const extension = decodeXmlEntities(attributeValue(token, 'extension') ?? '')
                .trim()
                .toLowerCase();
            if (extension && !extension.includes('/') && !extension.includes('\\')) {
                defaultExtensions.add(extension);
            }
        }
    }
    return new Set([...entryBytes.keys()].filter((name) => {
        if (overrideParts.has(name))
            return true;
        const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : '';
        return extension !== undefined && defaultExtensions.has(extension);
    }));
}
function unsafeEntryName(name, directory) {
    if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/u.test(name))
        return true;
    const normalized = directory ? name.replace(/\/+$/u, '') : name;
    return !normalized || normalized.split('/').some((segment) => segment === '..' || segment === '');
}
class OoxmlArchiveFailure extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
function relationshipSourcePart(name) {
    if (name === '_rels/.rels')
        return '';
    const match = /^(.*)\/_rels\/([^/]+)\.rels$/u.exec(name);
    if (!match)
        return null;
    const directory = match[1] ?? '';
    const fileName = match[2] ?? '';
    return directory && fileName ? `${directory}/${fileName}` : null;
}
function resolveInternalRelationshipTarget(relsName, rawTarget) {
    const sourcePart = relationshipSourcePart(relsName);
    if (sourcePart === null)
        return null;
    let target = decodeXmlEntities(rawTarget).trim();
    try {
        target = decodeURIComponent(target);
    }
    catch {
        return null;
    }
    if (!target ||
        target.includes('\\') ||
        target.includes('\0') ||
        target.includes('?') ||
        target.includes('#') ||
        target.startsWith('//') ||
        /^[a-z][a-z0-9+.-]*:/iu.test(target)) {
        return null;
    }
    const packageAbsolute = target.startsWith('/');
    const candidate = packageAbsolute
        ? posix.normalize(target.slice(1))
        : posix.normalize(posix.join(posix.dirname(sourcePart), target));
    if (!candidate ||
        candidate === '.' ||
        candidate === '..' ||
        candidate.startsWith('../') ||
        candidate.startsWith('/')) {
        return null;
    }
    return candidate;
}
function validateInternalRelationships(relsName, tokens, entryBytes) {
    if (relationshipSourcePart(relsName) === null)
        return false;
    for (const token of tokens) {
        if (token.closing || token.localName !== 'relationship')
            continue;
        const targetMode = decodeXmlEntities(attributeValue(token, 'targetmode') ?? '')
            .trim()
            .toLowerCase();
        if (targetMode && targetMode !== 'internal')
            return false;
        const target = resolveInternalRelationshipTarget(relsName, attributeValue(token, 'target') ?? '');
        if (!target || !entryBytes.has(target))
            return false;
    }
    return true;
}
function openZip(input) {
    return new Promise((resolve, reject) => {
        const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
        yauzl.fromBuffer(buffer, {
            lazyEntries: true,
            autoClose: false,
            validateEntrySizes: false,
            strictFileNames: true,
        }, (error, zipFile) => {
            if (error || !zipFile) {
                reject(new OoxmlArchiveFailure('invalid_source_archive', 'OOXML source is not a valid ZIP archive'));
                return;
            }
            resolve(zipFile);
        });
    });
}
function collectEntries(zipFile, limits) {
    if (zipFile.entryCount > limits.maxEntries) {
        return Promise.reject(new OoxmlArchiveFailure('resource_limit_exceeded', 'OOXML archive contains too many entries'));
    }
    return new Promise((resolve, reject) => {
        const entries = [];
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            zipFile.removeListener('entry', handleEntry);
            zipFile.removeListener('end', handleEnd);
            zipFile.removeListener('error', handleError);
            if (error)
                reject(error);
            else
                resolve(entries);
        };
        const handleEntry = (entry) => {
            const directory = entry.fileName.endsWith('/');
            if (unsafeEntryName(entry.fileName, directory)) {
                finish(new OoxmlArchiveFailure('invalid_source_archive', 'OOXML archive contains an unsafe entry name'));
                return;
            }
            if (entry.isEncrypted()) {
                finish(new OoxmlArchiveFailure('invalid_source_archive', 'OOXML archive contains an encrypted entry'));
                return;
            }
            entries.push(entry);
            zipFile.readEntry();
        };
        const handleEnd = () => finish();
        const handleError = () => finish(new OoxmlArchiveFailure('invalid_source_archive', 'OOXML archive directory could not be read safely'));
        zipFile.on('entry', handleEntry);
        zipFile.once('end', handleEnd);
        zipFile.once('error', handleError);
        zipFile.readEntry();
    });
}
function assertDeclaredBudgets(entries, limits) {
    let totalBytes = 0;
    let mediaBytes = 0;
    for (const entry of entries) {
        if (entry.fileName.endsWith('/'))
            continue;
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
            throw new OoxmlArchiveFailure('invalid_source_archive', 'OOXML archive entry metadata is invalid');
        }
        if (entry.uncompressedSize > limits.maxEntryUncompressedBytes) {
            throw new OoxmlArchiveFailure('resource_limit_exceeded', 'OOXML archive entry exceeds the uncompressed byte limit');
        }
        totalBytes += entry.uncompressedSize;
        if (totalBytes > limits.maxTotalUncompressedBytes) {
            throw new OoxmlArchiveFailure('resource_limit_exceeded', 'OOXML archive exceeds the total uncompressed byte limit');
        }
        if (MEDIA_ENTRY.test(entry.fileName))
            mediaBytes += entry.uncompressedSize;
        if (mediaBytes > limits.maxMediaBytes) {
            throw new OoxmlArchiveFailure('resource_limit_exceeded', 'OOXML archive exceeds the media byte limit');
        }
    }
}
function readEntryStream(zipFile, entry) {
    return new Promise((resolve, reject) => {
        zipFile.openReadStream(entry, (error, stream) => {
            if (error)
                reject(error);
            else
                resolve(stream);
        });
    });
}
async function readBoundedEntries(zipFile, entries, limits) {
    const files = entries.filter((entry) => !entry.fileName.endsWith('/'));
    const output = new Map();
    const activeStreams = new Set();
    let totalBytes = 0;
    let mediaBytes = 0;
    let fatalError = null;
    let archiveMismatch = null;
    const stopAll = (error) => {
        if (!fatalError) {
            fatalError = error;
            for (const stream of activeStreams)
                stream.destroy(error);
        }
        return fatalError;
    };
    await mapWithConcurrency(files, limits.maxConcurrentEntryReads, async (entry) => {
        if (fatalError)
            throw fatalError;
        let stream;
        try {
            stream = await readEntryStream(zipFile, entry);
        }
        catch {
            throw stopAll(new OoxmlArchiveFailure('invalid_source_archive', 'OOXML archive entry could not be opened safely'));
        }
        if (fatalError) {
            stream.destroy();
            throw fatalError;
        }
        activeStreams.add(stream);
        const chunks = [];
        let entryBytes = 0;
        let checksum = 0;
        try {
            await new Promise((resolve, reject) => {
                stream.on('data', (chunk) => {
                    if (fatalError)
                        return;
                    entryBytes += chunk.byteLength;
                    totalBytes += chunk.byteLength;
                    if (MEDIA_ENTRY.test(entry.fileName))
                        mediaBytes += chunk.byteLength;
                    if (entryBytes > limits.maxEntryUncompressedBytes) {
                        stopAll(new OoxmlArchiveFailure('resource_limit_exceeded', 'OOXML archive entry exceeds the actual uncompressed byte limit'));
                        return;
                    }
                    if (totalBytes > limits.maxTotalUncompressedBytes) {
                        stopAll(new OoxmlArchiveFailure('resource_limit_exceeded', 'OOXML archive exceeds the actual total uncompressed byte limit'));
                        return;
                    }
                    if (mediaBytes > limits.maxMediaBytes) {
                        stopAll(new OoxmlArchiveFailure('resource_limit_exceeded', 'OOXML archive exceeds the actual media byte limit'));
                        return;
                    }
                    checksum = crc32(chunk, checksum) >>> 0;
                    chunks.push(chunk);
                });
                stream.once('end', resolve);
                stream.once('error', reject);
            });
        }
        catch (error) {
            if (fatalError)
                throw fatalError;
            throw stopAll(new OoxmlArchiveFailure('invalid_source_archive', 'OOXML archive entry could not be decompressed safely'));
        }
        finally {
            activeStreams.delete(stream);
        }
        if (fatalError)
            throw fatalError;
        if (entryBytes !== entry.uncompressedSize || checksum !== entry.crc32 >>> 0) {
            archiveMismatch ?? (archiveMismatch = new OoxmlArchiveFailure('invalid_source_archive', 'OOXML archive entry size or CRC does not match the central directory'));
            return;
        }
        output.set(entry.fileName, Buffer.concat(chunks, entryBytes));
    }, () => fatalError !== null);
    if (fatalError)
        throw fatalError;
    if (archiveMismatch)
        throw archiveMismatch;
    return output;
}
async function mapWithConcurrency(items, concurrency, task, shouldStop = () => false) {
    let cursor = 0;
    const settled = await Promise.allSettled(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
        while (cursor < items.length) {
            if (shouldStop())
                return;
            const index = cursor;
            cursor += 1;
            const item = items[index];
            if (item !== undefined)
                await task(item);
        }
    }));
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected)
        throw rejected.reason;
}
function countMatches(value, expression) {
    return Array.from(value.matchAll(expression)).length;
}
function countUnknownGraphicFrames(xml) {
    let count = 0;
    for (const match of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?graphicData\b[^>]*\buri\s*=\s*["']([^"']+)["'][^>]*>/giu)) {
        const uri = match[1] ?? '';
        if (!KNOWN_GRAPHIC_DATA_URIS.some((known) => uri.endsWith(known)))
            count += 1;
    }
    return count;
}
function relationshipIdReference(token) {
    return (token.attributes.find((attribute) => attribute.localName === 'id' && attribute.name.includes(':'))?.value ?? null);
}
function validatePptxGraph(entryBytes, textByName) {
    const contentTypes = textByName.get('[Content_Types].xml');
    const rootRelationships = textByName.get('_rels/.rels');
    const presentation = textByName.get('ppt/presentation.xml');
    const presentationRelationships = textByName.get('ppt/_rels/presentation.xml.rels');
    if (!contentTypes || !rootRelationships || !presentation || !presentationRelationships) {
        throw new OoxmlArchiveFailure('invalid_source_archive', 'PPTX required parts are missing');
    }
    const contentTypeTokens = tokenizeTags(contentTypes);
    const rootRelationshipTokens = tokenizeTags(rootRelationships);
    const presentationTokens = tokenizeTags(presentation);
    const presentationRelationshipTokens = tokenizeTags(presentationRelationships);
    if (!contentTypeTokens ||
        !rootRelationshipTokens ||
        !presentationTokens ||
        !presentationRelationshipTokens) {
        throw new OoxmlArchiveFailure('invalid_source_archive', 'PPTX required parts are invalid');
    }
    const contentTypeByPart = new Map();
    for (const token of contentTypeTokens) {
        if (token.closing || token.localName !== 'override')
            continue;
        const rawPart = decodeXmlEntities(attributeValue(token, 'partname') ?? '').trim();
        const part = rawPart.startsWith('/') ? posix.normalize(rawPart.slice(1)) : '';
        if (!part || part.startsWith('../'))
            continue;
        contentTypeByPart.set(part, decodeXmlEntities(attributeValue(token, 'contenttype') ?? '')
            .trim()
            .toLowerCase());
    }
    if (contentTypeByPart.get('ppt/presentation.xml') !== PRESENTATION_CONTENT_TYPE) {
        throw new OoxmlArchiveFailure('invalid_source_archive', 'PPTX presentation content type is missing');
    }
    const officeDocument = rootRelationshipTokens.find((token) => {
        if (token.closing || token.localName !== 'relationship')
            return false;
        const type = decodeXmlEntities(attributeValue(token, 'type') ?? '')
            .trim()
            .toLowerCase();
        const target = resolveInternalRelationshipTarget('_rels/.rels', attributeValue(token, 'target') ?? '');
        return type.endsWith('/officedocument') && target === 'ppt/presentation.xml';
    });
    if (!officeDocument) {
        throw new OoxmlArchiveFailure('invalid_source_archive', 'PPTX package officeDocument relationship is missing');
    }
    const slideRelationships = new Map();
    for (const token of presentationRelationshipTokens) {
        if (token.closing || token.localName !== 'relationship')
            continue;
        const type = decodeXmlEntities(attributeValue(token, 'type') ?? '')
            .trim()
            .toLowerCase();
        if (!type.endsWith('/slide'))
            continue;
        const id = decodeXmlEntities(attributeValue(token, 'id') ?? '').trim();
        const target = resolveInternalRelationshipTarget('ppt/_rels/presentation.xml.rels', attributeValue(token, 'target') ?? '');
        if (id && target)
            slideRelationships.set(id, target);
    }
    for (const token of presentationTokens) {
        if (token.closing || token.localName !== 'sldid')
            continue;
        const relationshipId = decodeXmlEntities(relationshipIdReference(token) ?? '').trim();
        const slidePart = slideRelationships.get(relationshipId);
        if (!slidePart ||
            !/^ppt\/slides\/[^/]+\.xml$/iu.test(slidePart) ||
            !entryBytes.has(slidePart) ||
            contentTypeByPart.get(slidePart) !== SLIDE_CONTENT_TYPE) {
            throw new OoxmlArchiveFailure('invalid_source_archive', 'PPTX presentation slide graph is incomplete');
        }
    }
}
function collectPptxPreflight(entryBytes, removedExternalRelationshipCount, limits, requested) {
    const entryNames = [...entryBytes.keys()];
    const pptxLooking = entryNames.some((name) => name === 'ppt/presentation.xml' || /^ppt\/slides\//iu.test(name));
    if (!pptxLooking && !requested)
        return null;
    const textByName = new Map();
    for (const [name, bytes] of entryBytes) {
        if (XML_ENTRY.test(name))
            textByName.set(name, bytes.toString('utf8'));
    }
    validatePptxGraph(entryBytes, textByName);
    const slideXml = [...textByName]
        .filter(([name]) => /^ppt\/slides\/[^/]+\.xml$/iu.test(name))
        .map(([, text]) => text);
    let slideNodes = 0;
    for (const xml of slideXml) {
        slideNodes += countMatches(xml, /<(?![!?/])(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*(?=[\s/>])/gu);
        if (slideNodes > limits.maxSlideNodes) {
            throw new OoxmlArchiveFailure('resource_limit_exceeded', 'PPTX slide node count exceeds the preview budget');
        }
    }
    const relationshipXml = [...textByName]
        .filter(([name]) => name.endsWith('.rels'))
        .map(([, text]) => text);
    const oleEntries = entryNames.filter((name) => /^ppt\/embeddings\/oleObject[^/]*$/iu.test(name));
    const oleNodes = slideXml.reduce((total, xml) => total + countMatches(xml, /<(?:\w+:)?oleObj\b/giu), 0);
    const fontEntries = entryNames.filter((name) => /^ppt\/fonts\/[^/]+\.(?:odttf|ttf|otf)$/iu.test(name));
    const fontRelationships = relationshipXml.reduce((total, xml) => total + countMatches(xml, /<Relationship\b[^>]*\bType=["'][^"']*\/font["']/giu), 0);
    const formulas = [...textByName].reduce((total, [name, xml]) => {
        if (/^ppt\/charts\/[^/]+\.xml$/iu.test(name))
            return total;
        return total + countMatches(xml, /<(?:\w+:)?oMath\b/giu);
    }, 0);
    const counts = {
        animation: entryNames.filter((name) => /^ppt\/animations\/[^/]+\.xml$/iu.test(name)).length +
            slideXml.reduce((total, xml) => total + countMatches(xml, /<(?:\w+:)?timing\b/giu), 0),
        'speaker-notes': entryNames.filter((name) => /^ppt\/notesSlides\/[^/]+\.xml$/iu.test(name))
            .length,
        ole: Math.max(oleEntries.length, oleNodes),
        'emf-wmf': entryNames.filter((name) => /^ppt\/media\/[^/]+\.(?:emf|wmf)$/iu.test(name)).length,
        'external-relationship': removedExternalRelationshipCount,
        'embedded-font': Math.max(fontEntries.length, fontRelationships),
        formula: formulas,
        'unknown-graphic-frame': slideXml.reduce((total, xml) => total + countUnknownGraphicFrames(xml), 0),
    };
    const features = Object.keys(FEATURE_SEVERITIES)
        .filter((kind) => counts[kind] > 0)
        .map((kind) => ({ kind, count: counts[kind], severity: FEATURE_SEVERITIES[kind] }));
    return {
        features,
        warnings: features.map(({ kind, count }) => `PPTX preflight detected ${count} ${kind} feature${count === 1 ? '' : 's'}`),
        requiresFidelityFallback: features.some(({ severity }) => severity === 'fallback'),
        externalRelationshipCount: removedExternalRelationshipCount,
    };
}
export async function sanitizeOoxmlArchive(input, limitOverrides = {}, options = {}) {
    const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
    for (const key of Object.keys(DEFAULT_LIMITS)) {
        const value = limits[key];
        if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_LIMITS[key]) {
            return failure('invalid_request', `OOXML ZIP budget ${key} is invalid`);
        }
    }
    if (!(input instanceof Uint8Array) || input.byteLength > limits.maxInputBytes) {
        return failure('resource_limit_exceeded', 'OOXML input exceeds the compressed byte limit');
    }
    let entryBytes;
    let zipFile;
    try {
        zipFile = await openZip(input);
        const entries = await collectEntries(zipFile, limits);
        assertDeclaredBudgets(entries, limits);
        entryBytes = await readBoundedEntries(zipFile, entries, limits);
    }
    catch (error) {
        if (error instanceof OoxmlArchiveFailure)
            return failure(error.code, error.message);
        return failure('invalid_source_archive', 'OOXML archive contents could not be read safely');
    }
    finally {
        zipFile?.close();
    }
    let removedExternalRelationshipCount = 0;
    let unsafe = false;
    try {
        const declaredSvgEntries = contentTypeDeclaredSvgEntries(entryBytes);
        if (!declaredSvgEntries) {
            return failure('invalid_source_archive', 'OOXML archive contains unsafe active content');
        }
        for (const [name, bytes] of entryBytes) {
            if (XML_ENTRY.test(name) || declaredSvgEntries.has(name)) {
                const svgContext = /\.svg$/iu.test(name) || declaredSvgEntries.has(name);
                if (unsafe)
                    break;
                const text = bytes.toString('utf8');
                let workingText = text;
                let tokens = tokenizeTags(workingText);
                if (!tokens) {
                    unsafe = true;
                    break;
                }
                if (/\.rels$/iu.test(name)) {
                    const sanitized = removeExternalRelationships(workingText, tokens);
                    workingText = sanitized.text;
                    removedExternalRelationshipCount += sanitized.removed;
                    tokens = tokenizeTags(workingText);
                    if (!tokens) {
                        unsafe = true;
                        break;
                    }
                    if (!validateInternalRelationships(name, tokens, entryBytes)) {
                        unsafe = true;
                        break;
                    }
                }
                if (hasUnsafeXml(workingText, tokens, svgContext)) {
                    unsafe = true;
                    break;
                }
                if (workingText !== text)
                    entryBytes.set(name, Buffer.from(workingText));
            }
        }
    }
    catch {
        return failure('invalid_source_archive', 'OOXML archive contents could not be read safely');
    }
    if (unsafe) {
        return failure('invalid_source_archive', 'OOXML archive contains unsafe active content');
    }
    try {
        const pptxPreflight = collectPptxPreflight(entryBytes, removedExternalRelationshipCount, limits, options.pptxPreflight === true);
        const zip = new jszip();
        for (const [name, bytes] of entryBytes)
            zip.file(name, bytes);
        const bytes = await zip.generateAsync({
            type: 'uint8array',
            compression: 'DEFLATE',
            streamFiles: true,
        });
        if (bytes.byteLength > PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes) {
            return failure('resource_limit_exceeded', 'OOXML sanitized copy exceeds the artifact budget');
        }
        return {
            ok: true,
            value: {
                bytes,
                removedExternalRelationshipCount,
                rejectedEmbeddedResourceCount: 0,
                ...(pptxPreflight ? { pptxPreflight } : {}),
            },
        };
    }
    catch (error) {
        if (error instanceof OoxmlArchiveFailure)
            return failure(error.code, error.message);
        return failure('invalid_source_archive', 'OOXML archive copy could not be created');
    }
}
const workerParentPort = parentPort;
export function postOoxmlSanitizerResult(port, result) {
    const outputBuffer = result.ok ? result.value.bytes.buffer : null;
    const transfer = outputBuffer instanceof ArrayBuffer ? [outputBuffer] : [];
    port.postMessage(result, transfer);
}
if (workerParentPort) {
    workerParentPort.once('message', (input) => {
        void sanitizeOoxmlArchive(input?.bytes ?? new Uint8Array(), {}, input?.options)
            .then((result) => {
            postOoxmlSanitizerResult(workerParentPort, result);
        })
            .catch(() => {
            // An unexpected rejection here would otherwise die as an unhandled
            // rejection and starve the main thread's message listener. Post the
            // same structured failure shape every other error path uses so the
            // parent resolves a typed internal failure instead of a worker exit.
            postOoxmlSanitizerResult(workerParentPort, failure('internal', 'OOXML sanitizer worker failed unexpectedly', true));
        });
    });
}
