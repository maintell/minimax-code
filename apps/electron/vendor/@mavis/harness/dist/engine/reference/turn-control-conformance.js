import { closeOutcome, conformanceSteering as steering, expectRejects, expectSame, expectTrue, steeringKeys, } from './conformance-case.js';
const SESSION_ID = 'conformance-session';
async function expectDrained(control, expected, what) {
    expectSame(steeringKeys(await control.drainSteering()), expected, what);
}
async function expectClose(control, expected, what, options) {
    expectSame(closeOutcome(await control.tryBeginClose(options)), expected, what);
}
const CLOSED = { closed: true };
const STEER_PENDING = { closed: false, reason: 'steer-pending' };
const steeringLaneCases = [
    {
        name: 'drains ordinary steering in admission order and claims it once',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            expectTrue(await turn.steer(steering('user', 'a')), 'steering a is accepted');
            expectTrue(await turn.steer(steering('machine', 'b')), 'steering b is accepted');
            await expectDrained(turn.control, ['a', 'b'], 'first drain');
            await expectDrained(turn.control, [], 'second drain');
        },
    },
    {
        name: 'admits one steering identity once',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            expectTrue(await turn.steer(steering('user', 'a')), 'first admission');
            expectTrue(await turn.steer(steering('user', 'a')), 'duplicate admission still answers');
            await expectDrained(turn.control, ['a'], 'drain after duplicate admission');
        },
    },
    {
        name: 'restores a failed claim ahead of newer steering',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            await turn.steer(steering('user', 'a'));
            await turn.steer(steering('user', 'b'));
            const claimed = await turn.control.drainSteering();
            await turn.steer(steering('user', 'c'));
            await turn.control.restoreSteering(claimed);
            await expectDrained(turn.control, ['a', 'b', 'c'], 'drain after restore');
        },
    },
    {
        name: 'never restores acknowledged steering',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            await turn.steer(steering('user', 'a'));
            const claimed = await turn.control.drainSteering();
            await turn.control.ackSteering(claimed);
            await turn.control.restoreSteering(claimed);
            await expectDrained(turn.control, [], 'drain after ack and restore');
        },
    },
    {
        name: 'wakes the steering signal on ordinary admission only',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            // Optional capability: a Host without wake-ups is polled at step boundaries.
            if (!turn.control.steeringSignal)
                return;
            const before = turn.control.steeringSignal();
            expectTrue(before?.aborted === false, 'a fresh signal is not aborted');
            await turn.control.toolResultTail.open();
            await turn.steerToolResultTail(steering('user', 'tail'));
            expectTrue(before?.aborted === false, 'tool-result tail admission does not wake');
            await turn.steer(steering('user', 'a'));
            expectTrue(before?.aborted === true, 'ordinary admission wakes the snapshot');
            const after = turn.control.steeringSignal();
            expectTrue(after !== before && after?.aborted === false, 'the next snapshot is fresh');
        },
    },
];
const closeCases = [
    {
        name: 'holds the close while a drained claim is unacknowledged',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            await turn.steer(steering('user', 'a'));
            await turn.steer(steering('user', 'b'));
            const claimed = await turn.control.drainSteering();
            await turn.control.ackSteering(claimed.slice(0, 1));
            await expectClose(turn.control, STEER_PENDING, 'close with one claim in flight');
            await turn.control.ackSteering(claimed.slice(1));
            await expectClose(turn.control, CLOSED, 'close after every ack');
        },
    },
    {
        name: 'hands pending user steering back on close',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            await turn.steer(steering('user', 'u'));
            await expectClose(turn.control, CLOSED, 'close with user steering pending');
            expectSame(steeringKeys(turn.handedBack()), ['u'], 'handed-back steering');
            await expectDrained(turn.control, [], 'drain after close');
        },
    },
    {
        name: 'holds a non-final close for machine steering and hands it back on a final close',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            await turn.steer(steering('machine', 'm'));
            await expectClose(turn.control, STEER_PENDING, 'non-final close');
            expectSame(steeringKeys(turn.handedBack()), [], 'nothing handed back while held');
            await expectClose(turn.control, CLOSED, 'final close', { final: true });
            expectSame(steeringKeys(turn.handedBack()), ['m'], 'handed-back steering');
        },
    },
    {
        name: 'hands terminal user steering back only when the work is closed',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            await turn.steer(steering('terminal', 't'));
            await expectClose(turn.control, STEER_PENDING, 'close with open work');
            await expectClose(turn.control, CLOSED, 'close with closed work', { workClosed: true });
            expectSame(steeringKeys(turn.handedBack()), ['t'], 'handed-back steering');
        },
    },
    {
        name: 'refuses every lane once the close was won',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            await expectClose(turn.control, CLOSED, 'idle close');
            expectTrue(!(await turn.steer(steering('user', 'u'))), 'user steering is refused');
            expectTrue(!(await turn.steer(steering('machine', 'm'))), 'machine steering is refused');
            expectTrue(!(await turn.control.toolResultTail.open()), 'the tool-result tail stays shut');
            await expectDrained(turn.control, [], 'drain after close');
        },
    },
    {
        name: 'reopens a won close for machine steering while user steering waits',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            await expectClose(turn.control, CLOSED, 'first close');
            expectTrue(await turn.control.cancelClose(), 'the close is reverted');
            expectTrue(await turn.steer(steering('machine', 'm')), 'machine steering joins');
            expectTrue(!(await turn.steer(steering('user', 'u'))), 'user steering waits');
            const claimed = await turn.control.drainSteering();
            expectSame(steeringKeys(claimed), ['m'], 'drain after reopen');
            await turn.control.ackSteering(claimed);
            await expectClose(turn.control, CLOSED, 'second close');
        },
    },
    {
        name: 'refuses to reopen once a stop arrived while closing',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            await expectClose(turn.control, CLOSED, 'close');
            await turn.abort('user-stop');
            expectTrue(!(await turn.control.cancelClose()), 'the stop forbids the reopen');
        },
    },
];
const toolResultTailCases = [
    {
        name: 'keeps the tool-result tail shut until a tool opens it',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            expectTrue(!(await turn.steerToolResultTail(steering('user', 't'))), 'shut tail refuses');
            expectTrue(await turn.control.toolResultTail.open(), 'a running Turn opens the tail');
            expectTrue(await turn.steerToolResultTail(steering('user', 't')), 'open tail accepts');
        },
    },
    {
        name: 'keeps tool-result tail steering out of the ordinary lane and holds the close',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            await turn.control.toolResultTail.open();
            await turn.steerToolResultTail(steering('user', 't'));
            await expectDrained(turn.control, [], 'ordinary drain');
            await expectClose(turn.control, STEER_PENDING, 'close with unclaimed tail steering');
        },
    },
    {
        name: 'claims the tool-result tail once per tool call and replays that claim',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            const { toolResultTail } = turn.control;
            await toolResultTail.open();
            await turn.steerToolResultTail(steering('user', 't'));
            expectSame(steeringKeys(await toolResultTail.closeAndClaim('call-1')), ['t'], 'claim');
            expectSame(steeringKeys(await toolResultTail.closeAndClaim('call-1')), ['t'], 'replay');
            expectTrue(!(await turn.steerToolResultTail(steering('user', 'late'))), 'tail is shut');
            await expectClose(turn.control, STEER_PENDING, 'close with the claim in flight');
            await toolResultTail.ack('call-1');
            await expectClose(turn.control, CLOSED, 'close after the ack');
        },
    },
];
const teardownCases = [
    {
        name: 'abort hands pending steering back and fences the control',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            await turn.steer(steering('user', 'u'));
            await turn.steer(steering('machine', 'm'));
            await turn.abort('user-stop');
            expectSame(steeringKeys(turn.handedBack()), ['u', 'm'], 'handed-back steering');
            await expectDrained(turn.control, [], 'drain after abort');
            await expectClose(turn.control, { closed: false, reason: 'aborted' }, 'close after abort');
            expectTrue(!(await turn.steer(steering('user', 'late'))), 'steering after abort');
        },
    },
    {
        name: 'restoring a claim after abort hands it back',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            await turn.steer(steering('user', 'u'));
            const claimed = await turn.control.drainSteering();
            await turn.abort('user-stop');
            expectSame(steeringKeys(turn.handedBack()), [], 'claimed steering is not handed back yet');
            await turn.control.restoreSteering(claimed);
            expectSame(steeringKeys(turn.handedBack()), ['u'], 'handed-back steering');
            await expectDrained(turn.control, [], 'drain after restore');
        },
    },
    {
        name: 'abnormal seal hands pending steering back and fences the control',
        run: async (subject) => {
            const turn = await subject.start(SESSION_ID);
            await turn.steer(steering('user', 'u'));
            await turn.steer(steering('machine', 'm'));
            await turn.control.sealAbnormalTerminal();
            expectSame(steeringKeys(turn.handedBack()), ['u', 'm'], 'handed-back steering');
            await expectDrained(turn.control, [], 'drain after seal');
            expectTrue(!(await turn.steer(steering('user', 'late'))), 'steering after seal');
        },
    },
    {
        name: 'a released Turn leaves a stale control that never reaches the next Turn',
        run: async (subject) => {
            const first = await subject.start(SESSION_ID);
            await first.release();
            await expectClose(first.control, { closed: false, reason: 'stale-lease' }, 'stale close');
            expectTrue(!(await first.control.cancelClose()), 'stale reopen');
            expectTrue(!(await first.control.toolResultTail.open()), 'stale tail open');
            await expectRejects(() => first.control.sealAbnormalTerminal(), 'stale seal');
            const next = await subject.start(SESSION_ID);
            await next.steer(steering('user', 'x'));
            await expectDrained(first.control, [], 'stale drain');
            await expectDrained(next.control, ['x'], 'next Turn drain');
        },
    },
];
/** Answers every Host Turn control must give the harness, derived from the desktop owner. */
export const turnControlConformanceCases = Object.freeze([
    ...steeringLaneCases,
    ...closeCases,
    ...toolResultTailCases,
    ...teardownCases,
]);
//# sourceMappingURL=turn-control-conformance.js.map