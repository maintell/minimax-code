export async function applyRespDataTransform(transform, respData, ctx, logger) {
    if (!transform)
        return respData;
    try {
        return await transform(respData, ctx);
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger?.warn?.({ session_id: ctx.sessionId, turn_id: ctx.turnId, error: reason }, 'respDataTransform failed; using original RespData');
        return respData;
    }
}
//# sourceMappingURL=resp-data.js.map