// Default AIGCInfo constructors + GB 45438-2025 compliance constants.
//
// Constants here are the SINGLE SOURCE OF TRUTH for Mavis cloud's
// AIGC provenance. Do not introduce service-specific producer names
// (e.g. "cloud-runtime", "matrix-tools") — the producer/propagator
// identity is locked to the brand-correct "MiniMax AI" string,
// kept in lockstep with mcp-server (Python + Go) so SM2 signatures
// computed by any of the three implementations verify identically.
//
// newProducerAigcInfo() builds the "fresh upload" AIGCInfo:
//   - Label = "1" (GB-compliant AI-generated marker)
//   - ContentProducer / ContentPropagator = DefaultContentActor
//   - ProduceID / PropagateID = `user:<id>/node:<id-or-turn>/ts:<ms>`
//   - ReservedCode1 / ReservedCode2 = "" (sm2.ts populates later)
//
// The downloader-stamp helper (withDownloaderPropagator) lives in
// archon-server's Go layer; this package never re-signs propagator
// because it only ever runs on the producer side.
/**
 * Producer / propagator identity used by Mavis cloud — locked at
 * "MiniMax AI" (brand-correct spelling). Kept in lockstep with
 * mcp-server Python + Go so the three implementations sign the same
 * canonical bytes.
 */
export const DefaultContentActor = 'MiniMax AI';
/**
 * GB 45438-2025 §3.2.2 fixed Label value for AI-generated content.
 * Every AIGCInfo built by this module carries Label = "1".
 */
export const LabelAIGenerated = '1';
/**
 * Build an AIGCInfo for the producer side of a freshly generated AI
 * asset.
 *
 * @param userId — owning user numeric id. Falsy values become 0 in the
 *   formatted ProduceID (matches storage-gateway behaviour for
 *   anonymous uploads).
 * @param nodeIdOrTurnId — node id (when the caller knows the long-term
 *   node id) or turn id (when called from tool runtime where only the
 *   turn is known). Used verbatim in ProduceID — caller pre-sanitises.
 * @returns AIGCInfo with ReservedCode1 / ReservedCode2 left empty —
 *   call signAigcProducer / signAigcPropagator (sm2.ts) afterwards to
 *   populate them.
 *
 * Format: `user:<userId>/node:<nodeIdOrTurnId>/ts:<unix-ms>`
 *
 * Same string is used for ProduceID and PropagateID at producer time;
 * propagator id is rewritten at download time by archon-server.
 */
export function newProducerAigcInfo(userId, nodeIdOrTurnId) {
    const ts = Date.now();
    const userPart = typeof userId === 'bigint' ? userId.toString() : String(userId);
    const produceID = `user:${userPart}/node:${nodeIdOrTurnId}/ts:${ts}`;
    return {
        Label: LabelAIGenerated,
        ContentProducer: DefaultContentActor,
        ProduceID: produceID,
        ReservedCode1: '',
        ContentPropagator: DefaultContentActor,
        PropagateID: produceID,
        ReservedCode2: '',
    };
}
//# sourceMappingURL=default.js.map