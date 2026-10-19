const MAX_EVIDENCE_CHARS = 200_000;
/**
 * Find demonstrable reuse, not semantic relevance. Match substantive lines
 * and complete clauses after excluding code, links and standalone values.
 * Index all competing evidence once so shared text cannot attribute every hit.
 * Callers only use these IDs for Web sources; App/File policies stay separate.
 */
export function collectUsedWebEvidenceIds(answer, evidenceById) {
    const lineOwners = new Map();
    const clauseOwners = new Map();
    for (const [id, evidence] of evidenceById) {
        const bounded = comparableProse(evidence);
        for (const line of bounded.split(/\r?\n/u)) {
            const candidate = line.trim();
            if (isSubstantiveText(candidate))
                addOwner(lineOwners, candidate, id);
        }
        for (const clause of comparableClauses(bounded))
            addOwner(clauseOwners, clause, id);
    }
    const used = new Set();
    const answerProse = comparableProse(answer);
    for (const [line, owner] of lineOwners) {
        if (owner && answerProse.includes(line))
            used.add(owner);
    }
    for (const clause of comparableClauses(answerProse)) {
        const owner = clauseOwners.get(clause);
        if (owner)
            used.add(owner);
    }
    return used;
}
function addOwner(owners, text, id) {
    if (!owners.has(text))
        owners.set(text, id);
    else if (owners.get(text) !== id)
        owners.set(text, null);
}
function comparableProse(text) {
    return (text
        .slice(0, MAX_EVIDENCE_CHARS)
        .normalize('NFKC')
        .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, '\n')
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '\n')
        .replace(/<\/?(?:p|div|li|br|h[1-6])\b[^>]*>/giu, '\n')
        .replace(/<[^>]*>/gu, '')
        // Link labels/navigation and URL substrings are not evidence of adoption.
        .replace(/!?\[[^\]\n]*\]\([^\n)]*\)/gu, '')
        .replace(/https?:\/\/[^\s<>]+/giu, ''));
}
function comparableClauses(text) {
    return (text
        .split(/[\n。！？；，!?;]+|,(?!\d)|\.(?=\s|$)/u)
        .map((clause) => clause.trim().replace(/^(?:[-+*]|\d+[.)]|#{1,6}|>)\s+/u, ''))
        .map((clause) => clause.replace(/[*_`]/gu, '').trim())
        .map((clause) => /\p{Script=Han}/u.test(clause) ? clause.replace(/\s+/gu, '') : clause.replace(/\s+/gu, ' '))
        // Never infer adoption from a bare temperature/date, a short topic word,
        // or an arbitrary substring. Negation and wording are kept intact.
        .filter(isSubstantiveText));
}
function isSubstantiveText(text) {
    const hanCount = text.match(/\p{Script=Han}/gu)?.length ?? 0;
    return (text.length <= 500 &&
        (hanCount >= 7 ||
            (hanCount === 0 && text.length >= 24 && (text.match(/\p{L}{2,}/gu)?.length ?? 0) >= 4)));
}
//# sourceMappingURL=web-source-evidence.js.map