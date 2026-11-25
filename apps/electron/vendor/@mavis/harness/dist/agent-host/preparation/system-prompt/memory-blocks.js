import { DAILY_RECENT_CAP_CHARS, MEMORY_SUMMARY_INJECTION_CAP_CHARS, MEMORY_TAIL_INJECTION_CAP_CHARS, createMemoryContextBudget, } from '@mavis/shared';
import { buildAvailableMemoryTopicsBlock, buildDailyMemoryBlock, buildMemoryBlock, buildMemoryNoteBlock, buildUserProfileBlock, } from './prompt-blocks.js';
/**
 * Formats the memory layers inside one shared budget: user profile, canonical
 * memory, read-only legacy owners, then the daily digest.
 */
export function composeMemoryBlocks(facts) {
    const blocks = [];
    const budget = createMemoryContextBudget();
    const userBlock = buildUserMemoryBlock(facts, budget);
    if (userBlock)
        blocks.push(userBlock);
    for (const memory of facts.agents.filter(({ canonical }) => canonical)) {
        appendCanonicalMemoryBlocks(blocks, memory, budget);
    }
    appendLegacyMemorySnapshots(blocks, facts.agents, budget);
    const shown = budget.take(dailyDigest(facts) ?? '', buildDailyMemoryBlock, 'head');
    if (shown)
        blocks.push(buildDailyMemoryBlock(shown));
    return blocks;
}
function buildUserMemoryBlock(facts, budget) {
    const user = facts.userProfile?.trim();
    if (!user)
        return undefined;
    const render = (content) => buildUserProfileBlock(content, facts.userProfileGuidance);
    const content = budget.take(user, render, 'tail', MEMORY_TAIL_INJECTION_CAP_CHARS);
    return content ? render(content) : undefined;
}
function dailyDigest(facts) {
    return facts.dailyNotes ? formatDailyDigest(facts.dailyNotes) : facts.dailyDigest?.trim();
}
function renderSummary(memory) {
    return (content) => buildMemoryBlock('agent_memory_summary', memory.wording.summary, content);
}
function renderTail(memory) {
    return (content) => buildMemoryBlock('agent_memory_tail', memory.wording.tail, content);
}
function appendCanonicalMemoryBlocks(blocks, memory, budget) {
    appendCanonicalMain(blocks, memory, budget);
    if (memory.topics.length > 0) {
        const topics = buildAvailableMemoryTopicsBlock(memory.topics, memory.wording.topics);
        if (budget.include(topics))
            blocks.push(topics);
    }
}
/** Over the tail cap, the summary index (or a fallback note) points at older entries. */
function appendCanonicalMain(blocks, memory, budget) {
    const main = memory.main.trim();
    if (!main)
        return;
    const summary = memory.summary.trim();
    const capped = main.length > MEMORY_TAIL_INJECTION_CAP_CHARS;
    if (capped && summary) {
        const render = renderSummary(memory);
        const shown = budget.take(summary, render, 'head', MEMORY_SUMMARY_INJECTION_CAP_CHARS);
        if (shown)
            blocks.push(render(shown));
    }
    const render = renderTail(memory);
    const shown = budget.take(main, render, 'tail', MEMORY_TAIL_INJECTION_CAP_CHARS);
    if (shown)
        blocks.push(render(shown));
    const note = buildMemoryNoteBlock(memory.wording.note);
    if (capped && !summary && budget.include(note))
        blocks.push(note);
}
function appendLegacyMemorySnapshots(blocks, agents, budget) {
    // All retired owners share one additional tail-sized budget.
    let legacyBudget = MEMORY_TAIL_INJECTION_CAP_CHARS;
    for (const memory of agents.filter(({ canonical }) => !canonical)) {
        legacyBudget = appendLegacyMemoryBlocks(blocks, memory, legacyBudget, budget);
        if (legacyBudget <= 0)
            break;
    }
}
function appendLegacyMemoryBlocks(blocks, memory, legacyBudget, budget) {
    let remaining = legacyBudget;
    if (remaining <= 0)
        return 0;
    remaining = appendLegacyPart(blocks, memory.main, remaining, {
        budget,
        render: renderTail(memory),
        keep: 'tail',
        cap: remaining,
    });
    remaining = appendLegacyPart(blocks, memory.summary, remaining, {
        budget,
        render: renderSummary(memory),
        keep: 'head',
        cap: Math.min(MEMORY_SUMMARY_INJECTION_CAP_CHARS, remaining),
    });
    return appendLegacyTopics(blocks, memory, remaining, budget);
}
function appendLegacyPart(blocks, rawContent, legacyBudget, part) {
    const content = rawContent.trim();
    if (!content || legacyBudget <= 0)
        return legacyBudget;
    const shown = part.budget.take(content, part.render, part.keep, part.cap);
    if (!shown)
        return legacyBudget;
    blocks.push(part.render(shown));
    return legacyBudget - shown.length;
}
function appendLegacyTopics(blocks, memory, legacyBudget, budget) {
    if (legacyBudget <= 0 || memory.topics.length === 0)
        return legacyBudget;
    let remainingTopics = memory.topics;
    while (remainingTopics.length > 0) {
        const candidate = buildAvailableMemoryTopicsBlock(remainingTopics, memory.wording.topics);
        if (candidate.length <= legacyBudget && budget.include(candidate)) {
            blocks.push(candidate);
            return legacyBudget - candidate.length;
        }
        remainingTopics = remainingTopics.slice(0, -1);
    }
    return legacyBudget;
}
/** The two most recent days keep their tail; older days collapse into a one-line summary. */
function formatDailyDigest(notes) {
    const sections = [];
    for (const [offset, note] of notes.entries()) {
        const content = stripTerminalActivityLines(note.content);
        if (!content)
            continue;
        if (offset <= 1) {
            sections.push(`## ${note.date}\n${content.length > DAILY_RECENT_CAP_CHARS
                ? `... (truncated)\n${content.slice(-DAILY_RECENT_CAP_CHARS)}`
                : content}`);
        }
        else {
            const flat = content.slice(0, 500).replace(/\n/gu, ' ').trim();
            sections.push(`## ${note.date} (summary)\n${flat}${content.length > 500 ? '...' : ''}`);
        }
    }
    return sections.length > 0 ? sections.slice(0, 8).join('\n\n') : undefined;
}
const TERMINAL_ACTIVITY_LINE_RE = /^- (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) session=\S+ turn=\S+ status=(?:finished|error|aborted|interrupted)$/u;
function stripTerminalActivityLines(content) {
    return content
        .split(/\r?\n/u)
        .filter((line) => !isTerminalActivityLine(line))
        .join('\n')
        .trim();
}
function isTerminalActivityLine(line) {
    const match = TERMINAL_ACTIVITY_LINE_RE.exec(line);
    if (!match)
        return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    return isValidActivityTimestamp({ year, month, day, hour, minute, second });
}
function isValidActivityTimestamp(input) {
    const { year, month, day, hour, minute, second } = input;
    if (!isValidActivityClock(month, hour, minute, second))
        return false;
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const maxDay = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
    return day >= 1 && day <= maxDay;
}
function isValidActivityClock(month, hour, minute, second) {
    return month >= 1 && month <= 12 && hour <= 23 && minute <= 59 && second <= 59;
}
//# sourceMappingURL=memory-blocks.js.map