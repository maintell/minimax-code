import { createSafetyMetrics } from './observability.js';
import { boundedSafetyCheck, resolveSafetyPolicy, safetyRetryDelay } from './policy.js';
/** v1 text (cloud-runtime `run-pi-turn`) for a call whose arguments failed review. */
export const TOOL_CALL_NOT_EXECUTED = 'Tool call was not executed.';
/** v1 text that replaces a tool result that failed review. */
export const TOOL_RESULT_UNAVAILABLE = 'Tool result unavailable.';
/** `undefined` when the policy enables no tool stage, so no hook is installed. */
export function createToolContentReview(options) {
    const policy = resolveSafetyPolicy(options.safety?.policy);
    const argsEnabled = policy.enabledStages.includes('tool-args');
    const resultEnabled = policy.enabledStages.includes('tool-result');
    if (!argsEnabled && !resultEnabled)
        return undefined;
    const runner = {
        check: options.check,
        policy,
        metrics: createSafetyMetrics(options.metrics, options.safety?.host),
        retryDelay: options.retryDelay ?? safetyRetryDelay,
    };
    return {
        allowsArgs: async (args, signal) => !argsEnabled || passesStage(runner, 'tool-args', serializeToolContent(args), signal),
        allowsResult: async (result, signal) => !resultEnabled || passesStage(runner, 'tool-result', serializeToolContent(result), signal),
        // Only a stage this policy enables could have reviewed the child call.
        childCallSkipped: (stage) => {
            if (stage === 'tool-args' ? argsEnabled : resultEnabled)
                runner.metrics.childCallSkipped(stage);
        },
    };
}
async function passesStage(runner, stage, content, signal) {
    if (content === undefined)
        return false;
    for (let attempt = 0; !signal.aborted; attempt += 1) {
        const verdict = await boundedSafetyCheck(runner.check, { stage, content }, signal, runner.policy.timeoutMs);
        if (signal.aborted)
            return false;
        runner.metrics.check(stage, verdict.kind);
        if (verdict.kind !== 'unavailable')
            return verdict.kind === 'pass';
        if (attempt >= runner.policy.maxRetries) {
            runner.metrics.unavailable(stage);
            return false;
        }
        await runner.retryDelay(signal);
    }
    return false;
}
/** v1 content: a string as is, anything else as JSON; unserializable content fails closed. */
function serializeToolContent(value) {
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value) ?? '';
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=tool-stage-review.js.map