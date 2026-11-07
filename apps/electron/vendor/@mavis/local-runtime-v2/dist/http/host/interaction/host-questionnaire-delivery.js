export async function deliverQuestionnaireAskToChannel(host, record) {
    try {
        if (!record.originChannelContext) {
            return;
        }
        const ctx = record.originChannelContext;
        // raised = the ask targeted an IM channel; delivered = message sent.
        host.metrics?.incr('channel_ask_user_total', { channel: ctx.platform, phase: 'raised' });
        const outcome = await host.sendQuestionnaireMessage({
            ctx,
            text: record.request.title ?? record.request.steps[0]?.question ?? '',
            questionnaire: record.request,
            sessionId: record.sessionId,
        });
        if (outcome !== 'sent')
            return;
        host.metrics?.incr('channel_ask_user_total', { channel: ctx.platform, phase: 'delivered' });
    }
    catch (err) {
        host.emitBusEvent('questionnaire.delivery_failed', {
            requestId: record.requestId,
            sessionId: record.sessionId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
//# sourceMappingURL=host-questionnaire-delivery.js.map