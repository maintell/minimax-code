import { LLM_RETRY_BEFORE_REQUEST, LLM_RETRY_REQUEST_SETTLED_OBSERVER, } from '@mavis/agent-core/pi-turn-runner';
/** 每个 physical attempt 独立建账；写入失败阻止后续请求，不被 best-effort observer 吞掉。 */
export async function observeMemoryModelCall(input, invoke) {
    const observer = input.modelCalls;
    if (!observer)
        return invoke();
    let active;
    let writeFailure;
    const assertWritable = () => {
        if (writeFailure)
            throw writeFailure.error;
    };
    const start = (requestAttempt) => {
        assertWritable();
        active = {
            callId: observer.started({
                model: input.model,
                reasoningEffort: input.reasoningEffort,
                startedAtMs: input.nowMs(),
            }),
            requestAttempt,
            settled: false,
        };
    };
    const finish = (result) => {
        if (!active || active.settled)
            return;
        active.settled = true;
        try {
            observer.finished(active.callId, result);
        }
        catch (error) {
            writeFailure = { error };
            throw error;
        }
    };
    if (!input.retryManaged)
        start(1);
    let result;
    try {
        result = await invoke(input.retryManaged
            ? {
                [LLM_RETRY_BEFORE_REQUEST]: start,
                [LLM_RETRY_REQUEST_SETTLED_OBSERVER]: (event) => {
                    if (event.requestAttempt !== active?.requestAttempt)
                        return;
                    finish({
                        finishedAtMs: input.nowMs(),
                        stopReason: { success: 'stop', abort: 'aborted', error: 'error' }[event.outcome],
                        ...(event.reportedUsage ? { usage: event.reportedUsage } : {}),
                    });
                },
            }
            : undefined);
    }
    catch (error) {
        assertWritable();
        finish({
            finishedAtMs: input.nowMs(),
            stopReason: input.signal.aborted ? 'aborted' : 'error',
        });
        throw error;
    }
    assertWritable();
    finish({
        finishedAtMs: input.nowMs(),
        stopReason: result.stopReason,
        usage: result.usage,
    });
    return result;
}
//# sourceMappingURL=observed-call.js.map