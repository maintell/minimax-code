/** Daily notes cover today and the seven days before it. */
const DAILY_LOOKBACK_DAYS = 7;
export function toMemoryPromptSources(agentNames) {
    return agentNames
        .map((name) => name.trim())
        .filter((name, index, all) => name.length > 0 && all.indexOf(name) === index)
        .map((agentName, index) => ({
        agentName,
        canonical: index === 0,
    }));
}
/**
 * Reads the raw memory for one system prompt and words it for the desktop.
 * Every read fails open per source; the harness applies the shared budget.
 */
export async function readMemoryPromptFacts(reader, sources, nowMs, options) {
    const { includeWriteGuidance } = options;
    const userProfileGuidance = userProfileGuidanceFor(includeWriteGuidance);
    if (!options.includeAgentMemory) {
        return {
            userProfile: await readUserMemory(reader, sources),
            userProfileGuidance,
            agents: [],
        };
    }
    const snapshots = [];
    for (const source of sources) {
        try {
            snapshots.push({ source, memory: await reader.collectReminderMemory(source.agentName) });
        }
        catch {
            // One broken compatibility directory must not hide the rest of the family.
        }
    }
    const canonicalAgentName = sources.find((source) => source.canonical)?.agentName;
    return {
        userProfile: snapshots.find(({ memory }) => memory.user.trim())?.memory.user,
        userProfileGuidance,
        agents: snapshots.map((snapshot) => toAgentMemory(snapshot, includeWriteGuidance)),
        dailyNotes: canonicalAgentName
            ? await readDailyNotes(reader, canonicalAgentName, nowMs)
            : undefined,
    };
}
function userProfileGuidanceFor(includeWriteGuidance) {
    return [
        'The profile is durable context, not an activity log.',
        ...(includeWriteGuidance
            ? [
                'Use the native `memory` tool for updates; do not edit this injected block directly.',
                'Do NOT store: sensitive guesses, psychological labels, one-off moods, raw logs, transient task status, or routine recaps.',
            ]
            : [
                'This profile is maintained manually by the user in Settings. Use it as read-only context; do not edit its file or automatically write profile updates.',
            ]),
    ].join('\n');
}
function toAgentMemory(snapshot, includeWriteGuidance) {
    const { source, memory } = snapshot;
    return {
        canonical: source.canonical,
        main: memory.main,
        summary: memory.summary,
        topics: memory.topics.map((topic) => ({
            name: topic.name,
            description: topic.description,
            detail: `path: ${topic.path}`,
        })),
        // Retired owners are read-only compatibility blocks labelled with their owner.
        wording: memoryWording(memory.mainPath, {
            writable: includeWriteGuidance && source.canonical,
            provenance: source.canonical
                ? ''
                : ` sourceAgent="${escapeXml(source.agentName)}" legacy="true"`,
        }),
    };
}
function memoryWording(mainPath, scope) {
    const { writable, provenance } = scope;
    return {
        summary: {
            attributes: provenance,
            intro: [
                `This is the INDEX of your MEMORY.md (full file: ${mainPath}).`,
                'The <agent_memory_tail> below only shows the most recent slice — older entries are NOT in the tail.',
                'Use the source: line ranges below to Read the full file directly when you need older content.',
                'Topic files are listed separately in <available_memory_topics>; this index does NOT cover them.',
            ].join('\n'),
        },
        tail: {
            attributes: ` path="${mainPath}"${provenance}`,
            intro: writable
                ? 'Recent entries from your memory. If anything below needs updating, use the `memory` tool (target=main, operation=edit) — do NOT append.'
                : 'Recent entries from your memory.',
        },
        topics: {
            attributes: provenance,
            intro: [
                'Topic bodies are NOT injected — only metadata below.',
                writable
                    ? 'To READ a topic: use Read tool with `path`. To UPDATE a topic: use the `memory` tool (target=topic).'
                    : 'To READ a topic: use Read tool with `path`.',
            ].join('\n'),
        },
        note: [
            'Memory exceeded the injection budget — older entries are not shown above.',
            `For older entries, read ${mainPath}; for topic files, see <available_memory_topics>.`,
        ].join('\n'),
    };
}
function escapeXml(value) {
    return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}
async function readUserMemory(reader, sources) {
    try {
        if (reader.getUserMemory)
            return (await reader.getUserMemory()).content;
        const source = sources[0];
        if (!source)
            return undefined;
        return (await reader.collectReminderMemory(source.agentName)).user;
    }
    catch {
        return undefined;
    }
}
/** Any unreadable day drops the whole digest, never the rest of the prompt. */
async function readDailyNotes(reader, agentName, nowMs) {
    try {
        const now = new Date(nowMs());
        const notes = [];
        for (let offset = 0; offset <= DAILY_LOOKBACK_DAYS; offset += 1) {
            const date = new Date(now);
            date.setDate(date.getDate() - offset);
            const key = formatLocalDate(date);
            notes.push({ date: key, content: (await reader.getDaily(agentName, key)).content });
        }
        return notes;
    }
    catch {
        return undefined;
    }
}
function formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
//# sourceMappingURL=memory-prompt-reader.js.map