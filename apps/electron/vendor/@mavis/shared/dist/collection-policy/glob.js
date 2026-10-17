/**
 * Bounded glob subset accepted from remote configuration.
 *
 * Remote patterns are matched with minimatch, so the accepted subset is deliberately narrow:
 * every pattern has a bounded number of segments, wildcards, globstars, brace alternatives and
 * character classes. That keeps brace expansion and the generated regular expression linear in
 * the (also bounded) pattern length, so a hostile document cannot turn into a ReDoS or a
 * combinatorial expansion. Extglobs, escapes, alternation groups, negation, absolute paths and
 * parent traversal are rejected outright rather than normalised away.
 */
import { makeRe } from 'minimatch';
/** Longest input a compiled policy pattern is matched against. */
export const MAX_GLOB_MATCH_INPUT_LENGTH = 4_096;
export const WORKSPACE_GLOB_LIMITS = {
    maxLength: 200,
    maxSegments: 16,
    maxWildcards: 12,
    maxGlobstars: 2,
    maxBraceGroups: 2,
    maxBraceAlternatives: 8,
    maxBraceExpansions: 16,
    maxCharacterClasses: 4,
    allowSlash: true,
};
export const NAME_GLOB_LIMITS = { ...WORKSPACE_GLOB_LIMITS, allowSlash: false };
const MINIMATCH_OPTIONS = { dot: true, nocase: true };
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u;
const DRIVE_LETTER_PREFIX = /^[a-z]:/u;
// Alternation, redirection and quoting characters have no glob meaning here; rejecting them
// keeps accepted patterns readable and free of shell-flavoured surprises.
const REJECTED_CHARACTERS = {
    '(': true,
    ')': true,
    '|': true,
    '<': true,
    '>': true,
    '"': true,
    '`': true,
    ';': true,
};
/**
 * Normalises a raw pattern to its canonical form (forward slashes, no duplicate or trailing
 * separators, lowercase because matching is case-insensitive) and rejects anything outside the
 * supported subset. Returns `undefined` for unsupported patterns; callers treat that as an
 * invalid document rather than silently dropping the rule.
 */
export function normalizeGlob(value, limits) {
    if (typeof value !== 'string')
        return undefined;
    if (value.length === 0 || value.length > limits.maxLength)
        return undefined;
    if (CONTROL_CHARACTER.test(value))
        return undefined;
    const normalized = value
        .replaceAll('\\', '/')
        .replace(/\/{2,}/gu, '/')
        .replace(/\/+$/u, '')
        .toLowerCase();
    if (normalized.length === 0)
        return undefined;
    if (!isSupportedGlob(normalized, limits))
        return undefined;
    if (makeRe(normalized, MINIMATCH_OPTIONS) === false)
        return undefined;
    return normalized;
}
/** Compiles an already-normalised pattern. Returns `undefined` when minimatch rejects it. */
export function compileGlob(pattern) {
    const regex = makeRe(pattern, MINIMATCH_OPTIONS);
    return regex === false ? undefined : regex;
}
/**
 * A trailing `/**` also excludes the directory holding the subtree, which is what lets the
 * workspace scanner prune instead of walking. Returns the directory pattern, or `undefined`
 * when the pattern does not cover a whole subtree.
 */
export function subtreeDirectoryPattern(pattern) {
    if (!pattern.endsWith('/**'))
        return undefined;
    const prefix = pattern.slice(0, -3);
    return prefix.length > 0 ? prefix : undefined;
}
function isSupportedGlob(pattern, limits) {
    if (pattern.startsWith('/') || pattern.startsWith('!'))
        return false;
    if (pattern.includes('..'))
        return false;
    if (DRIVE_LETTER_PREFIX.test(pattern))
        return false;
    if (!limits.allowSlash && pattern.includes('/'))
        return false;
    return isSupportedGlobSyntax(pattern, limits) && isSupportedSegmentShape(pattern, limits);
}
function isSupportedGlobSyntax(pattern, limits) {
    let wildcards = 0;
    let braceGroups = 0;
    let braceExpansions = 1;
    let characterClasses = 0;
    let braceAlternatives;
    let classBody;
    for (const character of pattern) {
        if (classBody !== undefined) {
            if (character === '[' || character === '/')
                return false;
            if (character !== ']') {
                classBody += character;
                continue;
            }
            if (!isSupportedCharacterClass(classBody))
                return false;
            classBody = undefined;
            characterClasses += 1;
            continue;
        }
        if (Object.hasOwn(REJECTED_CHARACTERS, character))
            return false;
        if (character === '!' || character === '^' || character === ']')
            return false;
        if (character === '[')
            classBody = '';
        else if (character === '*' || character === '?')
            wildcards += 1;
        else if (character === '{') {
            if (braceAlternatives !== undefined)
                return false;
            braceGroups += 1;
            braceAlternatives = 1;
        }
        else if (character === ',' && braceAlternatives !== undefined)
            braceAlternatives += 1;
        else if (character === '}') {
            if (braceAlternatives === undefined ||
                braceAlternatives < 2 ||
                braceAlternatives > limits.maxBraceAlternatives) {
                return false;
            }
            braceExpansions *= braceAlternatives;
            braceAlternatives = undefined;
        }
    }
    if (classBody !== undefined || braceAlternatives !== undefined)
        return false;
    return (wildcards <= limits.maxWildcards &&
        characterClasses <= limits.maxCharacterClasses &&
        braceGroups <= limits.maxBraceGroups &&
        braceExpansions <= limits.maxBraceExpansions);
}
function isSupportedCharacterClass(body) {
    if (body.length === 0 || body === '!' || body === '^')
        return false;
    try {
        RegExp(`[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`, 'u');
    }
    catch {
        return false;
    }
    return true;
}
function isSupportedSegmentShape(pattern, limits) {
    const segments = pattern.split('/');
    if (segments.length > limits.maxSegments)
        return false;
    let globstars = 0;
    for (const segment of segments) {
        if (segment.length === 0 || segment === '.')
            return false;
        if (segment === '**') {
            globstars += 1;
            continue;
        }
        // `a**b` behaves as `a*b` in minimatch; reject it so every accepted pattern reads the way
        // it matches.
        if (segment.includes('**'))
            return false;
    }
    return globstars <= limits.maxGlobstars;
}
//# sourceMappingURL=glob.js.map