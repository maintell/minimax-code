/**
 * Assignment verdict primitives.
 *
 * Scope boundary: this module is pure. It owns the verdict types, the mapping
 * from a verdict to a Goal status, the idempotency key of a delivered verdict,
 * parsing reviewer output into a verdict, and validating a verdict read back
 * from storage. It performs no storage access, no IO and no state-machine work:
 * persistence, transitions and the Bunny close gate live elsewhere.
 */
const OUTCOMES = ['pass', 'fail', 'partial'];
const SOURCES = ['runtime', 'bunny', 'verifier'];
const RISK_TIERS = ['low', 'medium', 'high'];
const EVIDENCE_KINDS = [
    'file',
    'command',
    'output',
    'url',
    'other',
];
const GOAL_STATUS_BY_OUTCOME = {
    pass: 'met',
    fail: 'not_met',
    partial: 'inconclusive',
};
const MAX_EVIDENCE_ITEMS = 32;
const MAX_REF_LENGTH = 500;
const MAX_DETAIL_LENGTH = 2000;
const MAX_SUMMARY_LENGTH = 2000;
const MAX_RAW_LENGTH = 4000;
const MAX_PARSE_FAILED_SUMMARY_LENGTH = 200;
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
function isSafePositiveInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function isSafeNonNegativeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isMember(values, candidate) {
    return values.includes(candidate);
}
function truncate(value, maxLength) {
    return value.length <= maxLength ? value : value.slice(0, maxLength);
}
function asUnknownArray(value) {
    return Array.isArray(value) ? value : null;
}
/** Builds a verdict with a fixed key order and no `undefined` keys. */
function assembleVerdict(core, optionals) {
    return {
        outcome: core.outcome,
        evidence: core.evidence,
        source: core.source,
        revision: core.revision,
        reviewTaskId: core.reviewTaskId,
        at: core.at,
        ...(optionals.summary === undefined ? {} : { summary: optionals.summary }),
        ...(optionals.parseFailed === undefined ? {} : { parseFailed: optionals.parseFailed }),
        ...(optionals.riskTier === undefined ? {} : { riskTier: optionals.riskTier }),
        ...(optionals.raw === undefined ? {} : { raw: optionals.raw }),
    };
}
/** Returns the first balanced `{...}` in `text`, honouring strings and escapes. */
function extractFirstBalancedObject(text) {
    const start = text.indexOf('{');
    if (start < 0)
        return null;
    const state = { depth: 0, insideString: false, escaped: false };
    for (let index = start; index < text.length; index += 1) {
        const character = text.charAt(index);
        if (state.insideString) {
            readStringCharacter(state, character);
            continue;
        }
        if (readStructuralCharacter(state, character))
            return text.slice(start, index + 1);
    }
    return null;
}
/** Advances the in-string state; an escaped character only clears the escape flag. */
function readStringCharacter(state, character) {
    if (state.escaped)
        state.escaped = false;
    else if (character === '\\')
        state.escaped = true;
    else if (character === '"')
        state.insideString = false;
}
/** Advances the structural state; true once the object's own `}` closes it. */
function readStructuralCharacter(state, character) {
    if (character === '"')
        state.insideString = true;
    else if (character === '{')
        state.depth += 1;
    else if (character === '}') {
        state.depth -= 1;
        return state.depth === 0;
    }
    return false;
}
function parseObjectCandidate(candidate) {
    const objectSource = extractFirstBalancedObject(candidate);
    if (objectSource === null)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(objectSource);
    }
    catch {
        return null;
    }
    return isPlainObject(parsed) ? parsed : null;
}
/** Prefers fenced code blocks, then falls back to the first balanced object in the text. */
function extractVerdictObject(text) {
    const segments = text.split('```');
    for (let index = 1; index < segments.length; index += 2) {
        const segment = segments[index];
        if (segment === undefined)
            continue;
        const parsed = parseObjectCandidate(segment);
        if (parsed !== null)
            return parsed;
    }
    return parseObjectCandidate(text);
}
function readOutcome(candidate) {
    const value = candidate.outcome !== undefined ? candidate.outcome : candidate.verdict;
    if (typeof value !== 'string')
        return null;
    const normalized = value.trim().toLowerCase();
    return isMember(OUTCOMES, normalized) ? normalized : null;
}
function normalizeRiskTier(value) {
    if (typeof value !== 'string')
        return undefined;
    const normalized = value.trim().toLowerCase();
    return isMember(RISK_TIERS, normalized) ? normalized : undefined;
}
function readRiskTier(candidate) {
    const value = candidate.riskTier !== undefined ? candidate.riskTier : candidate.risk_tier;
    return normalizeRiskTier(value);
}
function readSummary(candidate) {
    const value = candidate.summary;
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : truncate(trimmed, MAX_SUMMARY_LENGTH);
}
function readEvidenceList(candidate) {
    return asUnknownArray(candidate.evidence) ?? asUnknownArray(candidate.citations) ?? [];
}
function normalizeEvidenceItem(value) {
    if (typeof value === 'string') {
        if (value.trim().length === 0)
            return null;
        return { kind: 'other', ref: truncate(value, MAX_REF_LENGTH) };
    }
    if (!isPlainObject(value))
        return null;
    const ref = value.ref;
    if (typeof ref !== 'string' || ref.trim().length === 0)
        return null;
    const kindValue = value.kind;
    const normalizedKind = typeof kindValue === 'string' ? kindValue.trim().toLowerCase() : '';
    const kind = isMember(EVIDENCE_KINDS, normalizedKind) ? normalizedKind : 'other';
    const detail = value.detail;
    if (typeof detail === 'string') {
        return { kind, ref: truncate(ref, MAX_REF_LENGTH), detail: truncate(detail, MAX_DETAIL_LENGTH) };
    }
    return { kind, ref: truncate(ref, MAX_REF_LENGTH) };
}
function normalizeEvidence(values) {
    const items = [];
    for (const value of values) {
        if (items.length >= MAX_EVIDENCE_ITEMS)
            break;
        const item = normalizeEvidenceItem(value);
        if (item !== null)
            items.push(item);
    }
    return items;
}
function firstNonEmptyLine(text) {
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length > 0)
            return truncate(trimmed, MAX_PARSE_FAILED_SUMMARY_LENGTH);
    }
    return undefined;
}
function assertParseInput(input) {
    if (!isNonEmptyString(input.reviewTaskId)) {
        throw new Error('parseVerdict requires "reviewTaskId" to be a non-empty string');
    }
    if (!isSafePositiveInteger(input.revision)) {
        throw new Error('parseVerdict requires "revision" to be a safe positive integer');
    }
    if (typeof input.source !== 'string' || !isMember(SOURCES, input.source)) {
        throw new Error('parseVerdict requires "source" to be a known verdict source');
    }
    if (!isSafeNonNegativeInteger(input.at)) {
        throw new Error('parseVerdict requires "at" to be a non-negative safe integer');
    }
}
function readEvidenceEntry(value, where, index) {
    const label = `evidence[${index}]`;
    if (!isPlainObject(value)) {
        throw new Error(`${where} has an invalid "${label}"`);
    }
    const kind = value.kind;
    if (typeof kind !== 'string' || !isMember(EVIDENCE_KINDS, kind)) {
        throw new Error(`${where} has an invalid "${label}.kind"`);
    }
    const ref = value.ref;
    if (!isNonEmptyString(ref)) {
        throw new Error(`${where} has an invalid "${label}.ref"`);
    }
    const detail = value.detail;
    if (detail !== undefined && typeof detail !== 'string') {
        throw new Error(`${where} has an invalid "${label}.detail"`);
    }
    return detail === undefined ? { kind, ref } : { kind, ref, detail };
}
/** Returns the Goal status this verdict reads as. */
export function goalStatusOf(verdict) {
    return GOAL_STATUS_BY_OUTCOME[verdict.outcome];
}
/** Returns the `reviewTaskId` + `revision` key a repeated delivery is deduped by. */
export function verdictIdempotencyKey(input) {
    if (!isNonEmptyString(input.reviewTaskId)) {
        throw new Error('verdictIdempotencyKey requires "reviewTaskId" to be a non-empty string');
    }
    if (!isSafePositiveInteger(input.revision)) {
        throw new Error('verdictIdempotencyKey requires "revision" to be a safe positive integer');
    }
    return `verdict:${input.reviewTaskId}:${input.revision}`;
}
/** Reads a verdict out of reviewer output; unparseable output is a `partial` with `parseFailed`. */
export function parseVerdict(input) {
    assertParseInput(input);
    const inputRiskTier = normalizeRiskTier(input.riskTier);
    const candidate = extractVerdictObject(input.text);
    const outcome = candidate === null ? null : readOutcome(candidate);
    if (candidate === null || outcome === null) {
        return assembleVerdict({
            outcome: 'partial',
            evidence: [],
            source: input.source,
            revision: input.revision,
            reviewTaskId: input.reviewTaskId,
            at: input.at,
        }, {
            summary: firstNonEmptyLine(input.text),
            parseFailed: true,
            riskTier: inputRiskTier,
            raw: truncate(input.text, MAX_RAW_LENGTH),
        });
    }
    return assembleVerdict({
        outcome,
        evidence: normalizeEvidence(readEvidenceList(candidate)),
        source: input.source,
        revision: input.revision,
        reviewTaskId: input.reviewTaskId,
        at: input.at,
    }, {
        summary: readSummary(candidate),
        riskTier: readRiskTier(candidate) ?? inputRiskTier,
    });
}
/** The one error shape every malformed field is reported with. */
function invalidField(where, field) {
    return new Error(`${where} has an invalid "${field}"`);
}
/** A required field that must be one of `members`. */
function requireMember(value, members, where, field) {
    if (typeof value !== 'string' || !isMember(members, value))
        throw invalidField(where, field);
    return value;
}
/** An optional field that must be one of `members` when it is present at all. */
function readOptionalMember(value, members, where, field) {
    if (value === undefined)
        return undefined;
    return requireMember(value, members, where, field);
}
/** A required field that must satisfy `is`; the guard narrows it for the caller. */
function requireThat(value, is, where, field) {
    if (!is(value))
        throw invalidField(where, field);
    return value;
}
/** An optional field that must be a string when it is present at all. */
function readOptionalString(value, where, field) {
    if (value !== undefined && typeof value !== 'string')
        throw invalidField(where, field);
    return value;
}
/** An optional flag that may only ever be `true` when it is present at all. */
function readOptionalTrue(value, where, field) {
    if (value !== undefined && value !== true)
        throw invalidField(where, field);
    return value === true ? true : undefined;
}
/**
 * Validates a verdict read back from storage, throwing when it is malformed.
 *
 * Fields are checked in declaration order, so a verdict with several malformed fields is
 * always reported by the first of them.
 */
export function readVerdict(value, where) {
    if (!isPlainObject(value)) {
        throw new Error(`${where} is malformed`);
    }
    const outcome = requireMember(value.outcome, OUTCOMES, where, 'outcome');
    const source = requireMember(value.source, SOURCES, where, 'source');
    const revision = requireThat(value.revision, isSafePositiveInteger, where, 'revision');
    const reviewTaskId = requireThat(value.reviewTaskId, isNonEmptyString, where, 'reviewTaskId');
    const at = requireThat(value.at, isSafeNonNegativeInteger, where, 'at');
    const evidenceValue = asUnknownArray(value.evidence);
    if (evidenceValue === null) {
        throw invalidField(where, 'evidence');
    }
    const evidence = evidenceValue.map((item, index) => readEvidenceEntry(item, where, index));
    const parseFailed = readOptionalTrue(value.parseFailed, where, 'parseFailed');
    const riskTier = readOptionalMember(value.riskTier, RISK_TIERS, where, 'riskTier');
    const summary = readOptionalString(value.summary, where, 'summary');
    const raw = readOptionalString(value.raw, where, 'raw');
    return assembleVerdict({ outcome, evidence, source, revision, reviewTaskId, at }, { summary, parseFailed, riskTier, raw });
}
//# sourceMappingURL=verdict.js.map