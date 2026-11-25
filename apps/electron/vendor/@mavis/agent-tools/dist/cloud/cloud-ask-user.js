import { Type } from '@sinclair/typebox';
import { defineRuntimeTool } from '@mavis/agent-core/tools';
import { logger } from '@mavis/shared/local-runtime-logging/logger';
import { LocalAskUserToolDef, prepareAskUserArguments, } from '../ask-user/index.js';
/**
 * Why the cloud definition owns its description and schema instead of spreading
 * `LocalAskUserToolDef`: AskUser v2 gave the shared definition an async mode
 * that shows the questionnaire and lets the Turn keep running, and only the
 * Desktop runtime implements it. The cloud protocol cannot: `begin` puts the
 * Turn into the waiting state, and from that point the host blocks every
 * remaining tool call of the step and skips the next model request, so the Turn
 * ends with the questionnaire pending and the answer starts a new Turn.
 *
 * Spreading the shared definition therefore advertised a contract this tool
 * never honored. A model planned "ask asynchronously, keep working, deliver the
 * conclusion", and the runtime stopped the Turn: the sibling tool calls were
 * skipped and no assistant message followed, with no error anywhere. Keeping
 * the description and the implementation on the same protocol is what stops
 * that; the Desktop definition is correct for Desktop and stays untouched.
 */
const CLOUD_ASK_USER_DESCRIPTION = [
    'Ask the user structured questions. Every call ends the current turn: the questionnaire is shown to the user, this turn stops, and the answer arrives later as a new message.',
    '',
    '**When to use**',
    '',
    '- Collect user decisions that determine the deliverable, such as its direction, one of several exclusive versions, facts only the user knows, or scope and permissions. Ask before building on a guess.',
    '- Request user input, takeover, or final-action confirmation required by the current workflow.',
    '- Resolve discoverable uncertainty first. Respect requests not to ask ordinary clarifying questions; required confirmations still apply.',
    '- Do not ask a choice that a dedicated user-action card already collects (for example, whether to install, enable, or connect a plugin).',
    '',
    '**Interaction**',
    '',
    '- Call the actual tool. Prose or simulated tool calls do not display a questionnaire or pause execution.',
    '- Gather related decisions in one concise questionnaire, even when conversational preferences favor one question at a time.',
    '- This call always ends the turn. It has no mode that shows the questions and returns while the turn keeps running.',
    '- Finish every step that does not depend on the answers before calling this tool. Tool calls batched into the same step are skipped, and this turn produces no further output.',
    '- Describe only what this turn actually delivers. Work finished before asking is delivered; work merely promised is not.',
    '- The answer arrives later as a new message. Ask each question once.',
].join('\n');
const DESKTOP_ASK_USER_OPENING = 'Ask the local desktop user structured questions';
/**
 * The ask_user description of the AskUser v2 questionnaire host
 * (cloud-harness-server): the shared Desktop description with only "the local
 * desktop user" changed to "the user". That host really supports `async` and
 * the user policy override, so every other line is the Desktop wording and
 * follows it automatically. Not the v1 contract above
 * ({@link CLOUD_ASK_USER_DESCRIPTION}), where every call ends the Turn.
 * cloud-harness-server's package boundary does not admit the `ask-user` entry,
 * so it reads this through `@mavis/agent-tools/cloud`.
 *
 * If the Desktop opening ever changes, this does not throw at module load
 * (that would break the whole cloud entry and the server's start-up): it
 * falls back to replacing the audience phrase, and cloud-ask-user.test.ts,
 * which asserts the opening, fails in CI instead.
 */
export const CLOUD_ASK_USER_V2_DESCRIPTION = cloudAskUserV2Description(LocalAskUserToolDef.description);
function cloudAskUserV2Description(desktop) {
    if (!desktop.startsWith(DESKTOP_ASK_USER_OPENING)) {
        return desktop.replace('the local desktop user', 'the user');
    }
    return `Ask the user structured questions${desktop.slice(DESKTOP_ASK_USER_OPENING.length)}`;
}
// The cloud questionnaire is the shared questionnaire without the Desktop-only
// async mode: mode / title / steps carry the whole payload. Naming the three
// properties keeps a later addition to the shared schema from silently
// re-advertising a capability this protocol does not have.
const { mode, title, steps } = LocalAskUserToolDef.schema.properties;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * A model trained on the Desktop contract may still send `async`. The cloud
 * schema forbids unknown properties, and rejecting the call would drop the
 * questionnaire the user is waiting for, so strip the field the way the shared
 * normalizer strips the retired `requiresExplicitResponse`. The call then
 * behaves exactly as the description states. Logged so a model still sending it
 * stays visible rather than failing quietly.
 */
function prepareCloudAskUserArguments(args) {
    const prepared = prepareAskUserArguments(args);
    if (!isRecord(prepared) || !('async' in prepared)) {
        return prepared;
    }
    const { async: asyncRequested, ...rest } = prepared;
    logger.info({
        reason: 'unsupported_field_stripped',
        field: 'async',
        value: String(asyncRequested),
    }, 'ask_user async argument stripped before validation');
    return rest;
}
export const CloudAskUserToolDef = {
    name: LocalAskUserToolDef.name,
    executionMode: LocalAskUserToolDef.executionMode,
    prepareArguments: prepareCloudAskUserArguments,
    description: CLOUD_ASK_USER_DESCRIPTION,
    schema: Type.Object({ mode, title, steps }, { additionalProperties: false }),
};
export function createCloudAskUserTool(adapter) {
    return defineRuntimeTool({
        ...CloudAskUserToolDef,
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            let result;
            try {
                result = await adapter.begin(ctx, input, signal);
            }
            catch (error) {
                if (signal?.aborted)
                    throw error;
                // A lost response can mean the question was persisted. Never continue
                // executing the unresolved action just because its acknowledgement was lost.
                const text = 'The questionnaire could not be confirmed. Stop this turn and reconcile the pending question before continuing.';
                return {
                    tool_name: CloudAskUserToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    isError: true,
                    terminate: true,
                };
            }
            if ('suppressed' in result) {
                const text = 'Question not asked: the user has already sent a new instruction. Follow the incoming user message instead.';
                return {
                    tool_name: CloudAskUserToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: { suppressed: true, reason: result.reason, waiting_for_user: false },
                };
            }
            // Every created questionnaire ends the Turn, which is what the description
            // promises. Keep the two in step: a non-terminating result here would
            // reintroduce the silent stop this definition was written to prevent.
            const text = `Questionnaire ${result.requestId} is waiting for the user. Stop this turn until the user replies.`;
            return {
                tool_name: CloudAskUserToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    request_id: result.requestId,
                    schema_version: result.schemaVersion,
                    step_count: result.stepCount,
                    waiting_for_user: true,
                },
                terminate: true,
            };
        },
    });
}
//# sourceMappingURL=cloud-ask-user.js.map