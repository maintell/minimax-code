/** 只包实际请求；完成观察在 catch 外，写入失败不触发第二次完成通知。 */
export async function observeMemoryModelCall(input, invoke) {
    const callId = input.modelCalls?.started({
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        startedAtMs: input.nowMs(),
    });
    let result;
    try {
        result = await invoke();
    }
    catch (error) {
        if (callId)
            input.modelCalls?.finished(callId, {
                finishedAtMs: input.nowMs(),
                stopReason: input.signal.aborted ? 'aborted' : 'error',
            });
        throw error;
    }
    if (callId)
        input.modelCalls?.finished(callId, {
            finishedAtMs: input.nowMs(),
            stopReason: result.stopReason,
            usage: result.usage,
        });
    return result;
}
//# sourceMappingURL=observed-call.js.map