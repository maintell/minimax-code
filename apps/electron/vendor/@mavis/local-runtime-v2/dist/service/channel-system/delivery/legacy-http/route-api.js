/**
 * Legacy `/channel-route/*` HTTP dispatcher.
 *
 * MR3 port of the HTTP half of v1 `channels/route-api.ts` (the service half
 * — `LocalChannelRouteStore` and the `read*` body readers — was migrated to
 * `routing/route-rules.ts` in MR1). Response shapes, messages and status
 * codes are kept byte-for-byte with the v1 dispatcher; the only structural
 * change is that store-level errors arrive as `ChannelRouteApiError` values
 * instead of embedded `Response` objects and are serialized here.
 */
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { LocalChannelRouteStore, isChannelPlatform, isValidRuleId, readCreateRule, readPreviewContext, readRuleUpdate, } from '../../routing/route-rules.js';
import { json, notFound, readJsonBody } from './http-helpers.js';
/** Serializes a structured store error into the exact legacy JSON body. */
function routeApiError(error) {
    return json({ error: error.error, errorCode: error.errorCode }, { status: error.status });
}
export async function routeLocalChannelRouteApi(input) {
    const store = await LocalChannelRouteStore.load(input.dataDir, input.defaultAgentName, input.nowMs);
    const tail = input.parts.slice(1);
    if (input.method === 'GET' && tail.join('/') === 'status') {
        return json({
            bridges: {
                feishu: { enabled: false },
                telegram: { enabled: false },
                wechat: { enabled: false },
            },
            defaults: store.getDefaults(),
            ruleCount: store.getRules().length,
        });
    }
    if (input.method === 'GET' && tail.join('/') === 'rules') {
        const platform = input.url.searchParams.get('platform');
        if (platform && !isChannelPlatform(platform)) {
            return json({ error: `Invalid platform: "${platform}"`, errorCode: 'INVALID_PLATFORM' }, { status: 400 });
        }
        const rules = store.getRules(platform ?? undefined);
        return json({ rules, count: rules.length });
    }
    if (tail[0] === 'rules' && tail[1]) {
        const ruleId = tail[1];
        if (!isValidRuleId(ruleId)) {
            return json({ error: 'Invalid rule ID', errorCode: 'INVALID_RULE_ID' }, { status: 400 });
        }
        if (input.method === 'GET' && tail.length === 2) {
            const rule = store.getRule(ruleId);
            if (!rule) {
                return json({ error: `Route rule "${ruleId}" not found`, errorCode: 'RULE_NOT_FOUND' }, { status: 404 });
            }
            return json({ rule });
        }
        if (input.method === 'PUT' && tail.length === 2) {
            const body = await readJsonBody(input.request);
            const update = readRuleUpdate(body);
            const result = await store.updateRule(ruleId, update);
            if ('error' in result)
                return routeApiError(result.error);
            logger.info({ ruleId, stage: 'channel_route_api' }, 'Channel route rule updated');
            return json({ rule: result.rule });
        }
        if (input.method === 'DELETE' && tail.length === 2) {
            const deleted = await store.deleteRule(ruleId);
            if (!deleted) {
                return json({ error: `Route rule "${ruleId}" not found`, errorCode: 'RULE_NOT_FOUND' }, { status: 404 });
            }
            logger.info({ ruleId, stage: 'channel_route_api' }, 'Channel route rule deleted');
            return json({ success: true });
        }
    }
    if (input.method === 'POST' && tail.join('/') === 'rules') {
        const body = await readJsonBody(input.request);
        const parsed = readCreateRule(body, input.nowMs());
        if ('error' in parsed)
            return routeApiError(parsed.error);
        const result = await store.addRule(parsed.rule);
        if ('error' in result)
            return routeApiError(result.error);
        logger.info({ ruleId: result.rule.id, platform: result.rule.platform, stage: 'channel_route_api' }, 'Channel route rule created');
        return json({ rule: result.rule }, { status: 201 });
    }
    if (input.method === 'GET' && tail.join('/') === 'defaults') {
        return json({ defaults: store.getDefaults() });
    }
    if (input.method === 'PUT' && tail.join('/') === 'defaults') {
        const body = await readJsonBody(input.request);
        const result = await store.updateDefaults(body);
        if ('error' in result)
            return routeApiError(result.error);
        logger.info({ stage: 'channel_route_api' }, 'Channel route defaults updated');
        return json({ defaults: result.defaults });
    }
    if (input.method === 'POST' && tail.join('/') === 'resolve') {
        const body = await readJsonBody(input.request);
        const ctx = readPreviewContext(body);
        if ('error' in ctx)
            return routeApiError(ctx.error);
        const preview = store.resolvePreview(ctx.ctx);
        return json({
            result: {
                ruleId: preview.ruleId,
                agentId: preview.agentId,
                sessionStrategy: preview.sessionStrategy,
                sessionTitle: preview.sessionTitle,
                blocked: preview.blocked,
            },
        });
    }
    return notFound(`/channel-route/${tail.join('/')}`);
}
//# sourceMappingURL=route-api.js.map