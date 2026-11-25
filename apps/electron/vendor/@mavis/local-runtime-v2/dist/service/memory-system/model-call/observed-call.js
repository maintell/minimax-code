import { LLM_RETRY_BEFORE_REQUEST, LLM_RETRY_REQUEST_SETTLED_OBSERVER, } from '@mavis/agent-core/pi-turn-runner';
/**
 * 每个 physical attempt 独立建账；写入失败阻止后续请求，不被 best-effort observer 吞掉。
 * 记忆模型调用一律经 withLLMRetry 发出，按它的请求前与结算回调记账，重试的每次请求各记一笔。
 */
async function observeMemoryModelCall(input, invoke) {
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
    let result;
    try {
        result = await invoke({
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
        });
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
/** 单发、轮次循环与整理 Agent 共用请求参数与物理尝试记账；循环和终态解释仍由调用方负责。 */
export async function callMemoryModel(input) {
    const { resolved } = input;
    return observeMemoryModelCall({
        modelCalls: input.modelCalls,
        model: `${resolved.model.provider}/${resolved.model.id}`,
        reasoningEffort: input.reasoningEffort,
        nowMs: input.nowMs,
        signal: input.signal,
    }, async (retryOptions) => {
        const stream = await input.stream(resolved.model, input.context, {
            ...input.options,
            ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
            ...(resolved.headers ? { headers: resolved.headers } : {}),
            ...(resolved.fetch ? { fetch: resolved.fetch } : {}),
            ...(retryOptions ?? {}),
            // 推理强度来自记忆配置（设计 §2.3），覆盖会话侧 thinkingLevel。
            reasoning: input.reasoningEffort,
            maxTokens: input.maxTokens,
            signal: input.signal,
        });
        return input.consume ? input.consume(stream) : stream.result();
    });
}
//# sourceMappingURL=observed-call.js.map