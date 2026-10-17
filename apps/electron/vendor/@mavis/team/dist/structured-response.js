/**
 * Structured JSON response extractor with Zod validation.
 *
 * Parses JSON from freeform LLM text output, validates against Zod schemas,
 * and provides retry prompt generation for validation failures.
 */
import { z } from 'zod';
// ─── JSON Extraction ────────────────────────────────────────────────
/**
 * Extract the first valid JSON object/array from freeform LLM text.
 * Tries in order:
 * 1. Markdown fenced code block (```json ... ```)
 * 2. Bracket-matching scanner (finds balanced { } or [ ])
 * 3. Raw trim + JSON.parse
 */
export function extractJsonFromText(text) {
    // Strategy 1: Markdown fenced code block
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
        try {
            return JSON.parse(fenceMatch[1].trim());
        }
        catch {
            // Fenced content wasn't valid JSON — fall through
        }
    }
    // Strategy 2: Bracket-matching scanner
    const bracketResult = scanForBalancedJson(text);
    if (bracketResult !== null)
        return bracketResult;
    // Strategy 3: Raw trim + JSON.parse (entire text might be JSON)
    try {
        return JSON.parse(text.trim());
    }
    catch {
        return null;
    }
}
/**
 * Scan text for the first balanced JSON object or array.
 * Handles string escapes and nested structures.
 */
function scanForBalancedJson(text) {
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch !== '{' && ch !== '[')
            continue;
        const closeChar = ch === '{' ? '}' : ']';
        let depth = 1;
        let inString = false;
        let escape = false;
        let j = i + 1;
        for (; j < text.length && depth > 0; j++) {
            if (escape) {
                escape = false;
                continue;
            }
            const c = text[j];
            if (inString) {
                if (c === '\\')
                    escape = true;
                else if (c === '"')
                    inString = false;
                continue;
            }
            if (c === '"') {
                inString = true;
            }
            else if (c === '{' || c === '[') {
                depth++;
            }
            else if (c === '}' || c === ']') {
                depth--;
                if (depth === 0 && c !== closeChar) {
                    // Mismatched bracket type — not a valid pair
                    depth = 1; // reset and keep scanning
                }
            }
        }
        if (depth === 0) {
            const candidate = text.slice(i, j);
            try {
                return JSON.parse(candidate);
            }
            catch {
                // Balanced brackets but invalid JSON — keep scanning
            }
        }
    }
    return null;
}
// ─── Structured Response Parsing ────────────────────────────────────
/**
 * Parse and validate structured response from LLM output.
 * Returns validated data or an error description.
 */
export function parseStructuredResponse(content, schema) {
    const extracted = extractJsonFromText(content);
    if (extracted === null) {
        return { error: 'No valid JSON found in response', raw: null };
    }
    const result = schema.safeParse(extracted);
    if (result.success) {
        return { data: result.data };
    }
    const issues = result.error.issues
        .map((iss) => `  - ${iss.path.join('.')}: ${iss.message}`)
        .join('\n');
    return { error: `Schema validation failed:\n${issues}`, raw: extracted };
}
// ─── Retry Prompt ───────────────────────────────────────────────────
/**
 * Build a retry prompt when validation fails.
 * Includes the validation errors and asks the LLM to respond with JSON only.
 */
export function buildRetryPrompt(originalPrompt, validationError, rawResponse) {
    return [
        '## Retry Required — Invalid Response Format',
        '',
        'Your previous response could not be parsed as valid structured JSON.',
        '',
        '### Validation Error',
        validationError,
        '',
        '### Your Previous Response (excerpt)',
        rawResponse.slice(0, 500),
        '',
        '### Original Request',
        originalPrompt,
        '',
        '### Instructions',
        'Respond with ONLY a valid JSON object. No prose, no markdown fences, no explanation.',
        'Just the raw JSON that matches the required schema.',
    ].join('\n');
}
// ─── Verifier-Specific Schema & Parser ──────────────────────────────
export const VerifierVerdictSchema = z.object({
    passed: z.boolean(),
    reason: z.string().min(1),
    issues: z.array(z.string()).optional(),
});
/**
 * Parse verifier verdict from LLM output.
 *
 * Priority order (keyword-first to avoid false positives from quoted examples):
 *   1. Explicit VERDICT: PASS/FAIL keyword — authoritative, always wins
 *   2. Structured JSON matching VerifierVerdictSchema — used when no keyword present
 *   3. Default fail — no verdict found
 *
 * Why keyword-first: the verifier prompt includes a JSON example. Verifiers often
 * quote this example in their analysis text before giving their real verdict via
 * the VERDICT keyword. If JSON extraction ran first, the quoted example would be
 * mistaken for the actual verdict.
 */
export function parseVerifierResponse(content) {
    // 1. Check for explicit VERDICT keyword first — always takes precedence
    const keywordResult = legacyVerdictScan(content);
    if (keywordResult.summary !== 'No explicit VERDICT found') {
        return keywordResult;
    }
    // 2. No keyword found — try structured JSON extraction
    const result = parseStructuredResponse(content, VerifierVerdictSchema);
    if ('data' in result) {
        return {
            passed: result.data.passed,
            summary: result.data.reason,
            issues: result.data.issues,
            parseMethod: 'structured',
        };
    }
    // 3. Neither keyword nor valid JSON — default to fail
    return keywordResult;
}
/**
 * Legacy verdict scanner — scans from bottom of text for VERDICT: PASS/FAIL.
 * Preserves backward compatibility with existing verifier prompts.
 */
function legacyVerdictScan(content) {
    for (const line of content.split('\n').reverse()) {
        const up = line.trim().toUpperCase();
        if (up.includes('VERDICT: PASS') || up.includes('VERDICT:PASS')) {
            return { passed: true, summary: content.slice(-500), parseMethod: 'legacy-keyword' };
        }
        if (up.includes('VERDICT: FAIL') || up.includes('VERDICT:FAIL')) {
            return { passed: false, summary: content.slice(-500), parseMethod: 'legacy-keyword' };
        }
    }
    return { passed: false, summary: 'No explicit VERDICT found', parseMethod: 'legacy-keyword' };
}
//# sourceMappingURL=structured-response.js.map