import { HarnessConformanceError, expectRejects, expectSame, expectTrue, } from '../conformance-case.js';
const UNKNOWN_SESSION = 'conformance-unknown-session';
const MATCHER_KINDS = new Set(['tool', 'command', 'path']);
function check(subject, call, sessionId = subject.sessionId) {
    const input = {
        sessionId,
        turnId: 'conformance-turn',
        agentName: subject.agentName,
        model: 'conformance/model',
        toolName: call.toolName,
        toolInput: call.toolInput,
        trustedExactWritePaths: [],
    };
    return subject.host.decisions.check(input);
}
async function expectBehavior(subject, call, sessionId, behavior) {
    const decision = await check(subject, call, sessionId);
    expectSame(decision.behavior, behavior, `${call.toolName} in ${sessionId}`);
    expectTrue(decision.reason.length > 0, `the ${behavior} decision carries a reason`);
    return decision;
}
function expectValidAsk(decision) {
    if (decision.behavior !== 'ask')
        throw new HarnessConformanceError('expected an ask decision');
    const contents = decision.ruleContents ?? [];
    expectTrue(contents.every((content) => typeof content === 'string'), 'ruleContents are strings');
    const matchers = decision.ruleMatchers ?? [];
    expectTrue(matchers.every((matcher) => MATCHER_KINDS.has(matcher.kind)), 'ruleMatchers name a matcher kind');
    expectTrue(matchers.every((matcher) => matcher.kind !== 'path' || matcher.actions.length > 0), 'a path matcher names its actions');
}
function plans(subject) {
    const executionPlans = subject.host.executionPlans;
    if (!executionPlans)
        throw new TypeError('The Host provides no execution plans.');
    return executionPlans;
}
function planFor(input) {
    return { originalInput: input, effectiveInput: input, intents: [], transforms: [] };
}
function request(subject, signal) {
    const approval = subject.host.approval;
    if (!approval)
        throw new TypeError('The Host provides no approval owner.');
    const { toolName, toolInput } = subject.calls.ask;
    return approval.request({
        sessionId: subject.sessionId,
        turnId: 'conformance-turn',
        toolCallId: 'conformance-call',
        agentName: subject.agentName,
        model: 'conformance/model',
        toolName,
        toolInput,
        reason: 'conformance approval',
        ruleContents: [toolName],
        ...(signal ? { signal } : {}),
    });
}
function mutations(subject) {
    const owner = subject.host.mutations;
    if (!owner)
        throw new TypeError('The Host provides no permission mutations.');
    return owner;
}
function allowAskedTool(subject, signal) {
    return mutations(subject).applyAtomic({
        sessionId: subject.sessionId,
        cwd: subject.cwd,
        updates: [
            {
                type: 'addRules',
                rules: [{ toolName: subject.calls.ask.toolName }],
                behavior: 'allow',
                destination: 'session',
            },
        ],
        ...(signal ? { signal } : {}),
    });
}
async function readablePaths(subject, sessionId) {
    const resolve = subject.host.resolveSessionOwnedReadablePaths;
    if (!resolve)
        throw new TypeError('The Host resolves no Session readable paths.');
    return resolve(sessionId);
}
const decisions = {
    name: 'decides allow, deny and ask with a reason',
    run: async (subject) => {
        await expectBehavior(subject, subject.calls.allow, subject.sessionId, 'allow');
        await expectBehavior(subject, subject.calls.deny, subject.sessionId, 'deny');
        expectValidAsk(await expectBehavior(subject, subject.calls.ask, subject.sessionId, 'ask'));
    },
};
const snapshotIsolation = {
    name: 'snapshots a tool input apart from the caller',
    appliesTo: (subject) => subject.host.executionPlans !== undefined,
    run: async (subject) => {
        const input = { path: 'notes.md', options: { lines: [1, 2] } };
        const snapshot = plans(subject).snapshotInput(input);
        input.options.lines.push(3);
        expectSame(snapshot, { path: 'notes.md', options: { lines: [1, 2] } }, 'snapshot');
    },
};
const planValidation = {
    name: 'accepts a plan only for the input it was made for',
    appliesTo: (subject) => subject.host.executionPlans !== undefined,
    run: async (subject) => {
        const { snapshotInput, validate } = plans(subject);
        const original = snapshotInput({ path: 'notes.md' });
        const other = snapshotInput({ path: 'secrets.md' });
        expectSame(validate(planFor(original), original).effectiveInput, original, 'effective input');
        await expectRejects(async () => validate(planFor(other), original), 'plan for another input');
        await expectRejects(async () => validate({ intents: [] }, original), 'malformed plan');
        await expectRejects(async () => validate('plan', original), 'non-object plan');
    },
};
const approvalReplies = {
    name: "returns the user's answer to an approval prompt",
    appliesTo: (subject) => subject.host.approval !== undefined,
    run: async (subject) => {
        for (const decision of ['allowOnce', 'allowAlways', 'deny']) {
            const waiting = request(subject);
            await subject.respond(decision);
            expectSame(await waiting, decision, 'approval decision');
        }
    },
};
const approvalStopped = {
    name: 'never allows a prompt once the Turn stops',
    appliesTo: (subject) => subject.host.approval !== undefined,
    run: async (subject) => {
        const turn = new AbortController();
        const waiting = request(subject, turn.signal);
        turn.abort();
        expectSame(await settledDecision(waiting), 'deny', 'prompt after Stop');
        expectSame(await settledDecision(request(subject, turn.signal)), 'deny', 'prompt after Stop');
    },
};
/** A stopped prompt may resolve `deny` or reject; both keep the call from running. */
async function settledDecision(waiting) {
    try {
        return await waiting;
    }
    catch {
        return 'deny';
    }
}
const sessionRules = {
    name: 'applies a Session rule to that Session only, until cleared',
    appliesTo: (subject) => subject.host.mutations !== undefined,
    run: async (subject) => {
        const { ask } = subject.calls;
        await expectBehavior(subject, ask, subject.sessionId, 'ask');
        await allowAskedTool(subject);
        await expectBehavior(subject, ask, subject.sessionId, 'allow');
        await expectBehavior(subject, ask, subject.otherSessionId, 'ask');
        await mutations(subject).clearSession(subject.sessionId);
        await expectBehavior(subject, ask, subject.sessionId, 'ask');
    },
};
const stoppedMutation = {
    name: 'refuses a Session rule once the Turn has stopped',
    appliesTo: (subject) => subject.host.mutations !== undefined,
    run: async (subject) => {
        const stopped = new AbortController();
        stopped.abort();
        await expectRejects(() => allowAskedTool(subject, stopped.signal), 'mutation after Stop');
        await expectBehavior(subject, subject.calls.ask, subject.sessionId, 'ask');
    },
};
const readableGrants = {
    name: 'grants a Session only the readable paths issued to it',
    appliesTo: (subject) => subject.host.resolveSessionOwnedReadablePaths !== undefined,
    run: async (subject) => {
        expectSame(await readablePaths(subject, UNKNOWN_SESSION), [], 'unknown Session grants');
        const granted = await subject.grantReadablePath(subject.sessionId);
        const own = await readablePaths(subject, subject.sessionId);
        const other = await readablePaths(subject, subject.otherSessionId);
        expectTrue(own.includes(granted), 'the Session reads the path issued to it');
        expectTrue(!other.includes(granted), 'another Session does not read it');
    },
};
const sideSessions = {
    name: 'recognizes side Sessions',
    appliesTo: (subject) => subject.host.sideSessions !== undefined,
    run: async (subject) => {
        const isSide = (sessionId) => subject.host.sideSessions?.isSideSession(sessionId);
        expectSame(await isSide(subject.sideSessionId), true, 'side Session');
        expectSame(await isSide(subject.sessionId), false, 'ordinary Session');
        expectSame(await isSide(UNKNOWN_SESSION), false, 'unknown Session');
    },
};
const miniAppApprovals = {
    name: 'lets an ordinary root Session prompt',
    appliesTo: (subject) => subject.host.miniAppApprovals !== undefined,
    run: async (subject) => {
        const denied = await subject.host.miniAppApprovals?.shouldDenyApproval(subject.sessionId, {
            miniApp: false,
            parentSessionId: null,
        });
        expectSame(denied, false, 'Mini App denial for an ordinary Session');
    },
};
/** The permission policy the harness gate consults; optional owners skip their cases. */
export const permissionHostConformanceCases = Object.freeze([
    decisions,
    snapshotIsolation,
    planValidation,
    approvalReplies,
    approvalStopped,
    sessionRules,
    stoppedMutation,
    readableGrants,
    sideSessions,
    miniAppApprovals,
]);
//# sourceMappingURL=permission-conformance.js.map