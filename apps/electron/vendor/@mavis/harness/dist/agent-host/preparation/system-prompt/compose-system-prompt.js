import { environmentContextBlock } from './environment-block.js';
import { composeMemoryBlocks } from './memory-blocks.js';
import { addRuntimeRules } from './runtime-rules.js';
/**
 * Composes the system prompt in layer order: identity (with runtime rules),
 * appended override, instructions, environment, Session Context for
 * non-interactive surfaces, memory, the Skills catalog, the subagent catalog and
 * the coordinator memory.
 */
export function composeSystemPrompt(facts) {
    const { interactiveSurface } = facts;
    return composePromptParts([
        composeIdentityPrompt(facts),
        { text: environmentContextBlock(facts.environment) },
        ...(!interactiveSurface
            ? [
                { text: '# Session Context' },
                { text: facts.surfacePrompt?.trim() ?? '' },
                { text: facts.sessionPrompt.trim() },
            ]
            : []),
        ...(facts.memory ? composeMemoryBlocks(facts.memory) : []).map((text) => ({
            text,
            kind: 'MEMORY',
        })),
        { text: facts.skillsCatalog.trim(), kind: 'SKILLS' },
        { text: facts.subagentCatalog?.trim() ?? '' },
        { text: facts.coordinatorMemory?.trim() ?? '', kind: 'MEMORY' },
    ]);
}
function composeIdentityPrompt(facts) {
    if (facts.coordinatorIdentity) {
        return composePromptParts([
            { text: facts.corePrompt.trim() },
            { text: facts.globalInstructions.trim(), kind: 'OTHER' },
        ]);
    }
    const overrides = facts.interactiveSurface ? facts.overrides : undefined;
    const customPrompt = overrides?.customPrompt?.trim();
    const appendPrompt = overrides?.appendSystemPrompt?.trim() ?? '';
    const globalInstructions = facts.globalInstructions.trim();
    const projectInstructions = facts.projectInstructions.trim();
    const rulesScope = {
        interactiveSurface: facts.interactiveSurface,
        rootSessionPrompt: [facts.surfacePrompt, facts.sessionPrompt].filter(Boolean).join('\n\n'),
        rules: facts.runtimeRules,
    };
    const identity = customPrompt
        ? [{ text: addRuntimeRules(customPrompt, rulesScope) }]
        : [
            { text: facts.persona?.trim() ?? '' },
            { text: addRuntimeRules(facts.corePrompt.trim(), rulesScope) },
            { text: facts.basePrompt.trim() },
        ];
    return composePromptParts([
        ...identity,
        { text: appendPrompt },
        { text: instructionsPreamble(facts, globalInstructions || projectInstructions) },
        { text: globalInstructions, kind: 'OTHER' },
        { text: projectInstructions, kind: 'OTHER' },
    ]);
}
/**
 * The preamble only renders when at least one instruction layer is present, so
 * an empty workspace never claims that context follows.
 */
function instructionsPreamble(facts, instructions) {
    return instructions ? (facts.instructionsPreamble?.trim() ?? '') : '';
}
/**
 * Joins non-empty parts with a blank line, or a single newline right after a
 * Markdown heading, and shifts every nested range by the part's start offset.
 */
function composePromptParts(parts) {
    return parts
        .filter((part) => part.text)
        .reduce((composed, part, index, contentParts) => {
        const followsHeading = /^#{1,6} [^\n]+$/u.test(contentParts[index - 1]?.text ?? '');
        const boundary = followsHeading ? '\n' : '\n\n';
        const separator = composed.text ? boundary : '';
        const startOffset = composed.text.length + separator.length;
        const text = `${composed.text}${separator}${part.text}`;
        const ownRange = part.kind
            ? [{ kind: part.kind, startOffset, endOffset: text.length }]
            : [];
        const nestedRanges = (part.ranges ?? []).map((range) => ({
            kind: range.kind,
            startOffset: startOffset + range.startOffset,
            endOffset: startOffset + range.endOffset,
        }));
        return { text, ranges: [...composed.ranges, ...ownRange, ...nestedRanges] };
    }, { text: '', ranges: [] });
}
//# sourceMappingURL=compose-system-prompt.js.map