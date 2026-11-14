import { SEGMENT_LEDGER_BLOCK, SEGMENT_MEDIA_BLOCK, SEGMENT_SUMMARY_HEADINGS, SEGMENT_UNSEEN_MEDIA_PREFIX, } from '../../../../coordinator-text/index.js';
/**
 * The output broke the Bunny protocol; the whole result is discarded (12.1).
 * @internal Exported only for focused tests.
 */
export class SegmentCheckpointFormatError extends Error {
    name = 'SegmentCheckpointFormatError';
}
const LEDGER_KINDS = new Set([
    'correction',
    'constraint',
    'open_question',
    'context_gap',
]);
const CLOSE_REASONS = new Set(['done', 'answered', 'withdrawn']);
const MAX_TEXT_CHARS = 4_000;
/**
 * Strict parser of a Bunny compaction response. Any deviation (missing,
 * reordered, duplicated or empty sections, stray text, malformed JSON lines,
 * unknown operations) throws; there is no lenient fallback beyond an unclosed
 * empty media block at the very end. Semantic checks against the ledger and
 * the message index happen later, per entry.
 */
export function parseSegmentCheckpoint(text) {
    const normalized = text.replace(/\r\n?/gu, '\n').trim();
    const ledgerStart = normalized.indexOf(`<${SEGMENT_LEDGER_BLOCK}>`);
    if (ledgerStart < 0)
        throw new SegmentCheckpointFormatError('ledger block is missing');
    const sections = parseSections(normalized.slice(0, ledgerStart));
    const blocks = parseBlocks(normalized.slice(ledgerStart));
    return {
        sections,
        ledger: blocks.ledger.map(parseLedgerLine),
        media: blocks.media.map(parseMediaLine),
    };
}
function parseSections(head) {
    const lines = head.trim().split('\n');
    const sections = [];
    for (const line of lines) {
        const heading = /^## (.+)$/u.exec(line)?.[1]?.trim();
        if (heading !== undefined) {
            sections.push({ heading, body: [] });
            continue;
        }
        const current = sections.at(-1);
        if (!current) {
            if (line.trim())
                throw new SegmentCheckpointFormatError('text before the first section');
            continue;
        }
        current.body.push(line);
    }
    if (sections.length !== SEGMENT_SUMMARY_HEADINGS.length) {
        throw new SegmentCheckpointFormatError('summary must have exactly five sections');
    }
    return sections.map((section, index) => {
        if (section.heading !== SEGMENT_SUMMARY_HEADINGS[index]) {
            throw new SegmentCheckpointFormatError(`section ${String(index + 1)} heading is wrong`);
        }
        const body = section.body.join('\n').trim();
        if (!body)
            throw new SegmentCheckpointFormatError(`section "${section.heading}" is empty`);
        return { heading: section.heading, body };
    });
}
function parseBlocks(tail) {
    const pattern = new RegExp(`^<${SEGMENT_LEDGER_BLOCK}>\\n?([\\s\\S]*?)\\n?</${SEGMENT_LEDGER_BLOCK}>\\s*<${SEGMENT_MEDIA_BLOCK}>\\n?([\\s\\S]*?)\\n?</${SEGMENT_MEDIA_BLOCK}>$`, 'u');
    const match = pattern.exec(closeTrailingEmptyMediaBlock(tail.trim()));
    if (!match)
        throw new SegmentCheckpointFormatError('ledger and media blocks are malformed');
    return { ledger: blockLines(match[1] ?? ''), media: blockLines(match[2] ?? '') };
}
/**
 * The one tolerated slip (12.1): output that stops right after opening an
 * empty media block means an empty block. Any content after the opening tag
 * may be cut off, so that output is still rejected.
 */
function closeTrailingEmptyMediaBlock(tail) {
    return tail.endsWith(`<${SEGMENT_MEDIA_BLOCK}>`) ? `${tail}\n</${SEGMENT_MEDIA_BLOCK}>` : tail;
}
function blockLines(body) {
    return body
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}
function parseObject(line, label) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        throw new SegmentCheckpointFormatError(`${label} is not JSON`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new SegmentCheckpointFormatError(`${label} is not an object`);
    }
    return value;
}
const LEDGER_LINE_PARSERS = new Map([
    ['add', parseLedgerAdd],
    [
        'update',
        (value, label) => {
            expectKeys(value, ['op', 'id', 'text', 'source'], label);
            return {
                op: 'update',
                entryId: requireText(value.id, label),
                text: requireText(value.text, label),
                source: requireSource(value.source, label),
            };
        },
    ],
    [
        'close',
        (value, label) => {
            expectKeys(value, ['op', 'id', 'reason', 'note', 'source'], label);
            const reason = value.reason;
            if (typeof reason !== 'string' || !CLOSE_REASONS.has(reason)) {
                throw new SegmentCheckpointFormatError(`${label} close reason is unknown`);
            }
            // A blank note is no note: it must not void the whole checkpoint.
            const note = value.note === '' ? undefined : value.note;
            return {
                op: 'close',
                entryId: requireText(value.id, label),
                reason: reason,
                ...(note === undefined ? {} : { note: requireText(note, label) }),
                ...(value.source === undefined ? {} : { source: requireSource(value.source, label) }),
            };
        },
    ],
]);
function parseLedgerLine(line, index) {
    const label = `ledger line ${String(index + 1)}`;
    const value = parseObject(line, label);
    const parse = LEDGER_LINE_PARSERS.get(value.op);
    if (!parse)
        throw new SegmentCheckpointFormatError(`${label} op is unknown`);
    return parse(value, label);
}
function parseLedgerAdd(value, label) {
    expectKeys(value, ['op', 'kind', 'scope', 'text', 'replaces', 'source'], label);
    const kind = value.kind;
    if (typeof kind !== 'string' || !LEDGER_KINDS.has(kind)) {
        throw new SegmentCheckpointFormatError(`${label} kind is unknown`);
    }
    const scope = value.scope === undefined ? 'global' : value.scope;
    if (typeof scope !== 'string' || !isValidScope(kind, scope)) {
        throw new SegmentCheckpointFormatError(`${label} scope is invalid`);
    }
    if (value.replaces !== undefined && kind !== 'correction') {
        throw new SegmentCheckpointFormatError(`${label} replaces is only for corrections`);
    }
    return {
        op: 'add',
        kind: kind,
        scope,
        text: requireText(value.text, label),
        ...(value.replaces === undefined ? {} : { replaces: requireText(value.replaces, label) }),
        source: requireSource(value.source, label),
    };
}
function parseMediaLine(line, index) {
    const label = `media line ${String(index + 1)}`;
    const value = parseObject(line, label);
    expectKeys(value, ['asset', 'source', 'description', 'seen'], label);
    if (typeof value.seen !== 'boolean') {
        throw new SegmentCheckpointFormatError(`${label} seen must be a boolean`);
    }
    const description = requireText(value.description, label);
    if (!value.seen && !description.startsWith(SEGMENT_UNSEEN_MEDIA_PREFIX)) {
        throw new SegmentCheckpointFormatError(`${label} must say the content was not seen`);
    }
    return {
        assetId: requireText(value.asset, label),
        source: requireSource(value.source, label),
        description,
        seen: value.seen,
    };
}
function isValidScope(kind, scope) {
    if (kind === 'context_gap')
        return /^space:\S+$/u.test(scope);
    return scope === 'global';
}
function expectKeys(value, allowed, label) {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key))
            throw new SegmentCheckpointFormatError(`${label} has field ${key}`);
    }
}
function requireText(value, label) {
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT_CHARS) {
        throw new SegmentCheckpointFormatError(`${label} text is invalid`);
    }
    return value.trim();
}
function requireSource(value, label) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new SegmentCheckpointFormatError(`${label} source must be a message number`);
    }
    return value;
}
//# sourceMappingURL=output-parser.js.map