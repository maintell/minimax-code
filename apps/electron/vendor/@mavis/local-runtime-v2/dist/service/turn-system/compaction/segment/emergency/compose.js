import { EMERGENCY_SAFETY_SUMMARY_NOTE } from '../../../../coordinator-text/index.js';
import { buildHeaderMessage, renderHandoffHeader, } from '../algorithm/handoff-header.js';
import { isRetainedFinalReply, planRetention } from '../algorithm/retention.js';
import { coordinatorVisibleTexts } from '../algorithm/transcript.js';
import { levelCounter } from './content.js';
import { fitIncidents } from './handoff.js';
/**
 * What an emergency rebuild keeps below its header (spec 4.1), before its
 * level replaces anything: the retained text of the history before the
 * running Turn (12.4–12.6), the user's words Bunny has not answered yet
 * (4.3), then the running Turn's records. The unanswered words are kept
 * whole and outside the retention shares; the other records of the Turns
 * they started (tool calls and results of a failed or stopped Turn) are
 * recent turns like any other, kept within the share. Every record kept
 * from the active history keeps its source index, in order; delta blocks of
 * earlier Turns are dropped, the running Turn keeps its own. The safety
 * level keeps no retained text (4.4).
 */
export function planEmergencyEntries(input) {
    const { records, tailStart, facts } = input;
    const unreplied = unrepliedUserWords(records, tailStart, facts);
    const words = unreplied.map((index) => ({
        at: index,
        entry: {
            message: records[index].message,
            source: index,
            record: records[index],
            place: 'unreplied',
        },
    }));
    const retained = input.level === 'safety' ? [] : retainedBefore(input, new Set(unreplied));
    const earlier = [...retained, ...words].sort((left, right) => left.at - right.at);
    const turn = records.flatMap((record, index) => {
        if (index < tailStart)
            return [];
        if (facts.isDeltaBlock(record.message) && !inTurn(record, input.turnId))
            return [];
        return [{ message: record.message, source: index, record, place: 'turn' }];
    });
    return [...earlier.map((item) => item.entry), ...turn];
}
/**
 * The retention rules over the history before the running Turn, the
 * unanswered user words left out: they are kept whole on their own.
 */
function retainedBefore(input, unreplied) {
    const kept = input.records
        .slice(0, input.tailStart)
        .map((record, index) => ({ record, index }))
        .filter(({ index }) => !unreplied.has(index));
    const plan = planRetention({
        records: kept.map(({ record }) => record),
        facts: input.facts,
        counter: levelCounter(input.level, input.counter),
        recentTurnsTokens: input.shares.recentTurns,
        userWordsTokens: input.shares.userWords,
        mediaDescriptions: input.descriptions,
        dropThinking: input.dropThinking,
        timestamp: input.timestamp,
    });
    return plan.items.map((item) => {
        if (item.kind === 'new') {
            return {
                at: kept[item.from].index,
                entry: { message: item.message, source: null, place: 'retained' },
            };
        }
        const { index, record } = kept[item.index];
        return {
            at: index,
            entry: { message: item.message, source: index, record, place: 'retained' },
        };
    });
}
/** The rebuilt segment: its header, then the entries in order. */
export function assembleEmergencySegment(input) {
    const safety = input.level === 'safety';
    const header = renderHandoffHeader({
        checkpoint: { sections: safety ? [] : input.carried.sections },
        material: input.material,
        shares: input.shares,
        counter: input.counter,
        formatTime: input.formatTime,
        incidents: fitIncidents([input.incident, ...input.carried.incidents], input.counter),
        ...(safety ? { noSummaryNote: EMERGENCY_SAFETY_SUMMARY_NOTE } : {}),
        noteUnreadable: true,
    });
    const firstTurnEntry = input.entries.findIndex((entry) => entry.place === 'turn');
    return {
        messages: [
            buildHeaderMessage(header.summary, input.tokensBefore, input.timestamp),
            ...input.entries.map((entry) => entry.message),
        ],
        sourceIndexes: [null, ...input.entries.map((entry) => entry.source)],
        header,
        turnStart: firstTurnEntry < 0 ? input.entries.length + 1 : firstTurnEntry + 1,
    };
}
/**
 * The user's own words that arrived after Bunny last said something
 * visible, before the running Turn (spec 4.3), in order. Reports, cron and
 * system messages do not count.
 */
function unrepliedUserWords(records, tailStart, facts) {
    let lastReply = -1;
    for (let index = tailStart - 1; index >= 0; index -= 1) {
        if (isBunnyReply(records[index].message)) {
            lastReply = index;
            break;
        }
    }
    const words = [];
    for (let index = lastReply + 1; index < tailStart; index += 1) {
        if (isUserWords(records[index], facts))
            words.push(index);
    }
    return words;
}
function isUserWords(record, facts) {
    if (record.message.role !== 'user')
        return false;
    const kind = facts.classifyUser(record);
    return kind === 'typed' || kind === 'questionnaire';
}
/** Bunny's visible words, the retained note of them, or the header that summarizes them. */
function isBunnyReply(message) {
    if (message.role === 'compactionSummary')
        return true;
    if (message.role === 'assistant')
        return coordinatorVisibleTexts(message).length > 0;
    return isRetainedFinalReply(message);
}
function inTurn(record, turnId) {
    return record.turnId === turnId || record.turnId.startsWith(`${turnId}:`);
}
//# sourceMappingURL=compose.js.map