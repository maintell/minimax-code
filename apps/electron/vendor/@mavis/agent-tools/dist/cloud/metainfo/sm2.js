// SM2 signature for AIGC metainfo — JSON canonical signData encoding.
//
// Cross-language alignment: matches mcp-server signing.py (Python
// `gmssl`). The canonical signData layout is:
//
//   signData = JSON.stringify(metaWithZeroedReservedCode, sort_keys=True,
//                              separators=(",", ":")) + pureFileData
//
// Producer signature (ReservedCode1):
//   meta_zero = { ...meta, ReservedCode1: "", ReservedCode2: "" }
//   ReservedCode1 = SM2.sign(privKey, JSON_canonical(meta_zero) + pureFileData)
//
// Propagator signature (ReservedCode2):
//   meta_zero = { ...meta, ReservedCode2: "" }   // keep ReservedCode1 filled
//   ReservedCode2 = SM2.sign(privKey, JSON_canonical(meta_zero) + pureFileData)
//
// Important divergence from storage-gateway (Go): Go uses `encoding/gob`
// for signData; Python uses JSON canonical. This module aligns with the
// Python (mcp-server) variant because this package ships the watermarked
// asset alongside mcp-server outputs — they share the same SM2 PEM key
// pair and the same JSON canonical contract. Cross-service verify with
// storage-gateway is intentionally NOT supported (per mcp-server
// signing.py docstring: P3 option A simplified, 2026-05-27).
//
// SM2 algorithm details (sm-crypto with `hash: false`):
//   - sm-crypto's `doSignature(msg, privateKey, { hash: false })` treats
//     msg as a pre-computed digest hex and produces an `r||s` hex
//     signature (128 chars, NOT DER-encoded), matching the gmssl Python
//     `CryptSM2.sign(data, k)` shape.
//   - `hash: false` is mandatory: gmssl Python computes
//     `e = int(data.hex(), 16) % n` directly without SM3 preprocessing
//     or ZA derivation, so enabling sm-crypto's default SM3+ZA hashing
//     would produce a different signature.
//
// Best-effort / fail-soft: signAigcProducer / signAigcPropagator return
// empty strings when keys are missing or signing fails, mirroring
// mcp-server `fill_signatures` no-op behaviour. This lets callers
// publish AIGC metadata without keys (compliance label still satisfies
// GB 45438-2025 even if SM2 reverse-lookup is unavailable).
// sm-crypto is CJS; the default import surfaces both sm2 and sm3
// namespaces. @types/sm-crypto exposes the typed signature.
import smCrypto from 'sm-crypto';
const { sm2 } = smCrypto;
/**
 * Produce the canonical signData buffer fed into SM2.sign.
 *
 * Mirrors mcp-server signing.py `_sign_canonical`:
 *   - `forProducer=true`: zero BOTH ReservedCode1 and ReservedCode2 on
 *     the meta copy before serialisation.
 *   - `forProducer=false`: zero ONLY ReservedCode2 (keep ReservedCode1
 *     filled by an earlier producer signing pass).
 *
 * Returns the byte concatenation:
 *   `JSON.stringify(meta_zero, sorted_keys, no_whitespace) + pureFileData`
 *
 * Exposed for cross-service byte-equivalence tests (the sign step
 * itself is randomised via SM2 k, but signData must be reproducible).
 */
export function buildSignData(meta, pureFileData, forProducer) {
    const zeroed = forProducer
        ? { ...meta, ReservedCode1: '', ReservedCode2: '' }
        : { ...meta, ReservedCode2: '' };
    const jsonBytes = Buffer.from(canonicalJsonStringify(aigcInfoToRecord(zeroed)), 'utf8');
    return Buffer.concat([jsonBytes, pureFileData]);
}
/**
 * JSON.stringify with sorted keys and no separators whitespace — the
 * Python `json.dumps(obj, sort_keys=True, separators=(",", ":"))`
 * equivalent. Field ordering follows `Array.prototype.sort()` ASCII
 * lexicographic order, identical to Python's default sort_keys.
 *
 * Only handles flat objects of string fields (sufficient for AIGCInfo).
 * Public for tests; not exported from the module barrel.
 */
export function canonicalJsonStringify(obj) {
    const keys = Object.keys(obj).sort();
    const parts = [];
    for (const k of keys) {
        parts.push(`${JSON.stringify(k)}:${JSON.stringify(obj[k])}`);
    }
    return `{${parts.join(',')}}`;
}
/**
 * AIGCInfo → flat `Record<string, string>` for the canonical
 * serialiser. Explicit field copy keeps the function honest if AIGCInfo
 * ever gains non-string members (we'd want a compile error here, not
 * a silent miss).
 */
function aigcInfoToRecord(meta) {
    return {
        Label: meta.Label,
        ContentProducer: meta.ContentProducer,
        ProduceID: meta.ProduceID,
        ReservedCode1: meta.ReservedCode1,
        ContentPropagator: meta.ContentPropagator,
        PropagateID: meta.PropagateID,
        ReservedCode2: meta.ReservedCode2,
    };
}
/**
 * Sign the producer half of an AIGCInfo. Returns the SM2 signature as
 * 128-hex-char `r||s` string, or "" if signing fails (key invalid /
 * sm-crypto throws).
 *
 * Caller MUST pass the producer's 64-hex private key (32 raw bytes)
 * and the matching 130-hex uncompressed public key
 * (`04` || X || Y, 65 raw bytes). See README in matrix-watermark-service
 * for the PEM → hex extraction recipe; callers receive
 * the hex pair from secret-store at boot.
 *
 * @param privKeyHex — 64-char SM2 private key hex.
 * @param pubKeyHex — 130-char uncompressed public key hex (with `04`
 *   prefix); used by sm-crypto for fixed-step ZA derivation (we pass
 *   `hash:false` to skip ZA, but sm-crypto still requires it as a
 *   defensive argument shape).
 * @param meta — AIGCInfo to sign. Caller's copy is NOT mutated; this
 *   function constructs an internal copy with ReservedCode1/2 zeroed.
 * @param pureFileData — file bytes to bind to the signature. For
 *   image: re-encoded pixel-only bytes (storage-gateway recipe). For
 *   video / audio: raw container bytes (per mcp-server convention —
 *   stripping metadata mid-hot-path is too expensive).
 * @returns hex signature (128 chars, `r||s`) or "" on failure.
 */
export function signAigcProducer(privKeyHex, pubKeyHex, meta, pureFileData) {
    if (!privKeyHex || !pubKeyHex)
        return '';
    try {
        const signData = buildSignData(meta, pureFileData, true);
        return sm2.doSignature(bufferToNumberArray(signData), privKeyHex, {
            hash: false,
            der: false,
            publicKey: pubKeyHex,
        });
    }
    catch {
        return '';
    }
}
/**
 * Sign the propagator half of an AIGCInfo. Returns hex signature or
 * "" on failure. The meta copy keeps ReservedCode1 (the producer
 * signature) — this is intentional so reverse-lookup can chain
 * propagator → producer.
 */
export function signAigcPropagator(privKeyHex, pubKeyHex, meta, pureFileData) {
    if (!privKeyHex || !pubKeyHex)
        return '';
    try {
        const signData = buildSignData(meta, pureFileData, false);
        return sm2.doSignature(bufferToNumberArray(signData), privKeyHex, {
            hash: false,
            der: false,
            publicKey: pubKeyHex,
        });
    }
    catch {
        return '';
    }
}
/**
 * Verify a producer signature. Returns true iff the SM2 signature
 * over the canonical producer signData (ReservedCode1+2 both zeroed)
 * is valid for the given public key. Used by tests and by
 * archon-server reverse-lookup tool.
 */
export function verifyAigcProducer(pubKeyHex, meta, pureFileData, signatureHex) {
    if (!pubKeyHex || !signatureHex)
        return false;
    try {
        const signData = buildSignData(meta, pureFileData, true);
        return sm2.doVerifySignature(bufferToNumberArray(signData), signatureHex, pubKeyHex, {
            hash: false,
            der: false,
        });
    }
    catch {
        return false;
    }
}
/**
 * Verify a propagator signature. Returns true iff the SM2 signature
 * over the canonical propagator signData (ReservedCode1 retained,
 * ReservedCode2 zeroed) is valid for the given public key.
 */
export function verifyAigcPropagator(pubKeyHex, meta, pureFileData, signatureHex) {
    if (!pubKeyHex || !signatureHex)
        return false;
    try {
        const signData = buildSignData(meta, pureFileData, false);
        return sm2.doVerifySignature(bufferToNumberArray(signData), signatureHex, pubKeyHex, {
            hash: false,
            der: false,
        });
    }
    catch {
        return false;
    }
}
/**
 * Fill ReservedCode1 + ReservedCode2 on meta in place. Producer
 * signature is computed FIRST so the propagator signature covers the
 * already-signed producer half — matches mcp-server signing.py order
 * for reverse-lookup chain compatibility.
 *
 * No-op (silent) when either key is empty — keeps the contract with
 * dev/test environments that ship without SM2 PEM keys.
 */
export function fillSignatures(privKeyHex, pubKeyHex, meta, pureFileData) {
    if (!privKeyHex || !pubKeyHex)
        return;
    meta.ReservedCode1 = signAigcProducer(privKeyHex, pubKeyHex, meta, pureFileData);
    meta.ReservedCode2 = signAigcPropagator(privKeyHex, pubKeyHex, meta, pureFileData);
}
/**
 * Generate a fresh SM2 keypair. Convenience for tests; production
 * callers load keys from secret-store / PEM files.
 */
export function generateKeyPairHex() {
    return sm2.generateKeyPairHex();
}
/**
 * sm-crypto's `doSignature` / `doVerifySignature` accept `string | number[]`.
 * We pass binary signData (JSON canonical + raw file bytes), so convert
 * Buffer → number[]. This is O(N) on payload size; acceptable because
 * the only call site is on the watermark hot path with payload ≤100 MB.
 */
function bufferToNumberArray(buf) {
    // Array.from(Uint8Array) is the idiomatic stdlib path and faster than
    // a manual for-loop in V8 for typical sizes.
    return Array.from(buf);
}
//# sourceMappingURL=sm2.js.map