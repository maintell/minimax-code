import { isBunnyAgentName } from '@mavis/shared/agent-avatar';
import { withBunnyMainEffort } from './bunny-model-defaults.js';
/**
 * Applies Bunny's main-conversation model default to every Root the Root application hands out,
 * on both of the timings that produce one.
 *
 * Bunny reaches a Root from more than one direction, and only some of them replace anything:
 * initialization and restoring a backup commit a replacement (`adopted`), while a read that finds no
 * Root — what an IM surface does the first time someone writes to Bunny from a channel — has the
 * invariant service repair a pointer, adopt a legacy Root or create one outright (`ensured`).
 * Materializing on replacement alone leaves that second Root with no model of its own, so its
 * queue and Turn fall back to the Runtime default and a remote `agent_config.bunny.default_model`
 * never applies to it. The Root application is where both timings meet, so the default is
 * materialized once, here, and Bunny's own `roots` port reads through it rather than repeating it.
 *
 * A Root that already carries a model keeps it: `withBunnyMainEffort` writes only while the record
 * still has none, so a model the user chose is never replaced.
 */
export function bunnyRootParticipant(input) {
    return {
        apply: async ({ agentName, root }) => {
            // Another Agent's Root is not this participant's to touch; `undefined` keeps the record read.
            if (!isBunnyAgentName(agentName))
                return undefined;
            return withBunnyMainEffort(input.records, input.modelConfig(), root, {
                logger: input.logger,
                remote: input.remote(),
            });
        },
    };
}
//# sourceMappingURL=bunny-root-participant.js.map