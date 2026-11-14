import { estimateCharsToTokensCjkAware } from '@mavis/context-manager';
import { defaultSearchTokenizer, findTermMessages, formatMessageTime, indexedMessageTime, snippetAround, } from '../../session-system/index.js';
import { recallPointerLine } from '../../coordinator-text/index.js';
import { RECALL_POINTERS_HEADER } from '../../turn-system/index.js';
const MAX_TERMS = 12;
const MAX_POINTERS = 3;
/** A term in more messages than this is not rare. */
const RARE_MAX_MESSAGES = 5;
/** An entity term in at most this many messages is very rare: one is enough. */
const VERY_RARE_MAX_MESSAGES = 2;
const POINTER_TOKEN_BUDGET = 400;
const POINTER_SNIPPET_CHARS = 120;
const RECALL_CUES = /之前|上次|那天|说过|定的|还记得/u;
const TASK_ID = /\b(?:tsk|mvs|ses|task)[_-][A-Za-z0-9_-]{3,}\b/giu;
const PATH = /(?:[A-Za-z]:)?(?:[\w.-]+[\\/])+[\w.-]+/gu;
const FILE_NAME = /\b[\w-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/gu;
const VERSION = /\bv?\d+(?:\.\d+){1,3}(?:-[\w.]+)?\b/giu;
const NUMBER = /\b\d{3,}\b/gu;
const IDENTIFIER = /\b[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/gu;
const ASCII_WORD = /\b[A-Za-z]{4,}\b/gu;
const HAN_WORD = /^\p{Script=Han}{2,}$/u;
const HAN_RUN = /\p{Script=Han}{2,}/gu;
const COMMON_WORDS = new Set([
    '之前',
    '上次',
    '那天',
    '说过',
    '定的',
    '还记得',
    '记得',
    '我们',
    '你们',
    '他们',
    '这个',
    '那个',
    '什么',
    '怎么',
    '怎么样',
    '为什么',
    '可以',
    '一下',
    '现在',
    '今天',
    '明天',
    '昨天',
    '还是',
    '就是',
    '已经',
    '没有',
    '因为',
    '所以',
    '但是',
    '如果',
    '然后',
    '时候',
    '一个',
    '这样',
    '那样',
    '问题',
    '东西',
    '知道',
    '觉得',
    '需要',
    '看看',
    '一起',
    '帮我',
    '那里',
    '这里',
]);
const COMMON_ASCII = new Set(['this', 'that', 'with', 'from', 'have', 'what', 'when', 'please']);
/**
 * Runtime pre-check of a user message (spec 15.7): no model call. Rare terms from the
 * text are looked up outside the front context; a message is trusted when it holds two
 * rare terms or one very rare entity (one rare term after a recall cue such as 之前).
 * Any failure returns no pointers, so the round goes on as if nothing was found.
 */
export function precheckConversation(db, input, tokenizer = defaultSearchTokenizer()) {
    let extracted = 0;
    try {
        const terms = extractTerms(input.userText, tokenizer);
        extracted = terms.length;
        return lookUp(db, input, terms, tokenizer);
    }
    catch {
        return {
            pointers: [],
            trace: { extractedTerms: extracted, rareTerms: 0, trusted: false, pointers: 0, failed: true },
        };
    }
}
/** The pointer section of a delta block or a hidden pointer message; empty without pointers. */
export function renderPrecheckPointers(pointers) {
    if (pointers.length === 0)
        return '';
    return [RECALL_POINTERS_HEADER, ...pointers.map(recallPointerLine)].join('\n');
}
function extractTerms(text, tokenizer) {
    const terms = new Map();
    const add = (value, kind) => {
        const key = value.toLowerCase();
        if (!terms.has(key) && terms.size < MAX_TERMS)
            terms.set(key, { text: value, kind });
    };
    let rest = text;
    for (const pattern of [TASK_ID, PATH, FILE_NAME, VERSION, NUMBER, IDENTIFIER]) {
        for (const match of rest.matchAll(pattern))
            add(match[0], 'entity');
        // Parts of an entity (the words of pricing-engine) are not terms of their own.
        rest = rest.replace(pattern, ' ');
    }
    for (const match of rest.matchAll(ASCII_WORD)) {
        if (!COMMON_ASCII.has(match[0].toLowerCase()))
            add(match[0], 'word');
    }
    for (const word of chineseWords(rest, tokenizer))
        add(word, 'word');
    return [...terms.values()];
}
function chineseWords(text, tokenizer) {
    const words = tokenizer.segmentsWords
        ? tokenizer.words(text).map((token) => token.text)
        : [...text.matchAll(HAN_RUN)].flatMap((match) => bigrams(match[0]));
    return words.filter((word) => HAN_WORD.test(word) && !COMMON_WORDS.has(word));
}
function bigrams(run) {
    const characters = Array.from(run);
    return characters.slice(0, -1).map((character, index) => character + characters[index + 1]);
}
function lookUp(db, input, terms, tokenizer) {
    const front = new Set(input.frontContextMessageIds);
    const candidates = new Map();
    const matches = earlierMatches(db, input, tokenizer);
    let rareTerms = 0;
    for (const term of terms) {
        const messages = matches(term);
        if (messages.length === 0 || messages.length > RARE_MAX_MESSAGES)
            continue;
        rareTerms += 1;
        const isVeryRare = term.kind === 'entity' && messages.length <= VERY_RARE_MAX_MESSAGES;
        for (const message of messages) {
            if (front.has(message.messageId))
                continue;
            const candidate = candidates.get(message.messageId) ?? { message, terms: [] };
            candidate.terms.push(isVeryRare ? { ...term, kind: 'entity' } : { ...term, kind: 'word' });
            candidates.set(message.messageId, candidate);
        }
    }
    const cue = RECALL_CUES.test(input.userText);
    const trusted = [...candidates.values()]
        .filter((candidate) => isTrusted(candidate, cue))
        .sort((left, right) => right.terms.length - left.terms.length ||
        right.message.createdAtMs - left.message.createdAtMs)
        .slice(0, MAX_POINTERS);
    const pointers = fitPointers(trusted);
    return {
        pointers,
        trace: {
            extractedTerms: terms.length,
            rareTerms,
            trusted: trusted.length > 0,
            pointers: pointers.length,
        },
    };
}
/**
 * Up to one more than the rare limit of the messages holding a term, written
 * before the message being sent. That message is usually indexed already, and
 * counting it would make every term of its own text look rare.
 */
function earlierMatches(db, input, tokenizer) {
    const beforeMs = indexedMessageTime(db, input.sessionId, input.currentMessageIds ?? []);
    return (term) => findTermMessages(db, {
        sessionId: input.sessionId,
        term: term.text,
        limit: RARE_MAX_MESSAGES + 1,
        ...(beforeMs === undefined ? {} : { beforeMs }),
        tokenizer,
    });
}
function isTrusted(candidate, cue) {
    if (candidate.terms.some((term) => term.kind === 'entity'))
        return true;
    return candidate.terms.length >= (cue ? 1 : 2);
}
function fitPointers(candidates) {
    for (let limit = POINTER_SNIPPET_CHARS;; limit -= 10) {
        const pointers = pointersWithin(candidates, limit);
        if (estimateCharsToTokensCjkAware(renderPrecheckPointers(pointers)) <= POINTER_TOKEN_BUDGET ||
            limit <= 20)
            return pointers;
    }
}
function pointersWithin(candidates, limit) {
    return candidates.map(({ message, terms }) => ({
        messageId: message.messageId,
        time: formatMessageTime(message.createdAtMs),
        snippet: oneLine(message.body, firstTermOffset(message.body, terms), limit),
    }));
}
/**
 * The snippet, and how much original text it was cut from. A snippet that leaves
 * text out says so: cut ends alone read as a short complete message, and a model
 * that takes one for the whole message answers from the excerpt instead of reading
 * the original.
 */
function oneLine(body, center, limit) {
    const snippet = snippetAround(body, center, limit).replace(/\s+/gu, ' ');
    const total = Array.from(body).length;
    return total > limit ? `${snippet}（原文 ${total} 字）` : snippet;
}
function firstTermOffset(body, terms) {
    const lower = body.toLowerCase();
    const offsets = terms
        .map((term) => lower.indexOf(term.text.toLowerCase()))
        .filter((offset) => offset >= 0);
    return offsets.length ? Math.min(...offsets) : 0;
}
//# sourceMappingURL=precheck.js.map