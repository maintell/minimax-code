import { BUNNY_AGENT_NAME } from '@mavis/shared/agent-avatar';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
/**
 * Bunny's bundled prompt marks the text that only applies while its main conversation has the
 * read-only helper sub-agents (config.yaml `bunny.helperAgents`). The prompt is plain text, not
 * Handlebars, so the block is resolved here: kept without its markers when the switch is on,
 * removed with them when it is off. Text outside the markers never changes.
 */
const HELPER_AGENTS_BLOCK = /\{if helper_agents\}([\s\S]*?)\{end helper_agents\}/gu;
export function renderBunnyHelperAgentSections(template, helperAgents) {
    return template.replace(HELPER_AGENTS_BLOCK, (_block, text) => helperAgents ? text : '');
}
/**
 * The text that only applies while Bunny's own memory is on (config.yaml `bunny.memory.enabled`),
 * marked and resolved like the helper paragraphs. Off removes it together with the memory policy
 * placeholder it encloses, so no Turn hears of memory, `remember` or the memory files.
 */
const MEMORY_BLOCK = /\{if memory\}([\s\S]*?)\{end memory\}/gu;
export function renderBunnyMemorySections(template, memory) {
    return template.replace(MEMORY_BLOCK, (_block, text) => (memory ? text : ''));
}
/**
 * The review-dispatch paragraphs that only apply while async review is on (config.yaml
 * `bunny.verdictGate`), marked and resolved like the helper paragraphs.
 *
 * Unlike the two blocks above, this pattern also consumes the newline that ends the
 * `{end verdict_gate}` line. The block is inserted between two existing sections, so removing
 * only the marked text would leave the blank line that separates them doubled. Consuming exactly
 * one trailing newline makes the off render byte for byte the template without this block, which
 * is what keeps the switch-off prompt identical to the prompt before this feature existed.
 */
const VERDICT_GATE_BLOCK = /\{if verdict_gate\}(\n[\s\S]*?)\{end verdict_gate\}\n/gu;
function renderBunnyVerdictGateSections(template, verdictGate) {
    return template.replace(VERDICT_GATE_BLOCK, (_block, text) => (verdictGate ? text : ''));
}
function renderBunnySections(template, input) {
    return renderBunnyVerdictGateSections(renderBunnyMemorySections(renderBunnyHelperAgentSections(template, input.bunnyHelperAgents === true), input.bunnyMemory === true), input.bunnyVerdictGate === true);
}
async function readOptionalFile(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch {
        return undefined;
    }
}
/**
 * Bunny's prompt is its own plain-text system prompt with the memory policy inlined (while memory
 * is on) and the runtime facts appended; it takes no persona, surface prompt or shared base layers.
 */
const bunnyAgentRenderer = {
    standalone: true,
    async renderParts({ agentDir, input }) {
        const [template, policy, facts, verdictDiscipline] = await Promise.all([
            readFile(join(agentDir, 'system-prompt.md'), 'utf8'),
            readOptionalFile(join(agentDir, 'memory-policy.md')),
            readFile(join(agentDir, 'runtime-facts.md'), 'utf8'),
            readOptionalFile(join(agentDir, 'verdict-discipline.md')),
        ]);
        const core = renderBunnySections(template, input);
        // Substituted only while the switch is on, so an off render never reads the review text at all.
        const resolved = input.bunnyVerdictGate === true
            ? core.replaceAll('{verdict_discipline}', verdictDiscipline?.trim() ?? '')
            : core;
        const agentPrompt = [resolved.replaceAll('{memory_policy}', policy ?? '').trim(), facts.trim()]
            .filter(Boolean)
            .join('\n\n');
        return { coreTemplate: template, agentPrompt };
    },
    async readCanonicalTemplate({ agentDir, input }) {
        // The helper-agent markers are resolved here too, so they never reach the seeded copy.
        const template = await readFile(join(agentDir, 'system-prompt.md'), 'utf8');
        return {
            systemPrompt: renderBunnySections(template, input),
        };
    },
};
/** Bunny registers its own renderer with the built-in catalog under its Agent name. */
export const BUNNY_AGENT_RENDERER_ENTRY = [BUNNY_AGENT_NAME, bunnyAgentRenderer];
//# sourceMappingURL=bunny-prompt.js.map