/** Bump when tokenizing or the indexed document text changes: the index is rebuilt. */
const TOKENIZER_FORMAT = 'v2';
const PROBE_TEXT = '我在南京市工作';
const TOKEN_RUN = /[\p{L}\p{N}\p{M}]+/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HAN_WORD = /^\p{Script=Han}{2,}$/u;
function isCjkCharacter(character) {
    return CJK.test(character);
}
function createIntlSegmenter() {
    if (typeof Intl.Segmenter !== 'function')
        return undefined;
    return new Intl.Segmenter('zh', { granularity: 'word' });
}
/**
 * Detects at construction whether the segmenter really splits Chinese into words.
 * Packaged builds without full ICU data split it into single characters; those fall
 * back to the single-character column only (spec 15.4).
 * @internal Exported only for focused tests.
 */
export function createSearchTokenizer(createSegmenter = createIntlSegmenter, icuVersion = process.versions.icu ?? 'unknown') {
    const segmenter = probeSegmenter(createSegmenter);
    const words = segmenter ? `icu-${icuVersion}` : 'none';
    return {
        version: `${TOKENIZER_FORMAT};words=${words};chars=1`,
        segmentsWords: segmenter !== undefined,
        words: (text) => (segmenter ? wordTokens(segmenter, text) : []),
        chars: charTokens,
    };
}
let defaultTokenizer;
/** Process-wide tokenizer; the platform check runs once. */
export function defaultSearchTokenizer() {
    defaultTokenizer ??= createSearchTokenizer();
    return defaultTokenizer;
}
function probeSegmenter(create) {
    try {
        const segmenter = create();
        if (!segmenter)
            return undefined;
        for (const { segment } of segmenter.segment(PROBE_TEXT)) {
            if (HAN_WORD.test(segment))
                return segmenter;
        }
    }
    catch {
        // An unusable segmenter is the same as a missing one.
    }
    return undefined;
}
function wordTokens(segmenter, text) {
    const tokens = [];
    for (const { segment, index, isWordLike } of segmenter.segment(text)) {
        if (isWordLike === false)
            continue;
        for (const match of segment.matchAll(TOKEN_RUN)) {
            const start = index + (match.index ?? 0);
            tokens.push({ text: match[0].toLowerCase(), start, end: start + match[0].length });
        }
    }
    return tokens;
}
function charTokens(text) {
    const tokens = [];
    for (const match of text.matchAll(TOKEN_RUN)) {
        splitRun(match[0], match.index ?? 0, tokens);
    }
    return tokens;
}
/** Splits one letter/digit run: CJK characters one by one, the rest as whole runs. */
function splitRun(run, offset, tokens) {
    let pending = -1;
    let position = 0;
    const flush = (end) => {
        if (pending < 0)
            return;
        tokens.push({
            text: run.slice(pending, end).toLowerCase(),
            start: offset + pending,
            end: offset + end,
        });
        pending = -1;
    };
    for (const character of run) {
        if (isCjkCharacter(character)) {
            flush(position);
            tokens.push({
                text: character,
                start: offset + position,
                end: offset + position + character.length,
            });
        }
        else if (pending < 0) {
            pending = position;
        }
        position += character.length;
    }
    flush(position);
}
//# sourceMappingURL=tokenizer.js.map