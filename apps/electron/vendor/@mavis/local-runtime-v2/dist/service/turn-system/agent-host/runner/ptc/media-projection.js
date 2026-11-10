import { multimodalDemotionTextNotes, selectMultimodalAttachments, } from '@mavis/agent-tools';
/** Applies the same provider capability limits used for native user attachments. */
export function projectPtcOuterMedia(media, capabilities) {
    const candidates = media.flatMap((delivery, index) => {
        const content = delivery.content;
        if ((content.type !== 'image' && content.type !== 'video') ||
            typeof content.data !== 'string' ||
            typeof content.mimeType !== 'string') {
            return [];
        }
        return [
            {
                id: String(index),
                mime: content.mimeType,
                sizeBytes: base64ByteSize(content.data),
                delivery,
            },
        ];
    });
    const selected = selectMultimodalAttachments(candidates, capabilities);
    const statusByChild = new Map();
    for (const item of selected.kept) {
        recordStatus(statusByChild, item.candidate.delivery, 'delivered');
    }
    for (const item of selected.demoted) {
        recordStatus(statusByChild, item.candidate.delivery, item.reason === 'unsupported_model' || item.reason === 'unsupported_mime'
            ? 'unavailable'
            : 'budget_exceeded');
    }
    return {
        content: selected.kept.map((item) => item.candidate.delivery.content),
        retainedFacts: [...statusByChild].map(([childToolCallId, state]) => ({
            kind: 'media_delivery',
            child_tool_call_id: childToolCallId,
            status: state.status,
            ...(state.refs.length > 0 ? { refs: state.refs } : {}),
        })),
        notes: multimodalDemotionTextNotes(selected.demoted),
    };
}
function recordStatus(states, delivery, next) {
    const existing = states.get(delivery.childToolCallId);
    const status = worseMediaStatus(existing?.status, next);
    const refs = [...(existing?.refs ?? [])];
    for (const ref of delivery.refs) {
        if (!refs.some((known) => known.uri === ref.uri))
            refs.push(ref);
    }
    states.set(delivery.childToolCallId, { status, refs });
}
function worseMediaStatus(first, second) {
    if (first === 'budget_exceeded' || second === 'budget_exceeded')
        return 'budget_exceeded';
    if (first === 'unavailable' || second === 'unavailable')
        return 'unavailable';
    return 'delivered';
}
function base64ByteSize(value) {
    let padding = 0;
    if (value.endsWith('=='))
        padding = 2;
    else if (value.endsWith('='))
        padding = 1;
    return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}
//# sourceMappingURL=media-projection.js.map