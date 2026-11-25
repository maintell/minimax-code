// AIGC metainfo types — 7-field AIGCInfo per GB 45438-2025 §3.2.2.
//
// Field ordering matches mcp-server (Python) schema.py + storage-gateway
// (Go) AIGCInfo struct EXACTLY. Field order is load-bearing because the
// SM2 signature in sm2.ts canonicalises this object via JSON.stringify
// with sort_keys; field NAMES (not declaration order) drive the sort, so
// any name typo here permanently desynchronises signatures from
// mcp-server and storage-gateway.
//
// Two JSON shapes consumed by the per-mime injectors:
//   - Flat:   `{...AIGCInfo}`            — video / audio / pdf metadata
//             tags (ffmpeg `-metadata AIGC=<json>` value, WAV RIFF
//             AIGC subchunk, ID3v2 TXXX:AIGC).
//   - Nested: `{"AIGC": {...AIGCInfo}}`  — image EXIF UserComment (JPEG)
//             and PNG tEXt chunk per mcp-server convention.
//
// "ContentProducer" / "ContentPropagator" are filled by caller via
// newProducerAigcInfo() — the canonical value is "MiniMax AI"
// (brand-correct spelling, kept in lockstep with mcp-server Python + Go).
export {};
//# sourceMappingURL=types.js.map