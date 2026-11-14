import { HANDOFF_NO_OPEN_SPACES, HANDOFF_NO_OPEN_TASKS, HANDOFF_NO_SUMMARY, HANDOFF_SPACES_UNREAD, HANDOFF_STATUS_CUT_NOTE, HANDOFF_STATUS_UNREAD, HANDOFF_SUMMARY_CUT_NOTE, HANDOFF_TIME_UNREAD, handoffHeaderText, handoffOtherSpaces, handoffSpaceHead, handoffStatusHeading, handoffSummarySection, handoffTimeLine, } from '../../../../coordinator-text/index.js';
const MAX_DETAILED_SPACES = 4;
/** Most of the summary share the retrieval hints may take when the body overflows. */
const LAST_SECTION_RESERVE = 0.25;
/** An emergency rebuild's notes (emergency rebuild spec 7.3); its ledger note comes with the material. */
const EMERGENCY_UNREAD_TEXT = {
    status: HANDOFF_STATUS_UNREAD,
    spaces: HANDOFF_SPACES_UNREAD,
    time: HANDOFF_TIME_UNREAD,
};
/**
 * Renders the handoff header (12.9). The summary, status and spaces are each
 * cut to their own share of B (7.3); the ledger section arrives already cut to
 * the ledger share by the ledger itself (13.4), and is embedded as given. The
 * retrieval hint and time clues are one line each. An emergency rebuild adds
 * the incident section last, already fitted to its own limit (spec 5.2).
 */
export function renderHandoffHeader(input) {
    const { counter, shares, material } = input;
    const unread = new Set(input.noteUnreadable ? (material.unread ?? []) : []);
    const notes = input.unreadText ?? EMERGENCY_UNREAD_TEXT;
    const ledger = input.unreadText && unread.has('ledger')
        ? { ...material.ledgerSection, text: input.unreadText.ledger }
        : material.ledgerSection;
    const section = (write, note) => {
        if (!input.noteUnreadable)
            return write();
        try {
            return write();
        }
        catch {
            return note();
        }
    };
    const measured = (text) => ({ text, tokens: counter.countText(text) });
    const status = unread.has('status')
        ? measured(notes.status)
        : section(() => renderStatusSection(material, shares.status, counter, input.formatTime), () => measured(notes.status));
    const spaces = unread.has('spaces')
        ? measured(notes.spaces)
        : section(() => renderSpacesSection(material.spaces, shares.spaces, counter), () => measured(notes.spaces));
    const time = section(() => handoffTimeLine(input.formatTime(material.segmentStartedAtMs), material.lastTurnAtMs === undefined ? undefined : input.formatTime(material.lastTurnAtMs)), () => notes.time);
    const compose = (summaryText, sections) => handoffHeaderText({
        summary: summaryText,
        ledger: sections ? ledger.text : '',
        status: sections ? status.text : '',
        spaces: sections ? spaces.text : '',
        time,
        ...(sections && input.resetNote ? { reset: input.resetNote } : {}),
        ...(sections && input.incidents ? { incidents: input.incidents } : {}),
    });
    // The fixed scaffolding is paid from the summary share so the header never
    // exceeds the sum of its shares.
    const scaffold = counter.countText(compose('', false));
    const noSummary = input.noSummaryNote ?? HANDOFF_NO_SUMMARY;
    const summary = input.checkpoint.sections.length === 0
        ? { text: noSummary, tokens: counter.countText(noSummary) }
        : fitSummary(input.checkpoint.sections, Math.max(0, shares.summary - scaffold), counter);
    const text = compose(summary.text, true);
    return {
        summary: text,
        sectionTokens: {
            summary: summary.tokens,
            ledger: counter.countText(ledger.text),
            status: status.tokens,
            spaces: spaces.tokens,
        },
        ledgerTruncated: ledger.truncated,
        ledgerShownIds: ledger.entryIds,
    };
}
export function buildHeaderMessage(summary, tokensBefore, timestamp) {
    return { role: 'compactionSummary', summary, tokensBefore, timestamp };
}
/** Task status snapshot (12.9) within its share of B; also measured to find the spare share. */
export function renderStatusSection(material, share, counter, formatTime) {
    const cutoff = material.status?.cutoffAtMs ?? material.segmentStartedAtMs;
    const lines = [
        handoffStatusHeading(formatTime(cutoff)),
        ...(material.status && material.status.lines.length > 0
            ? material.status.lines
            : [HANDOFF_NO_OPEN_TASKS]),
    ];
    const fitted = fitLines(lines, share, counter, HANDOFF_STATUS_CUT_NOTE);
    return { text: fitted.text, tokens: fitted.tokens };
}
/**
 * Space highlights (12.9): spaces with open tasks by recent activity; at most
 * four get their goal, the context.md summary revision and an excerpt cut at
 * a section boundary, sharing the space share evenly; the rest are named only.
 * Also measured to find the spare share the ledger may use (12.9).
 */
export function renderSpacesSection(spaces, share, counter) {
    const open = spaces
        .filter((space) => space.hasOpenTasks)
        .sort((left, right) => right.lastActiveAtMs - left.lastActiveAtMs);
    if (open.length === 0)
        return { text: HANDOFF_NO_OPEN_SPACES, tokens: counter.countText(HANDOFF_NO_OPEN_SPACES) };
    const detailed = open.slice(0, MAX_DETAILED_SPACES);
    const others = open.slice(MAX_DETAILED_SPACES);
    const othersLine = others.length > 0 ? handoffOtherSpaces(others.map((space) => space.name)) : '';
    const perSpace = Math.max(1, Math.floor((share - (othersLine ? counter.countText(othersLine) : 0)) / detailed.length));
    const blocks = detailed.map((space) => {
        const head = handoffSpaceHead(space);
        const excerpt = fitExcerpt(space, perSpace - counter.countText(`${head}\n`), counter);
        return excerpt ? `${head}\n${excerpt}` : head;
    });
    const text = [...blocks, ...(othersLine ? [othersLine] : [])].join('\n');
    return { text, tokens: counter.countText(text) };
}
/** The longest section-cut excerpt within `budget` tokens; characters are a first guess. */
function fitExcerpt(space, budget, counter) {
    if (budget <= 0)
        return '';
    let limit = budget * 4;
    while (limit >= 40) {
        const excerpt = space.excerpt(limit);
        if (!excerpt || counter.countText(excerpt) <= budget)
            return excerpt;
        limit = Math.floor(limit * 0.7);
    }
    return '';
}
function fitChars(text, budget, counter) {
    if (!text || budget <= 0)
        return '';
    if (counter.countText(text) <= budget)
        return text;
    let chars = text.length;
    while (chars > 8) {
        chars = Math.floor(chars / 2);
        const candidate = `${text.slice(0, chars)}…`;
        if (counter.countText(candidate) <= budget)
            return candidate;
    }
    return '';
}
/**
 * Fits the checkpoint's five sections (12.2) into the summary share. The last
 * one is the retrieval hints: it is what makes cut detail findable again, so it
 * is kept and the cut falls in the body above it (12.9).
 */
function fitSummary(sections, share, counter) {
    const linesOf = handoffSummarySection;
    const all = sections.flatMap(linesOf);
    const hints = sections.at(-1);
    const full = all.join('\n');
    if (hints === undefined || sections.length < 2 || counter.countText(full) <= share)
        return fitLines(all, share, counter, HANDOFF_SUMMARY_CUT_NOTE);
    const last = linesOf(hints);
    const reserve = Math.min(counter.countText(last.join('\n')), Math.floor(share * LAST_SECTION_RESERVE));
    const head = fitLines(sections.slice(0, -1).flatMap(linesOf), Math.max(0, share - reserve), counter, HANDOFF_SUMMARY_CUT_NOTE);
    const tail = fitLines(last, reserve, counter, HANDOFF_SUMMARY_CUT_NOTE);
    const text = [head.text, tail.text].join('\n');
    return { text, tokens: counter.countText(text) };
}
/** Keeps whole lines from the top until the share is used, then a cut note. */
function fitLines(lines, share, counter, cutNote) {
    const full = lines.join('\n');
    if (counter.countText(full) <= share)
        return { text: full, tokens: counter.countText(full) };
    const kept = [];
    for (const line of lines) {
        const next = [...kept, line, cutNote].join('\n');
        if (counter.countText(next) > share) {
            const room = share - counter.countText([...kept, cutNote].join('\n'));
            const partial = fitChars(line, room, counter);
            if (partial)
                kept.push(partial);
            break;
        }
        kept.push(line);
    }
    const text = [...kept, cutNote].join('\n');
    return { text, tokens: counter.countText(text) };
}
//# sourceMappingURL=handoff-header.js.map