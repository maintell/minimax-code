import { encodeSegment, mapRequestCompactionResp } from './desktop-session-mappers.js';
export async function requestLocalSessionCompaction(localApiJson, req) {
    const body = await localApiJson(`agent/${encodeSegment(req.name)}/session/${encodeSegment(req.id)}/request-compaction`, {
        method: 'POST',
        body: {
            reason: req.reason,
            customInstructions: req.customInstructions,
            custom_instructions: req.customInstructions,
        },
    });
    return mapRequestCompactionResp(body);
}
//# sourceMappingURL=desktop-session-agent-actions.js.map