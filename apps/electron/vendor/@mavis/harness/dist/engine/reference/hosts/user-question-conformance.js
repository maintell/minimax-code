import { HarnessConformanceError, expectRejects, expectSame, expectTrue, } from '../conformance-case.js';
function hasAwait(subject) {
    return subject.host.await !== undefined;
}
function requestIdOf(result) {
    if ('suppressed' in result)
        throw new TypeError('The question was suppressed.');
    return result.requestId;
}
async function syncQuestion(subject, toolCallId = 'conformance-call') {
    const result = await subject.host.begin(subject.context(toolCallId), subject.question);
    if (!('responseMode' in result) || result.responseMode !== 'sync') {
        throw new HarnessConformanceError('the subject question opens as a sync question');
    }
    return result;
}
function awaitQuestion(subject, handle, signal) {
    if (!subject.host.await)
        throw new TypeError('A Host with sync questions must provide await.');
    return subject.host.await(handle, signal);
}
const perCall = {
    name: 'opens one question per call',
    run: async (subject) => {
        const first = requestIdOf(await subject.host.begin(subject.context('call-1'), subject.question));
        const second = requestIdOf(await subject.host.begin(subject.context('call-2'), subject.question));
        expectTrue(first.length > 0 && second.length > 0, 'request ids are non-empty');
        expectTrue(first !== second, 'each call opens its own question');
    },
};
const stoppedBegin = {
    name: 'opens no question once the Turn has stopped',
    run: async (subject) => {
        const stopped = new AbortController();
        stopped.abort();
        await expectRejects(() => subject.host.begin(subject.context('call-stopped'), subject.question, stopped.signal), 'begin after Stop');
    },
};
const answered = {
    name: 'returns the answer to a sync question',
    appliesTo: hasAwait,
    run: async (subject) => {
        const handle = await syncQuestion(subject);
        const waiting = awaitQuestion(subject, handle);
        await subject.answer(handle.requestId);
        const outcome = await waiting;
        expectSame(outcome.kind, 'answered', 'outcome kind');
        expectTrue(outcome.kind === 'answered' && outcome.content.length > 0, 'an answer carries model-visible content');
    },
};
const awaitedOnce = {
    name: 'waits on a question only once',
    appliesTo: hasAwait,
    run: async (subject) => {
        const handle = await syncQuestion(subject);
        const waiting = awaitQuestion(subject, handle);
        await subject.answer(handle.requestId);
        await waiting;
        await expectRejects(() => awaitQuestion(subject, handle), 'second await');
    },
};
const stoppedWait = {
    name: 'rejects a wait when the Turn stops, and releases the question',
    appliesTo: hasAwait,
    run: async (subject) => {
        const handle = await syncQuestion(subject);
        const turn = new AbortController();
        const waiting = awaitQuestion(subject, handle, turn.signal);
        turn.abort();
        await expectRejects(() => waiting, 'wait after Stop');
        await expectRejects(() => awaitQuestion(subject, handle), 'await after release');
    },
};
const lateWait = {
    name: 'rejects a wait that starts after the Turn stopped',
    appliesTo: hasAwait,
    run: async (subject) => {
        const handle = await syncQuestion(subject);
        const turn = new AbortController();
        turn.abort();
        await expectRejects(() => awaitQuestion(subject, handle, turn.signal), 'late wait');
    },
};
const foreignHandle = {
    name: 'rejects a handle it did not issue',
    appliesTo: hasAwait,
    run: async (subject) => {
        const foreign = {
            requestId: 'conformance-foreign-question',
            schemaVersion: 2,
            stepCount: 1,
            responseMode: 'sync',
            policyOverridden: false,
        };
        await expectRejects(() => awaitQuestion(subject, foreign), 'foreign handle');
    },
};
/** The ask_user contract the harness tools rely on; the wait cases need `await`. */
export const userQuestionHostConformanceCases = Object.freeze([
    perCall,
    stoppedBegin,
    answered,
    awaitedOnce,
    stoppedWait,
    lateWait,
    foreignHandle,
]);
//# sourceMappingURL=user-question-conformance.js.map