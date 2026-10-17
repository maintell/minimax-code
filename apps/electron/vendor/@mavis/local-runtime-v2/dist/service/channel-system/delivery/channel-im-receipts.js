import { LocalChannelRootlessError } from '../routing/rootless-route-resolver.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { isChineseLocale, resolveLocalRuntimeLocale } from './receipt-locale.js';
// ── Route-broken IM receipts (product decision 2026-09-04) ──────────────────
//
// Human-readable copy sent back to the IM user when the Channel route can no
// longer be resolved (bound Agent deleted / binding stale / session invalid).
// Historical route codes preserve their platform language convention. V2 IM
// Connection receipts use the Desktop runtime locale so all transports match
// the product language. Copy is aligned with archon_server's im-guard flow.
const channelRouteAgentGoneZH = '你绑定的 Agent 已被删除或绑定已失效，无法继续对话。请在 App 中重新绑定后再试。';
const channelRouteAgentGoneEN = 'The Agent bound to this chat has been deleted or the binding is stale. Please rebind it in the App and try again.';
const channelRouteSessionGoneZH = '当前绑定的会话已失效。请在 App 中重新绑定后再试。';
const channelRouteSessionGoneEN = 'The bound conversation is no longer valid. Please rebind it in the App and try again.';
const channelRouteGenericZH = '渠道消息处理失败，请稍后再试，或在 App 中检查绑定。';
const channelRouteGenericEN = 'The channel message could not be processed. Please retry later or check the binding in the App.';
const channelImSessionDeletedZH = '当前绑定的会话已删除，请发送 /new 创建新会话后继续。';
const channelImSessionDeletedEN = 'This conversation has been deleted. Send /new to start a new conversation and continue.';
const channelImNewCreatedZH = '已创建新会话，请继续发送消息。';
const channelImNewCreatedEN = 'A new conversation has been created. Send a message to continue.';
const channelModelUnavailableZH = '当前选择的模型不可用，本次消息未执行。请在客户端修改 Agent 的模型或全局默认模型后重试。';
const channelModelUnavailableEN = 'This message was not executed because the selected model is unavailable. Update the Agent model or runtime default model in the App and try again.';
const channelRuntimeDefaultUnconfiguredZH = 'Agent 当前使用 AUTO，全局默认模型未配置或配置无效，本次消息未执行。请修改全局默认模型后重试。';
const channelRuntimeDefaultUnconfiguredEN = 'This Agent uses AUTO, but the runtime default model is not configured or is invalid. This message was not executed. Update the runtime default model in the App and try again.';
const LEGACY_AGENT_GONE_CODES = new Set([
    'CHANNEL_BINDING_STALE',
    'CHANNEL_BINDING_NOT_FOUND',
    'CHANNEL_BINDING_AMBIGUOUS',
    'CHANNEL_ROUTE_OWNER_STALE',
    'CHANNEL_BINDING_OWNER_CHANGE_REQUIRES_REBIND',
    'CHANNEL_BINDING_PROFILE_DIVERGED',
]);
/** Maps a LocalChannelRootlessError code to the localized receipt text. */
export function channelRouteBrokenReceiptText(platform, code) {
    const chineseLocale = isChineseLocale(resolveLocalRuntimeLocale());
    // V2 Connection receipt codes follow the Desktop runtime locale …
    if (code === 'CHANNEL_IM_AGENT_UNAVAILABLE') {
        return chineseLocale ? channelRouteAgentGoneZH : channelRouteAgentGoneEN;
    }
    if (code === 'CHANNEL_IM_SESSION_DELETED') {
        return chineseLocale ? channelImSessionDeletedZH : channelImSessionDeletedEN;
    }
    // … while historical route codes keep the platform language convention.
    const en = platform === 'telegram';
    if (LEGACY_AGENT_GONE_CODES.has(code)) {
        return en ? channelRouteAgentGoneEN : channelRouteAgentGoneZH;
    }
    if (code === 'CHANNEL_SESSION_VALIDATION_FAILED') {
        return en ? channelRouteSessionGoneEN : channelRouteSessionGoneZH;
    }
    return en ? channelRouteGenericEN : channelRouteGenericZH;
}
export function channelImNewCreatedReceiptText() {
    return isChineseLocale(resolveLocalRuntimeLocale())
        ? channelImNewCreatedZH
        : channelImNewCreatedEN;
}
export function channelModelInvalidReceiptText(input) {
    const chineseLocale = isChineseLocale(resolveLocalRuntimeLocale());
    const modelName = input.model?.modelId;
    if (input.modelSource === 'agent') {
        return agentModelInvalidText(chineseLocale, input.agentName, modelName);
    }
    if (input.modelSource === 'runtime-default') {
        return runtimeDefaultModelInvalidText(chineseLocale, modelName);
    }
    return chineseLocale ? channelModelUnavailableZH : channelModelUnavailableEN;
}
function agentModelInvalidText(chineseLocale, agentName, modelName) {
    if (chineseLocale) {
        return `Agent「${agentName}」配置的模型${modelName ? `「${modelName}」` : ''}当前不可用，本次消息未执行。请在客户端修改该 Agent 的模型后重试。`;
    }
    return `The model${modelName ? ` ${modelName}` : ''} configured for Agent ${agentName} is unavailable. This message was not executed. Update the Agent model in the App and try again.`;
}
function runtimeDefaultModelInvalidText(chineseLocale, modelName) {
    if (!modelName) {
        return chineseLocale
            ? channelRuntimeDefaultUnconfiguredZH
            : channelRuntimeDefaultUnconfiguredEN;
    }
    if (chineseLocale) {
        return `Agent 当前使用 AUTO，全局默认模型${modelName ? `「${modelName}」` : ''}不可用，本次消息未执行。请修改全局默认模型后重试。`;
    }
    return `This Agent uses AUTO and the runtime default model${modelName ? ` ${modelName}` : ''} is unavailable. This message was not executed. Update the runtime default model in the App and try again.`;
}
export function imReceiptFromRouteError(error, stage, requestKey) {
    if (!error.imRoute)
        return undefined;
    return {
        requestKey,
        code: error.code,
        stage,
        imRoute: error.imRoute,
        ...(error.imRoute.sessionId ? { sessionId: error.imRoute.sessionId } : {}),
    };
}
export function imReceiptForRoute(route, code, stage, requestKey) {
    if (!route.imRoute)
        return undefined;
    return {
        requestKey,
        code,
        stage,
        imRoute: route.imRoute,
        ...(route.sessionId ? { sessionId: route.sessionId } : {}),
    };
}
export function logImReceipt(event) {
    const { ctx, receipt, outcome, message, details } = event;
    logger.warn({
        requestKey: receipt.requestKey,
        platform: ctx.platform,
        source: `channel:${ctx.platform}`,
        connectionId: receipt.imRoute.connectionId,
        bindingId: receipt.imRoute.bindingId,
        ...(receipt.imRoute.imConversationId
            ? { imConversationId: receipt.imRoute.imConversationId }
            : {}),
        ...(receipt.sessionId ? { sessionId: receipt.sessionId } : {}),
        stage: receipt.stage,
        code: receipt.code,
        ...(details?.errorCode ? { errorCode: details.errorCode } : {}),
        outcome,
    }, message);
}
export function isMissingEnqueueSessionError(error) {
    if (typeof error !== 'object' || error === null)
        return false;
    const candidate = error;
    return candidate.reason === 'session-not-found' || candidate.code === 'SESSION_NOT_FOUND';
}
/**
 * Only the Queue service's explicit model rejection is safe to turn into a
 * user-facing receipt. Other failures continue through their existing error path.
 */
function isModelInvalidEnqueueError(error) {
    if (typeof error !== 'object' || error === null)
        return false;
    const candidate = error;
    return candidate.name === 'QueueServiceError' && candidate.reason === 'model-invalid';
}
/**
 * Only known Agent identity failures can be turned into the existing rebind
 * receipt. In particular, do not treat arbitrary queue or programming errors
 * as an unavailable Agent.
 */
function isChannelAgentUnavailableEnqueueError(error) {
    if (typeof error !== 'object' || error === null)
        return false;
    const candidate = error;
    if (candidate.name === 'ChannelAgentIdentityError' &&
        candidate.code === 'AGENT_CONFIG_INSTANCE_CONFLICT') {
        return true;
    }
    return (candidate.name === 'AgentServiceError' &&
        (candidate.code === 'AGENT_NOT_FOUND' || candidate.code === 'AGENT_CONFIG_NOT_FOUND'));
}
/**
 * Maps only known pre-admission queue rejections to their shared IM receipt.
 * The caller retains route/result assembly while this module owns error
 * classification, localized text, and safe receipt-generation diagnostics.
 */
function resolveChannelEnqueueRejectionReceipt(input) {
    if (isChannelAgentUnavailableEnqueueError(input.error)) {
        const code = 'CHANNEL_IM_AGENT_UNAVAILABLE';
        const errorCode = input.error.code;
        const imReceipt = imReceiptForRoute(input.route, code, 'enqueue', input.requestKey);
        if (imReceipt) {
            logImReceipt({
                ctx: input.ctx,
                receipt: imReceipt,
                outcome: 'receipt_generated',
                message: '[im-guard] Agent identity changed before enqueue; generated receipt',
                details: { errorCode },
            });
        }
        else {
            logger.warn({
                requestKey: input.requestKey,
                platform: input.ctx.platform,
                source: `channel:${input.ctx.platform}`,
                sessionId: input.route.sessionId,
                agentName: input.route.agentName,
                code,
                errorCode,
                outcome: 'receipt_generated',
            }, '[im-guard] Agent identity changed before enqueue; generated receipt');
        }
        return {
            reply: channelRouteBrokenReceiptText(input.ctx.platform, code),
            ...(imReceipt ? { imReceipt } : {}),
        };
    }
    if (!isModelInvalidEnqueueError(input.error))
        return undefined;
    const code = input.error.code ?? 'model-invalid';
    const imReceipt = imReceiptForRoute(input.route, code, 'enqueue', input.requestKey);
    if (imReceipt) {
        logImReceipt({
            ctx: input.ctx,
            receipt: imReceipt,
            outcome: 'receipt_generated',
            message: '[im-guard] model selection rejected before enqueue; generated receipt',
        });
    }
    else {
        logger.warn({
            requestKey: input.requestKey,
            platform: input.ctx.platform,
            source: `channel:${input.ctx.platform}`,
            sessionId: input.route.sessionId,
            agentName: input.route.agentName,
            code,
            ...(input.error.modelSource ? { modelSource: input.error.modelSource } : {}),
            ...(input.error.model
                ? {
                    modelProviderId: input.error.model.providerId,
                    modelId: input.error.model.modelId,
                }
                : {}),
            outcome: 'receipt_generated',
        }, '[im-guard] model selection rejected before enqueue; generated receipt');
    }
    return {
        reply: channelModelInvalidReceiptText({
            agentName: input.route.agentName,
            model: input.error.model,
            modelSource: input.error.modelSource,
        }),
        ...(imReceipt ? { imReceipt } : {}),
    };
}
/** Builds the existing inbound result for a mapped pre-admission rejection. */
export function resolveChannelEnqueueRejectionInboundResult(input) {
    if (input.error instanceof LocalChannelRootlessError &&
        (input.error.code === 'CHANNEL_IM_AGENT_UNAVAILABLE' ||
            input.error.code === 'CHANNEL_IM_SESSION_DELETED')) {
        const imReceipt = imReceiptFromRouteError(input.error, 'enqueue', input.requestKey);
        if (!imReceipt)
            return undefined;
        logImReceipt({
            ctx: input.ctx,
            receipt: imReceipt,
            outcome: 'receipt_generated',
            message: '[im-guard] IM route changed before enqueue; generated receipt',
        });
        return keepImReceiptInternal({
            handled: true,
            reply: channelRouteBrokenReceiptText(input.ctx.platform, imReceipt.code),
            route: input.route,
            sessionId: input.route.sessionId,
            imReceipt,
            lane: input.lane,
        });
    }
    const rejection = resolveChannelEnqueueRejectionReceipt(input);
    if (!rejection)
        return undefined;
    return keepImReceiptInternal({
        handled: true,
        reply: rejection.reply,
        route: input.route,
        sessionId: input.route.sessionId,
        ...(rejection.imReceipt ? { imReceipt: rejection.imReceipt } : {}),
        lane: input.lane,
    });
}
/** Keep delivery-only receipt metadata out of adapter HTTP response JSON. */
export function keepImReceiptInternal(result) {
    if (result.imReceipt) {
        Object.defineProperty(result, 'imReceipt', {
            value: result.imReceipt,
            enumerable: false,
            configurable: true,
        });
    }
    return result;
}
//# sourceMappingURL=channel-im-receipts.js.map