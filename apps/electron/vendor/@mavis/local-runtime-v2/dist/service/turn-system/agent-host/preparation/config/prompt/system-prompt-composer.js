import { isCoordinatorAgent } from '@mavis/shared/agent-coordination';
import { trustedProfileCoordination } from '../agent-coordination.js';
import { INSTRUCTIONS_CONTEXT_PREAMBLE } from '../../prompt-blocks.js';
import { addRuntimeRules } from './runtime-prompt-rules.js';
import { environmentContextBlock, } from './environment-prompt-composer.js';
export function buildSystemPrompt(scope) {
    const { agent, sessionType, layers, overrides, profile } = scope;
    const interactiveSurface = profile?.surface === undefined
        ? (sessionType ?? 'root') === 'root'
        : profile.surface !== 'task-child';
    return composePromptParts([
        buildIdentityPrompt({
            agent,
            layers,
            profile,
            interactiveSurface,
            overrides: interactiveSurface ? overrides : undefined,
        }),
        { text: environmentContextBlock(scope) },
        ...(!interactiveSurface
            ? [
                { text: '# Session Context' },
                { text: profile?.surfacePrompt.trim() ?? '' },
                { text: layers.sessionPrompt.trim() },
            ]
            : []),
        ...layers.memoryBlocks.map((text) => ({ text, kind: 'MEMORY' })),
        { text: layers.catalog.trim(), kind: 'SKILLS' },
        { text: layers.coordinatorMemory.trim(), kind: 'MEMORY' },
    ]);
}
function buildIdentityPrompt(scope) {
    const { agent, layers, profile, interactiveSurface, overrides } = scope;
    if (isCoordinatorProfile(profile)) {
        return composePromptParts([
            { text: profile.corePrompt.trim() },
            { text: layers.globalInstructions.trim(), kind: 'OTHER' },
        ]);
    }
    const customPrompt = overrides?.customPrompt?.trim();
    const appendPrompt = overrides?.appendSystemPrompt?.trim() ?? '';
    const persona = (profile?.persona ?? agent.persona)?.trim();
    const globalInstructions = layers.globalInstructions.trim();
    const projectInstructions = layers.projectInstructions.trim();
    // The preamble only renders when at least one instruction layer is present, so
    // an empty workspace never claims that context follows.
    const instructionsPreamble = globalInstructions || projectInstructions ? INSTRUCTIONS_CONTEXT_PREAMBLE : '';
    const corePrompt = (profile?.corePrompt ?? agent.systemPrompt).trim();
    const hasIdentity = [
        persona,
        corePrompt,
        profile?.surfacePrompt,
        layers.basePrompt,
        layers.sessionPrompt,
        globalInstructions,
        projectInstructions,
    ].some((part) => part?.trim());
    const rootSessionPrompt = [profile?.surfacePrompt, layers.sessionPrompt]
        .filter(Boolean)
        .join('\n\n');
    const identity = customPrompt
        ? [{ text: addRuntimeRules(customPrompt, interactiveSurface, rootSessionPrompt) }]
        : [
            { text: persona ?? '' },
            {
                text: addRuntimeRules(hasIdentity
                    ? corePrompt
                    : "You are a local coding assistant running in the user's workspace.", interactiveSurface, rootSessionPrompt),
            },
            { text: layers.basePrompt.trim() },
        ];
    return composePromptParts([
        ...identity,
        { text: appendPrompt },
        { text: instructionsPreamble },
        { text: globalInstructions, kind: 'OTHER' },
        { text: projectInstructions, kind: 'OTHER' },
    ]);
}
/**
 * A trusted coordinator owns its whole identity prompt: no workspace project
 * instructions, persona or shared runtime layers are added around it.
 */
export function isCoordinatorProfile(profile) {
    return isCoordinatorAgent(trustedProfileCoordination(profile));
}
/** The coordinator's own memory pipeline replaces agent-scoped memory blocks. */
export function usesCoordinatorMemoryPipeline(profile) {
    return trustedProfileCoordination(profile)?.memoryPipeline !== undefined;
}
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
//# sourceMappingURL=system-prompt-composer.js.map