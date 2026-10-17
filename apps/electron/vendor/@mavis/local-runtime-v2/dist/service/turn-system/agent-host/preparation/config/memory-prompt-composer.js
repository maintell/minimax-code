import { DAILY_RECENT_CAP_CHARS, MEMORY_SUMMARY_INJECTION_CAP_CHARS, MEMORY_TAIL_INJECTION_CAP_CHARS, createMemoryContextBudget, } from '@mavis/shared';
import { buildAvailableMemoryTopicsBlock, buildDailyMemoryBlock, buildMemoryNoteBlock, buildMemorySummaryBlock, buildMemoryTailBlock, buildUserProfileBlock, } from '../prompt-blocks.js';
export function toMemoryPromptSources(agentNames) {
    return agentNames
        .map((name) => name.trim())
        .filter((name, index, all) => name.length > 0 && all.indexOf(name) === index)
        .map((agentName, index) => ({
        agentName,
        canonical: index === 0,
    }));
}
export async function collectMemoryBlocks(reader, sources, nowMs, options) {
    const blocks = [];
    const budget = createMemoryContextBudget();
    if (!options.includeAgentMemory) {
        await appendIndependentUserMemoryBlock({
            blocks,
            reader,
            sources,
            prompt: options.prompt,
            budget,
        });
        return blocks;
    }
    const snapshots = [];
    for (const source of sources) {
        try {
            snapshots.push({
                source,
                memory: await reader.collectReminderMemory(source.agentName),
            });
        }
        catch {
            // One broken compatibility directory must not hide the rest of the family.
        }
    }
    appendUserMemorySnapshot(blocks, snapshots, budget, options.prompt);
    appendCanonicalMemorySnapshots(blocks, snapshots, budget, options.prompt);
    appendLegacyMemorySnapshots(blocks, snapshots, budget, options.prompt);
    await appendDailyMemoryBlock({ blocks, reader, sources, nowMs, budget });
    return blocks;
}
function appendUserMemorySnapshot(blocks, snapshots, budget, options) {
    const userSnapshot = snapshots.find(({ memory }) => memory.user.trim());
    if (!userSnapshot)
        return;
    const userBlock = buildUserMemoryBlock(userSnapshot.memory.user, budget, options);
    if (!userBlock)
        return;
    blocks.push(userBlock);
}
async function appendIndependentUserMemoryBlock(input) {
    const user = await readUserMemory(input.reader, input.sources);
    if (!user?.content.trim())
        return;
    const userBlock = buildUserMemoryBlock(user.content, input.budget, input.prompt);
    if (!userBlock)
        return;
    input.blocks.push(userBlock);
}
async function readUserMemory(reader, sources) {
    try {
        if (reader.getUserMemory)
            return await reader.getUserMemory();
        const source = sources[0];
        if (!source)
            return undefined;
        const memory = await reader.collectReminderMemory(source.agentName);
        return { content: memory.user, path: memory.userPath };
    }
    catch {
        return undefined;
    }
}
function appendCanonicalMemorySnapshots(blocks, snapshots, budget, options) {
    for (const snapshot of snapshots.filter(({ source }) => source.canonical)) {
        blocks.push(...buildCanonicalMemoryBlocks(snapshot.memory, budget, options));
        if (snapshot.memory.topics.length > 0) {
            const topics = buildAvailableMemoryTopicsBlock(snapshot.memory.topics, options);
            if (budget.include(topics))
                blocks.push(topics);
        }
    }
}
function appendLegacyMemorySnapshots(blocks, snapshots, budget, options) {
    // All retired owners share one additional tail-sized budget.
    let legacyBudget = MEMORY_TAIL_INJECTION_CAP_CHARS;
    for (const snapshot of snapshots.filter(({ source }) => !source.canonical)) {
        legacyBudget = appendLegacyMemoryBlocks(blocks, snapshot, legacyBudget, { budget, options });
        if (legacyBudget <= 0)
            break;
    }
}
async function appendDailyMemoryBlock(input) {
    const { blocks, reader, sources, nowMs, budget } = input;
    const canonicalAgentName = sources.find((source) => source.canonical)?.agentName;
    if (!canonicalAgentName)
        return;
    const daily = await collectDailyMemory(reader, canonicalAgentName, nowMs);
    const shown = budget.take(daily ?? '', buildDailyMemoryBlock, 'head');
    if (shown)
        blocks.push(buildDailyMemoryBlock(shown));
}
function buildUserMemoryBlock(rawUser, budget, options) {
    const user = rawUser.trim();
    if (!user)
        return undefined;
    const render = (content) => buildUserProfileBlock(content, '', options);
    const content = budget.take(user, render, 'tail', MEMORY_TAIL_INJECTION_CAP_CHARS);
    return content ? render(content) : undefined;
}
function buildCanonicalMemoryBlocks(memory, budget, options) {
    const main = memory.main.trim();
    const blocks = [];
    if (main) {
        const summary = memory.summary.trim();
        const capped = main.length > MEMORY_TAIL_INJECTION_CAP_CHARS;
        if (capped && summary) {
            const render = (content) => buildMemorySummaryBlock(content, memory.mainPath, options);
            const shown = budget.take(summary, render, 'head', MEMORY_SUMMARY_INJECTION_CAP_CHARS);
            if (shown)
                blocks.push(render(shown));
        }
        const render = (content) => buildMemoryTailBlock(content, memory.mainPath, options);
        const shown = budget.take(main, render, 'tail', MEMORY_TAIL_INJECTION_CAP_CHARS);
        if (shown)
            blocks.push(render(shown));
        const note = buildMemoryNoteBlock(memory.mainPath);
        if (capped && !summary && budget.include(note))
            blocks.push(note);
    }
    return blocks;
}
function appendLegacyMemoryBlocks(blocks, snapshot, budget, context) {
    let remaining = budget;
    if (remaining <= 0)
        return 0;
    const legacyOptions = {
        ...context.options,
        includeWriteGuidance: false,
        sourceAgent: snapshot.source.agentName,
        legacy: true,
    };
    const legacyContext = { budget: context.budget, options: legacyOptions };
    remaining = appendLegacyMain(blocks, snapshot, remaining, legacyContext);
    remaining = appendLegacySummary(blocks, snapshot, remaining, legacyContext);
    return appendLegacyTopics(blocks, snapshot.memory.topics, remaining, legacyContext);
}
function appendLegacyMain(blocks, snapshot, budget, context) {
    const main = snapshot.memory.main.trim();
    if (!main || budget <= 0)
        return budget;
    const render = (content) => buildMemoryTailBlock(content, snapshot.memory.mainPath, context.options);
    const shown = context.budget.take(main, render, 'tail', budget);
    if (!shown)
        return budget;
    blocks.push(render(shown));
    return budget - shown.length;
}
function appendLegacySummary(blocks, snapshot, budget, context) {
    const summary = snapshot.memory.summary.trim();
    if (!summary || budget <= 0)
        return budget;
    const render = (content) => buildMemorySummaryBlock(content, snapshot.memory.mainPath, context.options);
    const shown = context.budget.take(summary, render, 'head', Math.min(MEMORY_SUMMARY_INJECTION_CAP_CHARS, budget));
    if (!shown)
        return budget;
    blocks.push(render(shown));
    return budget - shown.length;
}
function appendLegacyTopics(blocks, topics, budget, context) {
    if (budget <= 0 || topics.length === 0)
        return budget;
    let remainingTopics = topics;
    while (remainingTopics.length > 0) {
        const candidate = buildAvailableMemoryTopicsBlock(remainingTopics, context.options);
        if (candidate.length <= budget && context.budget.include(candidate)) {
            blocks.push(candidate);
            return budget - candidate.length;
        }
        remainingTopics = remainingTopics.slice(0, -1);
    }
    return budget;
}
async function collectDailyMemory(reader, agentName, nowMs) {
    try {
        return await readDailyDigest(reader, agentName, nowMs);
    }
    catch {
        return undefined;
    }
}
async function readDailyDigest(reader, agentName, nowMs) {
    const now = new Date(nowMs());
    const sections = [];
    for (let offset = 0; offset <= 7; offset += 1) {
        const date = new Date(now);
        date.setDate(date.getDate() - offset);
        const key = formatLocalDate(date);
        const content = stripTerminalActivityLines((await reader.getDaily(agentName, key)).content);
        if (!content)
            continue;
        if (offset <= 1) {
            sections.push(`## ${key}\n${content.length > DAILY_RECENT_CAP_CHARS
                ? `... (truncated)\n${content.slice(-DAILY_RECENT_CAP_CHARS)}`
                : content}`);
        }
        else {
            const flat = content.slice(0, 500).replace(/\n/gu, ' ').trim();
            sections.push(`## ${key} (summary)\n${flat}${content.length > 500 ? '...' : ''}`);
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
function formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
//# sourceMappingURL=memory-prompt-composer.js.map