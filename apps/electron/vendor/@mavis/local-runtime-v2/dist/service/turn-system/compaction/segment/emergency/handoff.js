import { BUNNY_HANDOFF_CLOSE, BUNNY_HANDOFF_OPEN, EMERGENCY_PREVIOUS_SUMMARY_HEADING, HANDOFF_INCIDENT_HEADING, HANDOFF_SECTIONS_AFTER_SUMMARY, HANDOFF_SUMMARY_HEADING, incidentNoteText, INCIDENT_TELL_USER_PREFIX, INCIDENT_TOLD_USER_BEFORE, SEGMENT_SUMMARY_HEADINGS, } from '../../../../coordinator-text/index.js';
import { userText } from '../algorithm/transcript.js';
/** Most incident notes a header carries, and their token limit together (spec 5.2). */
const MAX_INCIDENTS = 3;
const INCIDENT_SECTION_TOKENS = 1_000;
/** Lines this short are not cut further. */
const MIN_CUT_LINE = 16;
/**
 * Reads the summary and incident notes of the header at the head of the
 * active segment: a Bunny header's sections as they were written, a summary
 * in another format whole as one section, nothing without a header.
 */
export function readCarriedHandoff(records) {
    const head = records[0]?.message;
    if (head?.role !== 'compactionSummary')
        return { sections: [], incidents: [] };
    const text = userText(head);
    if (!text.trimStart().startsWith(BUNNY_HANDOFF_OPEN)) {
        return text.trim()
            ? {
                sections: [{ heading: EMERGENCY_PREVIOUS_SUMMARY_HEADING, body: text.trim() }],
                incidents: [],
            }
            : { sections: [], incidents: [] };
    }
    return { sections: summarySections(text), incidents: incidentBlocks(text) };
}
const KNOWN_HEADINGS = new Set([
    ...SEGMENT_SUMMARY_HEADINGS,
    EMERGENCY_PREVIOUS_SUMMARY_HEADING,
]);
function summarySections(header) {
    // A carried summary may hold `## ` lines of its own: it ends at the header's next section.
    const body = sectionText(header, HANDOFF_SUMMARY_HEADING, (line) => HANDOFF_SECTIONS_AFTER_SUMMARY.includes(line));
    if (!body)
        return [];
    const sections = [];
    for (const line of body.split('\n')) {
        const heading = /^### (.+)$/u.exec(line)?.[1]?.trim();
        if (heading && KNOWN_HEADINGS.has(heading))
            sections.push({ heading, lines: [] });
        else if (sections.length > 0)
            sections.at(-1).lines.push(line);
    }
    if (sections.length > 0) {
        return sections.map((section) => ({
            heading: section.heading,
            body: section.lines.join('\n').trim(),
        }));
    }
    // Only the note a segment without a summary writes: nothing to carry.
    return body.startsWith('（') && body.endsWith('）') && !body.includes('\n')
        ? []
        : [{ heading: EMERGENCY_PREVIOUS_SUMMARY_HEADING, body }];
}
/**
 * Earlier incident notes as they were, except what Bunny was to tell the
 * user: by the next rebuild it has usually said it, so a carried note asks
 * only when it has not (spec 5.4).
 */
function incidentBlocks(header) {
    const body = sectionText(header, HANDOFF_INCIDENT_HEADING, (line) => /^## /u.test(line));
    if (!body)
        return [];
    const blocks = [];
    for (const line of body.split('\n')) {
        const carried = line.startsWith(INCIDENT_TELL_USER_PREFIX) && line !== INCIDENT_TOLD_USER_BEFORE
            ? INCIDENT_TOLD_USER_BEFORE
            : line;
        if (line.startsWith('### '))
            blocks.push([line]);
        else
            blocks.at(-1)?.push(carried);
    }
    return blocks.map((lines) => lines.join('\n').trim());
}
/** The text under `## heading` up to the line that ends it or the header's end. */
function sectionText(header, heading, ends) {
    const lines = header.split('\n');
    const start = lines.indexOf(heading);
    if (start < 0)
        return '';
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => line.startsWith(BUNNY_HANDOFF_CLOSE) || ends(line));
    return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}
/**
 * The incident note of one emergency rebuild (spec 5.1). Given a counter, it
 * fits the incident section's 1k tokens (5.2): only the affected content can
 * make it that long, and then as many messages as fit are named and the note
 * says how many more there are; their placeholders in the conversation still
 * name each file.
 */
export function renderIncident(incident, formatTime, counter) {
    const all = incident.affected?.length ?? 0;
    const fits = (listed) => !counter ||
        counter.countText(renderNote(incident, formatTime, listed)) <= INCIDENT_SECTION_TOKENS;
    if (fits(all))
        return renderNote(incident, formatTime, all);
    let low = 0;
    let high = all;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(middle))
            low = middle;
        else
            high = middle - 1;
    }
    return renderNote(incident, formatTime, low);
}
/** The note naming the first `listed` affected messages one by one. */
function renderNote(incident, formatTime, listed) {
    const affected = incident.affected ?? [];
    return incidentNoteText({
        time: formatTime(incident.occurredAtMs),
        turnId: incident.turnId,
        category: incident.category,
        ...(incident.errorCode === undefined ? {} : { errorCode: incident.errorCode }),
        excerpt: incident.excerpt.replace(/\s+/gu, ' '),
        level: incident.level,
        replaced: Object.entries(incident.replaced)
            .filter(([, count]) => count > 0)
            .map(([kind, count]) => ({ kind, count })),
        ...(incident.repair ? { repair: incident.repair } : {}),
        ...(affected.length > 0
            ? {
                affected: {
                    named: affected.slice(0, listed),
                    unlisted: affected.length - listed,
                    media: affected.some((item) => item.media),
                },
            }
            : {}),
    });
}
/**
 * The incident section: the newest note first, at most three, within 1k
 * tokens together; the oldest go first when they do not fit (spec 5.2). A
 * newest note over the limit on its own is shortened to fit.
 */
export function fitIncidents(notes, counter) {
    const [newest, ...older] = notes.slice(0, MAX_INCIDENTS);
    if (newest === undefined)
        return '';
    const kept = [fitNote(newest, counter)];
    for (const note of older) {
        if (counter.countText([...kept, note].join('\n\n')) > INCIDENT_SECTION_TOKENS)
            break;
        kept.push(note);
    }
    return kept.join('\n\n');
}
/** Halves the note's longest line until it fits; every line keeps its start. */
function fitNote(note, counter) {
    const lines = note.split('\n').map((line) => Array.from(line));
    while (counter.countText(lines.map((line) => line.join('')).join('\n')) > INCIDENT_SECTION_TOKENS) {
        const longest = lines.reduce((top, line) => (line.length > top.length ? line : top));
        if (longest.length <= MIN_CUT_LINE)
            break;
        longest.splice(Math.floor(longest.length / 2), Infinity, '…');
    }
    return lines.map((line) => line.join('')).join('\n');
}
//# sourceMappingURL=handoff.js.map