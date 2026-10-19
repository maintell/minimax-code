import { readGenuineUserQueryText } from './checkpoint-format.js';
const TOOL_RESULT_REMOVED_TEXT = '[Tool result removed by context compaction.]';
const MEDIA_REMOVED_TEXT = '[Media removed by context compaction.]';
const PROTECTED_TOOL_ROUND_RATIO = 0.3;
const ELIGIBLE_TOOL_NAMES = new Set([
    'read',
    'bash',
    'grep',
    'glob',
    'web_search',
    'web_fetch',
    'edit',
    'write',
]);
export function buildToolTrimCandidate(messages) {
    const rounds = parseToolRounds(messages);
    const protectedRoundCount = Math.ceil(rounds.length * PROTECTED_TOOL_ROUND_RATIO);
    const protectedRounds = new Set(rounds.slice(-protectedRoundCount));
    return buildToolResultCandidate(messages, rounds, (round, _message, toolName) => {
        return !protectedRounds.has(round) && ELIGIBLE_TOOL_NAMES.has(canonicalToolName(toolName));
    });
}
export function buildAllToolResultsCandidate(messages) {
    const rounds = parseToolRounds(messages);
    return buildToolResultCandidate(messages, rounds, () => true);
}
export function buildAttachmentFreeCandidate(messages) {
    const replacements = new Map();
    let replacedBlockCount = 0;
    messages.forEach((message, index) => {
        const content = Reflect.get(message, 'content');
        if (!Array.isArray(content))
            return;
        const nextContent = content.filter((block) => {
            if (!isStructuredMediaBlock(block))
                return true;
            replacedBlockCount += 1;
            return false;
        });
        if (nextContent.length !== content.length) {
            const replacement = { ...message };
            Reflect.set(replacement, 'content', nextContent.length > 0 ? nextContent : [{ type: 'text', text: MEDIA_REMOVED_TEXT }]);
            replacements.set(index, replacement);
        }
    });
    return {
        messages: replacements.size === 0
            ? messages
            : messages.map((message, index) => replacements.get(index) ?? message),
        replacedBlockCount,
    };
}
export function buildMinimalGenuineQueryCandidate(messages) {
    const text = findLatestGenuineUserQueryText(messages);
    if (text === undefined)
        return undefined;
    return [{ role: 'user', content: [{ type: 'text', text }], timestamp: 0 }];
}
export function buildMiddleDeletionCandidate(messages, fits) {
    const closures = buildHistoryClosures(messages);
    const protectedClosures = collectProtectedClosures(messages, closures);
    const deletionOrder = middleOutOrder(closures.flatMap((_closure, index) => (protectedClosures.has(index) ? [] : [index])));
    const removedIndexes = new Set();
    for (const closureIndex of deletionOrder) {
        closures[closureIndex]?.messageIndexes.forEach((index) => removedIndexes.add(index));
        const candidate = messages.filter((_message, index) => !removedIndexes.has(index));
        parseToolRounds(candidate);
        if (fits(candidate))
            return candidate;
    }
    return undefined;
}
/**
 * The irreducible remainder of middle deletion: closure 0 plus every closure
 * containing a user message. Used for content-free failure diagnostics only.
 */
export function buildProtectedSkeletonCandidate(messages) {
    const closures = buildHistoryClosures(messages);
    const protectedClosures = collectProtectedClosures(messages, closures);
    const keptIndexes = new Set();
    closures.forEach((closure, closureIndex) => {
        if (!protectedClosures.has(closureIndex))
            return;
        closure.messageIndexes.forEach((index) => keptIndexes.add(index));
    });
    return messages.filter((_message, index) => keptIndexes.has(index));
}
function collectProtectedClosures(messages, closures) {
    const protectedClosures = new Set([0]);
    closures.forEach((closure, closureIndex) => {
        if (closure.messageIndexes.some((messageIndex) => messages[messageIndex]?.role === 'user')) {
            protectedClosures.add(closureIndex);
        }
    });
    return protectedClosures;
}
function buildToolResultCandidate(messages, rounds, eligible) {
    const replacements = new Map();
    let trimmedRoundCount = 0;
    rounds.forEach((round) => {
        const replacementCountBeforeRound = replacements.size;
        round.resultIndexes.forEach((index) => {
            const message = messages[index];
            if (!message || message.role !== 'toolResult') {
                throw new TypeError('Context compaction history contains an invalid tool result.');
            }
            const callId = readNonEmpty(message, 'toolCallId');
            const toolName = callId ? round.toolCallsById.get(callId)?.name : undefined;
            if (!toolName || !eligible(round, message, toolName))
                return;
            if (isRemovedToolResult(message))
                return;
            replacements.set(index, {
                ...message,
                content: [{ type: 'text', text: TOOL_RESULT_REMOVED_TEXT }],
            });
        });
        if (replacements.size > replacementCountBeforeRound)
            trimmedRoundCount += 1;
    });
    return {
        messages: replacements.size === 0
            ? messages
            : messages.map((message, index) => replacements.get(index) ?? message),
        trimmedResultCount: replacements.size,
        trimmedRoundCount,
    };
}
function isRemovedToolResult(message) {
    const onlyBlock = message.content.length === 1 ? message.content[0] : undefined;
    return onlyBlock?.type === 'text' && onlyBlock.text === TOOL_RESULT_REMOVED_TEXT;
}
export function parseToolRounds(messages, options = {}) {
    const rounds = [];
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message)
            continue;
        const calls = readRoundToolCalls(message);
        if (!calls)
            continue;
        const toolCallsById = indexToolCalls(calls);
        const { resultIndexes, settled } = settleToolRound(messages, {
            assistantIndex: index,
            callCount: calls.length,
            toolCallsById,
            allowIncompleteTail: options.allowIncompleteTail === true,
        });
        rounds.push({ assistantIndex: index, resultIndexes, toolCallsById, settled });
        index += resultIndexes.length;
    }
    return rounds;
}
function buildHistoryClosures(messages) {
    const roundsByAssistantIndex = new Map(parseToolRounds(messages).map((round) => [round.assistantIndex, round]));
    const closures = [];
    for (let index = 0; index < messages.length; index += 1) {
        const round = roundsByAssistantIndex.get(index);
        if (!round) {
            closures.push({ messageIndexes: [index] });
            continue;
        }
        closures.push({ messageIndexes: [round.assistantIndex, ...round.resultIndexes] });
        index += round.resultIndexes.length;
    }
    return closures;
}
function findLatestGenuineUserQueryText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message)
            continue;
        if (!isUserQueryCandidate(message))
            continue;
        if (!hasUserQueryProvenance(message))
            continue;
        const queryText = readGenuineUserQueryText(message);
        if (!queryText?.trim() || /^\/compact(?:\s|$)/iu.test(queryText.trim()))
            continue;
        return queryText;
    }
    return undefined;
}
function hasUserQueryProvenance(message) {
    return (Object.hasOwn(message, 'genuineUserQueryText') || Object.hasOwn(message, 'canonicalTextRange'));
}
function isUserQueryCandidate(message) {
    return message.role === 'user' && !Reflect.get(message, 'archonCompaction');
}
function middleOutOrder(closureIndexes) {
    if (closureIndexes.length === 0)
        return [];
    const order = [];
    const middle = Math.floor((closureIndexes.length - 1) / 2);
    for (let distance = 0; order.length < closureIndexes.length; distance += 1) {
        const backward = middle - distance;
        const backwardIndex = closureIndexes[backward];
        if (backwardIndex !== undefined)
            order.push(backwardIndex);
        if (distance === 0)
            continue;
        const forward = middle + distance;
        const forwardIndex = closureIndexes[forward];
        if (forwardIndex !== undefined)
            order.push(forwardIndex);
    }
    return order;
}
function readRoundToolCalls(message) {
    if (message.role === 'toolResult') {
        throw new TypeError('Context compaction history contains an orphan tool result.');
    }
    if (message.role !== 'assistant')
        return undefined;
    const calls = readToolCalls(message);
    return calls.length === 0 ? undefined : calls;
}
function indexToolCalls(calls) {
    const toolCallsById = new Map();
    calls.forEach((call) => {
        if (toolCallsById.has(call.id)) {
            throw new TypeError('Context compaction history contains a duplicate tool call.');
        }
        toolCallsById.set(call.id, call);
    });
    return toolCallsById;
}
function settleToolRound(messages, input) {
    const resultIndexes = [];
    const matched = new Set();
    while (resultIndexes.length < input.callCount) {
        const resultIndex = input.assistantIndex + resultIndexes.length + 1;
        const result = messages[resultIndex];
        if (!result && input.allowIncompleteTail)
            return { resultIndexes, settled: false };
        const callId = readSettledCallId(result, input.toolCallsById, matched);
        matched.add(callId);
        resultIndexes.push(resultIndex);
    }
    return { resultIndexes, settled: true };
}
function readSettledCallId(result, toolCallsById, matched) {
    if (!result || result.role !== 'toolResult') {
        throw new TypeError('Context compaction history ends before all tool results settle.');
    }
    const callId = readNonEmpty(result, 'toolCallId');
    if (!callId || !toolCallsById.has(callId) || matched.has(callId)) {
        throw new TypeError('Context compaction history contains an invalid tool result.');
    }
    return callId;
}
function readToolCalls(message) {
    return message.content.flatMap((block) => {
        if (block.type !== 'toolCall')
            return [];
        const id = readNonEmpty(block, 'id');
        const name = readNonEmpty(block, 'name');
        if (!id || !name) {
            throw new TypeError('Context compaction history contains an invalid tool call.');
        }
        return [{ id, name, arguments: Reflect.get(block, 'arguments') }];
    });
}
function canonicalToolName(name) {
    const normalized = name.trim().toLowerCase();
    return normalized === 'powershell' ||
        normalized === 'powershell.exe' ||
        normalized === 'pwsh' ||
        normalized === 'pwsh.exe'
        ? 'bash'
        : normalized;
}
function isStructuredMediaBlock(block) {
    if (!block || typeof block !== 'object')
        return false;
    const type = Reflect.get(block, 'type');
    return type === 'image' || type === 'video';
}
function readNonEmpty(value, key) {
    const field = Reflect.get(value, key);
    return typeof field === 'string' && field.trim() ? field.trim() : undefined;
}
//# sourceMappingURL=history-reduction.js.map