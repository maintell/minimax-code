import { resolveModelCallRoute } from '@mavis/config';
import { streamSimple } from '@earendil-works/pi-ai';
import { parseSourceQualifiedModelKey, } from '../../model-system/index.js';
import { buildLocalTurnPayloadTransform, } from '../../turn-system/index.js';
const RECOMMENDATION_TURN_ID = 'session-handoff-file-recommendation';
const MAX_OUTPUT_TOKENS = 1_024;
const REQUEST_TIMEOUT_MS = 15_000;
const SYSTEM_PROMPT = [
    'You choose which Workspace files a Desktop Session should upload when its work moves to Cloud.',
    'You receive the request that asked for the handoff, recent Session context, and a catalog of',
    'candidate paths with sizes. You never see file contents.',
    '',
    'Select the files the Cloud Session needs to continue this specific request: the artifacts the',
    'request names or implies, their direct inputs, and the project files needed to keep working on',
    'them. Prefer a slightly wider selection over a minimal one, but do not select the whole',
    'Workspace: leave out unrelated files, build output, caches, and dependencies.',
    '',
    'Answer with JSON only, no prose and no code fences:',
    '{"files":[{"path":"<catalog path>","reason":"<short reason>"}]}',
    'Copy paths exactly as given. Never invent a path. Use an empty array when nothing fits.',
].join('\n');
/**
 * Resolves one fresh model request through the same Agent/model preparation as worker Turns.
 * Throwing is the port's way of reporting "unavailable"; the handoff service then falls back to
 * its tool-evidence floor instead of proposing the whole Workspace.
 */
export function createHandoffRecommendationModelPort(options) {
    return {
        async selectFiles(request) {
            const final = await runHandoffModelTurn(options, {
                session: request.session,
                turnId: RECOMMENDATION_TURN_ID,
                systemPrompt: SYSTEM_PROMPT,
                userPrompt: buildUserPrompt(request),
                maxTokens: MAX_OUTPUT_TOKENS,
                signal: request.signal,
            });
            return parseSelection(final);
        },
    };
}
/**
 * 跑一次一次性的模型调用,走的是 worker Turn 同一套 Agent/模型准备。派发相关的模型
 * 端口(文件推荐、历史摘要)共用它 —— 尤其是模型选路那段:小快模型只在与本会话
 * worker 模型同一上游时才用,否则会把会话内容送到第二条 provider 路由上去。
 */
export async function runHandoffModelTurn(options, request) {
    const config = options.config();
    const agent = await sessionAgentSnapshot(options.agents, request.session);
    if (!agent)
        throw new Error(`Handoff model Agent not found: ${request.session.agentName}`);
    const agentConfig = await options.preparation.buildAgentConfig({
        session: request.session,
        agent,
        ...recommendationModelOverride(config, request.session),
        isSessionFirstTurn: false,
    });
    const llm = await options.preparation.resolveModel({
        sessionId: request.session.sessionId,
        turnId: request.turnId,
        agentConfig,
    });
    const response = await (llm.streamFn ?? streamSimple)(llm.model, {
        systemPrompt: request.systemPrompt,
        messages: [
            {
                role: 'user',
                content: request.userPrompt,
                timestamp: (options.nowMs ?? Date.now)(),
            },
        ],
        tools: [],
    }, {
        ...(llm.apiKey ? { apiKey: llm.apiKey } : {}),
        ...(llm.headers ? { headers: { ...llm.headers } } : {}),
        maxTokens: request.maxTokens,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxRetries: 0,
        signal: request.signal,
        onPayload: buildLocalTurnPayloadTransform({ ...agentConfig }, {
            thinkingLevel: 'off',
            ...(llm.thinkingRequestPatch ? { thinkingRequestPatch: llm.thinkingRequestPatch } : {}),
            signal: request.signal,
        }),
    });
    const final = await response.result();
    // pi-ai 把上游失败与中断都当作正常 resolve,只在 stopReason 上体现,并且可能带着
    // 半截文本。推荐端口靠 JSON 解析会自然拒绝,但摘要端口只看文本非空 —— 不在这里
    // 抛错,一次上游错误就会被当成摘要写进云端首条消息。派发的两个模型步骤都是可选的,
    // 拿不到可用答案时各自退回确定性兜底才是对的。
    if (final.stopReason === 'error' || final.stopReason === 'aborted') {
        throw new Error(`handoff model turn ${final.stopReason}: ${final.errorMessage ?? 'no error message'}`);
    }
    return final;
}
/**
 * Prefers the small-fast model, but only when it is billed and routed through the same upstream
 * as this Session's worker model. Otherwise the Session's own model answers, so a handoff never
 * silently ships Workspace paths and Session context to a second provider route.
 */
function recommendationModelOverride(config, session) {
    const light = parseSourceQualifiedModelKey(config.defaultLightModel);
    const worker = parseSourceQualifiedModelKey(session.effectiveModel ?? config.defaultModel);
    if (!light || !worker)
        return {};
    if (!sameDataRoute(config, worker.providerId, light.providerId))
        return {};
    return { model: { provider_id: light.providerId, model_id: light.modelId, thinking: {} } };
}
function sameDataRoute(config, workerProviderId, candidateProviderId) {
    const worker = resolveModelCallRoute(config, workerProviderId);
    const candidate = resolveModelCallRoute(config, candidateProviderId);
    if (worker !== candidate)
        return false;
    return providerScopedRoute(worker) ? workerProviderId === candidateProviderId : true;
}
function providerScopedRoute(route) {
    return route === 'custom_provider' || route === 'configured_provider';
}
function sessionAgentSnapshot(agents, session) {
    return session.appMode
        ? agents.getExecutionSnapshot(session.agentName, { appMode: session.appMode })
        : agents.getExecutionSnapshot(session.agentName);
}
function buildUserPrompt(request) {
    const sections = [`Request:\n${request.userQuery}`];
    if (request.recentContext.length > 0) {
        sections.push(`Recent Session context:\n${request.recentContext.join('\n')}`);
    }
    sections.push(`Candidate files (${request.candidates.length}):\n${request.candidates
        .map((candidate) => `${candidate.relativePath}\t${candidate.sizeBytes}B`)
        .join('\n')}`);
    return sections.join('\n\n');
}
/** Reads the model answer. Anything unparseable throws so the service can fall back. */
function parseSelection(final) {
    const text = final.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
        .trim();
    const parsed = parseJsonObject(text);
    const files = parsed?.files;
    if (!Array.isArray(files)) {
        throw new Error('Handoff recommendation model did not answer with a file list.');
    }
    const selection = files.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null)
            return [];
        const record = entry;
        if (typeof record.path !== 'string')
            return [];
        return [
            {
                relativePath: record.path,
                ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
            },
        ];
    });
    // An empty answer is a real "nothing to add"; an answer nothing survives is malformed output.
    if (files.length > 0 && selection.length === 0) {
        throw new Error('Handoff recommendation model answered with no usable file entry.');
    }
    return selection;
}
function parseJsonObject(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start)
        return undefined;
    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=recommendation-model.js.map