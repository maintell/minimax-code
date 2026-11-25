import { boundedSafetyCheck, DEFAULT_SAFETY_POLICY } from '../../agent-host/safety/policy.js';
import { createToolContentReview } from '../../agent-host/safety/tool-stage-review.js';
import { expectSame, expectTrue } from './conformance-case.js';
const CONTENT = 'conformance content';
const DIALOG_STAGES = ['input', 'output', 'thinking'];
const VERDICT_KINDS = ['pass', 'block', 'regenerate', 'unavailable'];
const UNAVAILABLE_CAUSES = ['timeout', 'transport', 'auth', 'upstream'];
/** Bound of a check whose backend never answers. */
const HANG_TIMEOUT_MS = 20;
/** Bound no answering backend reaches. */
const ANSWER_TIMEOUT_MS = 5_000;
/** The verdict kind after checking the verdict is one of the contract's forms. */
function verdictKind(verdict, what) {
    expectTrue(VERDICT_KINDS.includes(verdict.kind), `${what}: unknown verdict ${verdict.kind}`);
    if (verdict.kind === 'unavailable') {
        expectTrue(UNAVAILABLE_CAUSES.includes(verdict.cause), `${what}: unknown cause`);
    }
    if (verdict.kind === 'block') {
        expectTrue(['undefined', 'string'].includes(typeof verdict.reason), `${what}: block reason`);
    }
    return verdict.kind;
}
async function expectDialogVerdicts(check, kind, what) {
    for (const stage of DIALOG_STAGES) {
        const verdict = await check({ stage, content: CONTENT }, new AbortController().signal);
        expectSame(verdictKind(verdict, `${what} at ${stage}`), kind, `${what} at ${stage}`);
    }
}
/** The check with every review it receives recorded. */
function recorded(check) {
    const reviews = [];
    const recording = async (input, signal) => {
        reviews.push({ stage: input.stage, signal });
        return await check(input, signal);
    };
    return { check: recording, stages: () => reviews.map((review) => review.stage), reviews };
}
function toolReview(check, policy) {
    return createToolContentReview({
        check,
        safety: {
            policy: { enabledStages: [], maxRetries: 0, timeoutMs: ANSWER_TIMEOUT_MS, ...policy },
        },
        retryDelay: async () => undefined,
    });
}
async function toolStagesAllowed(review) {
    const signal = new AbortController().signal;
    expectTrue(review !== undefined, 'a policy with a tool stage installs the tool review');
    return {
        args: (await review?.allowsArgs({ path: CONTENT }, signal)) === true,
        result: (await review?.allowsResult({ content: CONTENT }, signal)) === true,
    };
}
const verdictCases = [
    {
        name: 'answers pass at every dialog stage when the review passes',
        run: async (subject) => {
            await expectDialogVerdicts(subject.check('pass'), 'pass', 'passing review');
        },
    },
    {
        name: 'answers block at every dialog stage when the review finds a violation',
        run: async (subject) => {
            await expectDialogVerdicts(subject.check('violation'), 'block', 'violation');
        },
    },
    {
        name: 'answers unavailable, never a content verdict, when the review API fails',
        run: async (subject) => {
            await expectDialogVerdicts(subject.check('api-error'), 'unavailable', 'API error');
        },
    },
];
const toolStageCases = [
    {
        name: 'is never called for a tool stage the policy does not enable',
        run: async (subject) => {
            const dialogOnly = recorded(subject.check('pass'));
            expectTrue(toolReview(dialogOnly.check, DEFAULT_SAFETY_POLICY) === undefined, 'the default policy installs no tool review');
            const argsOnly = recorded(subject.check('pass'));
            const argsAllowed = await toolStagesAllowed(toolReview(argsOnly.check, { enabledStages: ['tool-args'] }));
            expectTrue(argsAllowed.result, 'a disabled tool-result stage lets the result through');
            expectSame(argsOnly.stages(), ['tool-args'], 'reviews with only tool-args enabled');
            const resultOnly = recorded(subject.check('pass'));
            const resultAllowed = await toolStagesAllowed(toolReview(resultOnly.check, { enabledStages: ['tool-result'] }));
            expectTrue(resultAllowed.args, 'a disabled tool-args stage lets the call run');
            expectSame(resultOnly.stages(), ['tool-result'], 'reviews with only tool-result enabled');
        },
    },
    {
        name: 'fails both tool stages closed while the review API keeps failing',
        run: async (subject) => {
            const failing = recorded(subject.check('api-error'));
            const allowed = await toolStagesAllowed(toolReview(failing.check, { enabledStages: ['tool-args', 'tool-result'], maxRetries: 1 }));
            expectSame(allowed, { args: false, result: false }, 'tool stages after API errors');
            expectSame(failing.stages(), ['tool-args', 'tool-args', 'tool-result', 'tool-result'], 'reviews with one retry per stage');
        },
    },
];
const timeoutCases = [
    {
        name: 'fails a dialog check closed at the policy timeout and aborts the check signal',
        run: async (subject) => {
            const hanging = recorded(subject.check('hang'));
            const verdict = await boundedSafetyCheck(hanging.check, { stage: 'output', content: CONTENT }, new AbortController().signal, HANG_TIMEOUT_MS);
            expectSame(verdict, { kind: 'unavailable', cause: 'timeout' }, 'verdict at the timeout');
            expectTrue(hanging.reviews[0]?.signal.aborted === true, 'the timed-out check is aborted');
        },
    },
    {
        name: 'fails a tool stage closed at the policy timeout',
        run: async (subject) => {
            const allowed = await toolStagesAllowed(toolReview(subject.check('hang'), {
                enabledStages: ['tool-args'],
                timeoutMs: HANG_TIMEOUT_MS,
            }));
            expectTrue(!allowed.args, 'a tool call whose review timed out does not run');
        },
    },
];
/** Framework-free ContentSafetyGate cases; a Host runner gives each case a fresh subject. */
export const contentSafetyConformanceCases = Object.freeze([
    ...verdictCases,
    ...toolStageCases,
    ...timeoutCases,
]);
//# sourceMappingURL=content-safety-conformance.js.map