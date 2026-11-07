// Re-apply the local behavioural patches to freshly vendored snapshots.
//
// The shipped client retries a failed model request with exponential backoff and
// a five-attempt / two-minute budget, and treats a handful of transport shapes as
// terminal. This product wants the opposite: provider errors retry without a
// practical limit, on a fixed three-second cadence, so an unstable upstream
// recovers on its own.
//
// Re-vendoring a new shipped build resets these files to their shipped content,
// so the patches live here instead of being hand-edited into the snapshot. Every
// anchor is asserted: if an upgrade refactors the emitted code, this script fails
// loudly instead of silently shipping the shipped defaults.
//
// Usage: node apply-local-patches.mjs [vendorRoot]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const vendorRoot =
  process.argv[2] ?? path.join(fileURLToPath(new URL("../..", import.meta.url)), "vendor");

function patchFile(relativePath, patches) {
  const file = path.join(vendorRoot, relativePath);
  if (!fs.existsSync(file)) throw new Error(`missing vendored file: ${file}`);
  const original = fs.readFileSync(file, "utf8");
  let text = original;
  for (const { find, replace, label } of patches) {
    // Idempotent: a snapshot that already carries the patch is left alone.
    if (text.includes(replace)) continue;
    if (!text.includes(find)) {
      throw new Error(
        `${relativePath}: anchor not found for "${label}". The shipped code changed; ` +
          "review the new implementation before re-applying this patch.",
      );
    }
    text = text.replace(find, replace);
  }
  if (text === original) {
    console.log(`[patch] ${relativePath} (already patched)`);
    return;
  }
  fs.writeFileSync(file, text, "utf8");
  console.log(`[patch] ${relativePath}`);
}

// --- retry policy: unlimited attempts, fixed three-second cadence -------------
patchFile("@mavis/agent-core/dist/pi-turn-runner/llm-retry.js", [
  {
    label: "default retry policy",
    find: `export const DEFAULT_LLM_RETRY_POLICY = {
    maxRetries: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    maxRetryElapsedMs: 120_000,
};`,
    replace: `export const DEFAULT_LLM_RETRY_POLICY = {
    // Local patch: provider errors retry without a practical limit on a fixed
    // three-second cadence (no backoff, no wall-clock budget). The budget is the
    // largest serialisable integer because the retry-event contract requires a
    // non-negative integer; only user cancellation, model refusals, wrong
    // credentials, exhausted quota and deterministic request rejections stay
    // terminal.
    maxRetries: 2_147_483_647,
    baseDelayMs: 3_000,
    maxDelayMs: 30_000,
    maxRetryElapsedMs: Number.POSITIVE_INFINITY,
};`,
  },
  {
    label: "retry delay",
    find: `    const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retryAttempt - 1));
    return Math.floor(exponential / 2 + (clampRandom(random()) * exponential) / 2);`,
    replace: `    // Local patch: unstable upstreams retry on the fixed \`baseDelayMs\` cadence
    // (no exponential growth, no jitter); a server-directed Retry-After still
    // wins above.
    return policy.baseDelayMs;`,
  },
  {
    label: "retry delay floor",
    find: `        return Math.min(policy.maxDelayMs, Math.max(0, retryAfterMs));`,
    replace: `        // Local patch: never wait less than the fixed cadence. A gateway that
        // answers 'Retry-After: 0' would otherwise turn the retry loop into a
        // busy spin (measured: 291k attempts in 27h at 0-1ms intervals).
        return Math.max(policy.baseDelayMs, Math.min(policy.maxDelayMs, Math.max(0, retryAfterMs)));`,
  },
  {
    label: "retry decision for every provider",
    find: `    const decision = input.retryAllErrors &&
        !normalized.facts.explicitAbort &&
        !normalized.facts.signals.has('refusal') &&
        !isLLMDeterministicRequestRejection(normalized) &&
        !(input.final && isContextOverflow(input.final))
        ? { retryable: true, reason: 'network' }
        : toLLMRetryDecision(normalized);`,
    replace: `    // Local patch: one classification for every provider, not only BYOK. The
    // strict decision keeps its precise transient reason (timeout, network, 429,
    // overload, 5xx, empty response); the failure it used to fail closed on — an
    // upstream fault no signal matched — is retried as well. Task-level outcomes
    // stay terminal: cancellation, a refusal, a wrong credential, an exhausted
    // usage plan or credits, a deterministic rejection and a context overflow.
    const strictDecision = toLLMRetryDecision(normalized);
    const taskLevelTerminal = normalized.facts.explicitAbort ||
        normalized.facts.signals.has('refusal') ||
        ['auth', 'usage_limit', 'credits_exhausted'].includes(toLLMMetricErrorKind(normalized.facts)) ||
        isLLMDeterministicRequestRejection(normalized) ||
        !!(input.final && isContextOverflow(input.final));
    const decision = strictDecision.retryable || taskLevelTerminal
        ? strictDecision
        : { retryable: true, reason: 'network' };`,
  },
  {
    label: "commit boundary without a done shortcut",
    find: `        if (commitsOutput(next.value) || (!retryAllErrors && next.value.type === 'done')) {`,
    replace: `        if (commitsOutput(next.value)) {`,
  },
  {
    // Reasoning deltas are dropped by the caller when an attempt is discarded, so
    // they must not end the retry window. Treating them as committed pushed a
    // failed request into the resume path with an empty prefix (measured as
    // `resume_start chars=0`, after which the model answered with a tool call).
    label: "commit boundary ignores reasoning deltas",
    find: `function commitsOutput(event) {
    if (event.type === 'text_delta' ||
        event.type === 'thinking_delta' ||
        event.type === 'toolcall_delta') {
        return event.delta.length > 0;
    }
    if (event.type === 'text_end' || event.type === 'thinking_end')
        return event.content.length > 0;
    if (event.type === 'toolcall_end')
        return true;
    return 'partial' in event && hasCommittedContent(event.partial);
}
function hasCommittedContent(message) {
    return message.content.some((block) => {
        if (block.type === 'text')
            return block.text.length > 0;
        if (block.type === 'thinking')
            return block.thinking.length > 0;
        return block.type === 'toolCall';
    });
}`,
    replace: `function commitsOutput(event) {
    // Local patch: only answer text and a COMPLETED tool call end the retry
    // window. Reasoning deltas are discarded when an attempt is retried, and a
    // tool call that is still streaming its arguments was never executed — the
    // caller only receives it once the block ends — so counting either as
    // committed pushed a retryable failure into the resume path with an empty
    // prefix (measured: resume_start chars=0, then the model answered with a
    // tool call and the whole call was lost).
    if (event.type === 'text_delta') {
        return event.delta.length > 0;
    }
    if (event.type === 'text_end')
        return event.content.length > 0;
    if (event.type === 'toolcall_end')
        return true;
    return 'partial' in event && hasCommittedContent(event.partial);
}
function hasCommittedContent(message) {
    return message.content.some((block) => block.type === 'text' && block.text.length > 0);
}`,
  },
  {
    label: "retry trace: call start",
    find: `        const callId = input.generateCallId?.() ?? defaultCallId();
        const callIdentity = {};`,
    replace: `        const callId = input.generateCallId?.() ?? defaultCallId();
        __mavisRetryTrace({ event: 'call_start', scope: input.scope, sessionId: input.sessionId, turnId: input.turnId, provider: String(model.provider), model: String(model.id), callId });
        const callIdentity = {};`,
  },
  {
    label: "resume after a post-commit transport failure",
    find: `/** Add framework-owned transport retry to a provider StreamFn. Hosts opt in explicitly. */
export function withLLMRetry(inner, input) {`,
    replace: `function __mavisRetryTrace(event) {
    try {
        const proc = globalThis.process;
        const fs = proc?.getBuiltinModule?.('node:fs');
        if (!fs) return;
        const home = proc?.env?.USERPROFILE || proc?.env?.HOME;
        if (!home) return;
        const dir = home + '/.minimax/v2/observability';
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(dir + '/llm-retry-trace.jsonl', JSON.stringify({ at: new Date().toISOString(), pid: proc?.pid, ...event }) + '\\n');
    }
    catch {
        // Observability must never change provider behaviour.
    }
}
/**
 * Local patch: resume a response that died after part of it had already been
 * handed to the caller. Re-sending the request would duplicate the visible
 * output, so the normal retry path cannot be reused; the only correct
 * continuation is a fresh call told to pick up where the truncated text
 * stopped. Its events are NOT streamed as they arrive (a second start/textStart
 * would collide with the open content block): its text is appended in one delta
 * once it completes, and a tool call aborts the resume because a second tool
 * block cannot be merged into the committed message.
 */
function __mavisResumeStream(input) {
    const { inner, model, context, options, source } = input;
    const signal = options?.signal;
    const delayMs = Number(globalThis.process?.env?.MAVIS_RESUME_DELAY_MS ?? 3000);
    const directive = '（上一段输出因链路中断被截断：请从断点继续，不要重复已经输出的内容，也不要重新解释。）';
    let text = '';
    let sawToolcall = false;
    let finalMessage;
    let started = false;
    let resolveSettled;
    let rejectSettled;
    const settledPromise = new Promise((resolve, reject) => {
        resolveSettled = resolve;
        rejectSettled = reject;
    });
    const abortReason = () => (signal && signal.reason instanceof Error ? signal.reason : new Error('LLM retry cancelled'));
    const wait = (ms) => new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            reject(abortReason());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            if (signal)
                signal.removeEventListener('abort', onAbort);
            reject(abortReason());
        };
        const timer = setTimeout(() => {
            if (signal)
                signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        if (signal)
            signal.addEventListener('abort', onAbort, { once: true });
    });
    const note = (event) => __mavisRetryTrace(event);
    async function resumeOnce(continueFromText) {
        const messages = Array.isArray(context && context.messages) ? context.messages : [];
        const resumeContext = continueFromText
            ? {
                ...(context || {}),
                messages: [
                    ...messages,
                    { role: 'assistant', content: [{ type: 'text', text }] },
                    { role: 'user', content: [{ type: 'text', text: directive }] },
                ],
            }
            // Nothing visible was committed, so there is no break point to
            // continue from: re-issue the original request unchanged (a plain
            // retry, which is what the pre-output path would have done).
            : { ...(context || {}) };
        const attempt = await inner(model, resumeContext, { ...(options || {}), maxRetries: 0 });
        let tail = '';
        const iterable = attempt && typeof attempt[Symbol.asyncIterator] === 'function' ? attempt : undefined;
        if (iterable) for await (const event of iterable) {
            if (!event)
                continue;
            if (event.type === 'text_delta') {
                tail += event.delta || '';
                continue;
            }
            if (event.type === 'text_end')
                continue;
            if (event.type === 'start' || event.type === 'text_start' || event.type === 'done')
                continue;
            if (event.type === 'error')
                throw new Error('resume attempt failed');
            if (typeof event.type === 'string' && event.type.indexOf('toolcall') === 0) {
                sawToolcall = true;
                throw new Error('resume produced a tool call');
            }
        }
        const final = await (attempt && typeof attempt.result === 'function' ? attempt.result() : undefined);
        if (!final || final.stopReason === 'error')
            throw new Error('resume attempt ended in failure');
        if (final.stopReason === 'aborted')
            throw abortReason();
        text = text + tail;
        finalMessage = final;
    }
    const stream = {
        async *[Symbol.asyncIterator]() {
            started = true;
            const iterator = source[Symbol.asyncIterator]();
            let failure;
            for (;;) {
                let next;
                try {
                    next = await iterator.next();
                }
                catch (thrown) {
                    failure = thrown;
                    break;
                }
                if (next.done)
                    break;
                const event = next.value;
                if (event.type === 'text_delta')
                    text += event.delta || '';
                else if (event.type === 'text_end')
                    text = text || String(event.content || '');
                else if (typeof event.type === 'string' && event.type.indexOf('toolcall') === 0)
                    sawToolcall = true;
                yield event;
            }
            if (failure === undefined) {
                let settled;
                try {
                    settled = await source.result();
                }
                catch (thrown) {
                    failure = thrown;
                }
                if (failure === undefined) {
                    if (settled && settled.stopReason === 'error') {
                        failure = new Error(String(settled.errorMessage || 'stream ended in error'));
                    }
                    else {
                        finalMessage = settled;
                        resolveSettled(settled);
                        return;
                    }
                }
            }
            if (sawToolcall) {
                rejectSettled(failure);
                throw failure;
            }
            const baseText = text;
            note({ event: 'resume_start', chars: baseText.length });
            for (let round = 1;; round += 1) {
                const snapshot = text;
                try {
                    if (signal && signal.aborted)
                        throw abortReason();
                    await resumeOnce(text.length > 0);
                    note({ event: 'resume_ok', round, chars: text.length });
                    break;
                }
                catch (error) {
                    if ((signal && signal.aborted) || sawToolcall) {
                        // Surface the provider's original failure, not this
                        // wrapper's internal reason: the caller decides what the
                        // user sees, and "resume produced a tool call" is noise.
                        note({ event: 'resume_stop', round, reason: signal && signal.aborted ? 'aborted' : 'toolcall', detail: String(error && error.message ? error.message : error).slice(0, 200) });
                        rejectSettled(failure);
                        throw failure;
                    }
                    text = snapshot;
                    note({ event: 'resume_retry', round, message: String(error && error.message ? error.message : error).slice(0, 200) });
                    await wait(delayMs);
                }
            }
            const merged = {
                role: 'assistant',
                timestamp: Date.now(),
                ...(finalMessage || {}),
                stopReason: 'stop',
                content: [{ type: 'text', text }],
            };
            const tail = text.slice(baseText.length);
            if (tail.length > 0)
                yield { type: 'text_delta', contentIndex: 0, delta: tail, partial: merged };
            yield { type: 'text_end', contentIndex: 0, content: text, partial: merged };
            yield { type: 'done', reason: 'stop', message: merged };
            resolveSettled(merged);
        },
        result() {
            if (!started) {
                started = true;
                void (async () => {
                    try {
                        for await (const ignored of stream) {
                            void ignored;
                        }
                    }
                    catch (error) {
                        rejectSettled(error);
                    }
                })();
            }
            return settledPromise;
        },
    };
    return stream;
}
/** Add framework-owned transport retry to a provider StreamFn. Hosts opt in explicitly. */
export function withLLMRetry(inner, input) {`,
  },
  {
    label: "resume wiring at the commit boundary",
    find: `        if (commitsOutput(next.value)) {
            return {
                kind: 'committed',
                stream: observeRequestSettlement(replayStream(stream, iterator, buffered), requestAttempt, onRequestSettled, options?.signal),
            };
        }`,
    replace: `        if (commitsOutput(next.value)) {
            return {
                kind: 'committed',
                stream: __mavisResumeStream({
                    inner,
                    model,
                    context,
                    options,
                    source: observeRequestSettlement(replayStream(stream, iterator, buffered), requestAttempt, onRequestSettled, options?.signal),
                }),
            };
        }`,
  },
  {
    label: "retry trace: attempt result",
    find: `            callState.requestAttempts = requestAttempt;
            if (preflight.kind === 'committed') {`,
    replace: `            callState.requestAttempts = requestAttempt;
            __mavisRetryTrace({
                event: 'attempt_result',
                scope: input.scope,
                provider: String(model.provider),
                callId,
                attempt: requestAttempt,
                kind: preflight.kind,
                reason: preflight.kind === 'committed' ? undefined : preflight.failure?.error?.reason,
                buffered: preflight.kind === 'committed' ? 0 : (preflight.failure?.buffered?.length ?? 0),
                message: String((preflight.kind === 'committed' ? '' : preflight.failure?.error?.message) ?? '').slice(0, 200),
            });
            if (preflight.kind === 'committed') {`,
  },
]);

// --- classifier: a dropped body / 5xx is upstream instability, not a rejection
patchFile("@mavis/shared/dist/llm-error-classifier.js", [
  {
    label: "network code set",
    find: `    'ERR_HTTP2_PROTOCOL_ERROR',`,
    replace: `    'ERR_HTTP2_PROTOCOL_ERROR',
    // Local patch: HTTP/3 failed below the request layer (a proxy, VPN or
    // middlebox mangling QUIC); the resend normally renegotiates over TCP.
    'ERR_QUIC_PROTOCOL_ERROR',
    // Local patch: a response body that ends early is the classic flaky-upstream
    // shape (the server or an intermediary dropped the connection mid-stream).
    'ERR_INCOMPLETE_CHUNKED_ENCODING',
    'ERR_EMPTY_RESPONSE',`,
  },
  {
    label: "chromium network message pattern",
    find: `HTTP2_PROTOCOL_ERROR|SSL_BAD_RECORD_MAC_ALERT)`,
    replace: `HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR|INCOMPLETE_CHUNKED_ENCODING|EMPTY_RESPONSE|SSL_BAD_RECORD_MAC_ALERT)`,
  },
  {
    label: "retry decision tail",
    find: `    if (status === 529)
        return { retryable: true, reason: 'overloaded' };
    return { retryable: false, reason: metricKind };`,
    replace: `    if (status === 529)
        return { retryable: true, reason: 'overloaded' };
    // Local patch: any remaining server-side failure (5xx) and an empty provider
    // response are upstream instability, not a rejected request: retry them.
    if (status !== undefined && status >= 500)
        return { retryable: true, reason: 'server_error' };
    if (facts.signals.has('empty_response'))
        return { retryable: true, reason: 'empty_response' };
    return { retryable: false, reason: metricKind };`,
  },
]);

// --- renderer string table: show the retry budget as 10000000 ------------
// The prebuilt renderer prints `({{attempt}}/{{total}})`, which would read
// "(3/2147483647)". The templates are plain strings in the exported bundle, so
// they are rewritten rather than the surrounding logic. The retry policy stays
// unbounded; `10000000` is only a nominal display cap so the counter shows a
// finite number. Re-vendoring ships `{{total}}`, an older patched tree may still
// carry `∞`, and a converged tree carries the number; all three input forms are
// accepted so re-running the patch is idempotent.
function patchRendererRetryBudget(outputRoot) {
  const chunksDir = path.join(outputRoot, "_next", "static", "chunks");
  if (!fs.existsSync(chunksDir)) throw new Error(`missing renderer chunks: ${chunksDir}`);
  let replaced = 0;
  let alreadyPatched = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(target);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const text = fs.readFileSync(target, "utf8");
      if (!text.includes("{{attempt}}/")) continue;
      alreadyPatched += (text.match(/\{\{attempt\}\}\/10000000/gu) ?? []).length;
      const next = text
        .replaceAll("({{attempt}}/{{total}})", "({{attempt}}/10000000)")
        .replaceAll("（{{attempt}}/{{total}}）", "（{{attempt}}/10000000）")
        .replaceAll("({{attempt}}/∞)", "({{attempt}}/10000000)")
        .replaceAll("（{{attempt}}/∞）", "（{{attempt}}/10000000）");
      if (next !== text) {
        fs.writeFileSync(target, next, "utf8");
        replaced += 1;
      }
    }
  };
  walk(chunksDir);
  if (replaced === 0 && alreadyPatched === 0) {
    throw new Error(
      "renderer retry templates not found; the shipped bundle changed its retry copy",
    );
  }
  console.log(`[patch] renderer retry budget: ${replaced} chunk(s) rewritten`);
}

patchRendererRetryBudget(path.join(vendorRoot, "..", "out"));

console.log("[patch] local behavioural patches applied");
