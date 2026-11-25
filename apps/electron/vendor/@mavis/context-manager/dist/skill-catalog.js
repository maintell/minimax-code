/**
 * `<available_skills>` catalog renderer shared by the desktop runtime and Cloud Runtime.
 *
 * Every skill name is always listed: protected Skills first, then by name. The
 * budget B = min(2% of the context window, 5,000 tokens) constrains descriptions
 * only, so the catalog exceeds B when the names alone do. Protected Skills keep
 * their full descriptions; the others get their full description (capped at
 * 1,024 code points) or none, in keep order: decayed usage score, new-skill
 * protection, builtin tier, name. The same input always renders the same bytes.
 */
import { createDefaultTokenEstimator } from './token-estimator.js';
const LOCAL_SKILL_CATALOG_MAX_BUDGET_TOKENS = 5_000;
/** Longest description a non-protected Skill shows, in code points. */
const SKILL_DESCRIPTION_MAX_CODE_POINTS = 1_024;
const PROTECTED_SKILL_NAMES = new Set(['mcode-tools-master', 'minimax-code-product']);
/**
 * Official Office plugin Skills replaced the bundled `docx` / `xlsx` / `pdf` /
 * `pptx` Skills. Hosts project plugin Skills as non-builtin, so keep these four
 * runtime names in the builtin tier they had before the move.
 */
const BUILTIN_TIER_PLUGIN_SKILL_NAMES = new Set(['excel:xlsx', 'pdf:pdf', 'ppt:pptx', 'word:docx']);
const DAY_MS = 24 * 60 * 60 * 1_000;
const USAGE_HALF_LIFE_MS = 30 * DAY_MS;
const NEW_SKILL_PROTECTION_MS = 7 * DAY_MS;
/** First line inside the block whenever a description was dropped for the budget. */
export const SKILL_NAME_ONLY_NOTICE = 'Some skills are listed by name only to fit the context budget. If a name may fit the task, load it with the `skill` tool to read its full instructions.';
const DEFAULT_TOKEN_ESTIMATOR = createDefaultTokenEstimator();
/** Key of a Skill in usage maps: trimmed, NFKC-normalized, lowercase. */
export function normalizeSkillUsageKey(name) {
    return name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
/** The description budget B: min(2% of the context window, 5,000 tokens). */
export function resolveSkillCatalogBudgetTokens(contextWindowTokens) {
    if (typeof contextWindowTokens !== 'number' ||
        !Number.isFinite(contextWindowTokens) ||
        contextWindowTokens <= 0) {
        return LOCAL_SKILL_CATALOG_MAX_BUDGET_TOKENS;
    }
    return Math.min(Math.floor(contextWindowTokens * 0.02), LOCAL_SKILL_CATALOG_MAX_BUDGET_TOKENS);
}
/** A description as the catalog shows it before any cap: whitespace collapsed and trimmed. */
export function normalizeSkillCatalogDescription(description) {
    return description.replace(/\s+/gu, ' ').trim();
}
/**
 * The description as catalog lines, signatures and updates show it: normalized,
 * whole for protected Skills, capped at 1,024 code points for the others.
 */
export function skillCatalogDescription(entry) {
    const normalized = normalizeSkillCatalogDescription(entry.description);
    if (isProtectedSkill(entry.name))
        return normalized;
    const codePoints = Array.from(normalized);
    return codePoints.length > SKILL_DESCRIPTION_MAX_CODE_POINTS
        ? codePoints.slice(0, SKILL_DESCRIPTION_MAX_CODE_POINTS).join('')
        : normalized;
}
/** Builtin Skills and the official Office plugin Skills share the builtin keep tier. */
function isBuiltinTierSkill(entry) {
    return entry.builtin || BUILTIN_TIER_PLUGIN_SKILL_NAMES.has(entry.name);
}
export function renderLocalSkillsCatalogResult(skills, options = {}) {
    if (skills.length === 0) {
        return {
            catalog: '',
            descriptionsDropped: 0,
            nameOnly: new Set(),
            descriptionCapTruncated: false,
            catalogTokens: 0,
        };
    }
    const estimator = options.tokenEstimator ?? DEFAULT_TOKEN_ESTIMATOR;
    const budgetTokens = resolveSkillCatalogBudgetTokens(options.contextWindowTokens);
    const { prepared, descriptionCapTruncated } = prepareSkills(skills);
    const result = (catalog, nameOnly) => ({
        catalog,
        descriptionsDropped: nameOnly.size,
        nameOnly,
        descriptionCapTruncated,
        catalogTokens: estimator.estimateTextTokens(catalog),
    });
    /**
     * B constrains the descriptions only: names, order lines and the notice are not
     * budgeted, so the catalog may exceed B when the names alone do.
     */
    const tokensOf = (described) => descriptionTokens(prepared, described, estimator);
    const everyIndex = new Set(prepared.keys());
    const droppable = prepared.flatMap((skill, index) => !skill.protected && skill.description ? [index] : []);
    if (tokensOf(everyIndex) <= budgetTokens || droppable.length === 0) {
        return result(renderCatalog(prepared, everyIndex), new Set());
    }
    // Protected descriptions are always placed; the notice comes with any drop.
    const described = new Set(prepared.flatMap((skill, index) => (skill.protected ? [index] : [])));
    let remaining = budgetTokens - tokensOf(described);
    const added = [];
    for (const index of keepOrder(prepared, droppable, options)) {
        const cost = estimator.estimateTextTokens(`: ${prepared[index].description}`);
        if (cost > remaining)
            continue;
        remaining -= cost;
        described.add(index);
        added.push(index);
    }
    // Per-line estimates can undercount the whole (BPE is not additive): drop the
    // last-added descriptions until the descriptions fit again.
    while (tokensOf(described) > budgetTokens && added.length > 0) {
        described.delete(added.pop());
    }
    const nameOnly = new Set(droppable.flatMap((index) => (described.has(index) ? [] : [prepared[index].name])));
    return result(renderCatalog(prepared, described, SKILL_NAME_ONLY_NOTICE), nameOnly);
}
/** No description placed: every Skill is listed by name. */
const NO_DESCRIPTIONS = new Set();
/**
 * Estimated tokens the placed descriptions add to a catalog: the difference
 * against the same catalog with every Skill name-only, which cancels the name
 * lines, the notice and the block overhead. This is the number B constrains.
 */
function descriptionTokens(prepared, described, estimator) {
    return (estimator.estimateTextTokens(renderCatalog(prepared, described, SKILL_NAME_ONLY_NOTICE)) -
        estimator.estimateTextTokens(renderCatalog(prepared, NO_DESCRIPTIONS, SKILL_NAME_ONLY_NOTICE)));
}
/** `descriptionTokens` of a catalog rendered by this renderer with `described` placed. */
export function measureSkillCatalogDescriptionTokens(skills, described, options = {}) {
    const { prepared } = prepareSkills(skills);
    const wanted = new Set(described);
    const indexes = new Set(prepared.flatMap((skill, index) => (wanted.has(skill.name) ? [index] : [])));
    return descriptionTokens(prepared, indexes, options.tokenEstimator ?? DEFAULT_TOKEN_ESTIMATOR);
}
/** Listing order: protected Skills first, then by name. */
function prepareSkills(skills) {
    let descriptionCapTruncated = false;
    const prepared = [...skills]
        .sort((left, right) => {
        const priority = Number(isProtectedSkill(right.name)) - Number(isProtectedSkill(left.name));
        return priority || left.name.localeCompare(right.name);
    })
        .map((skill) => {
        const description = skillCatalogDescription(skill);
        if (description !== normalizeSkillCatalogDescription(skill.description)) {
            descriptionCapTruncated = true;
        }
        return {
            name: skill.name,
            description,
            protected: isProtectedSkill(skill.name),
            builtinTier: isBuiltinTierSkill(skill),
        };
    });
    return { prepared, descriptionCapTruncated };
}
/**
 * Which descriptions stay first: higher decayed usage score, then never-used
 * Skills first seen within 7 days, then the builtin tier, then name.
 */
function keepOrder(skills, indexes, options) {
    const ranked = indexes.map((index) => {
        const skill = skills[index];
        const usage = options.usage?.get(normalizeSkillUsageKey(skill.name));
        const useCount = usage && Number.isFinite(usage.useCount) ? Math.max(0, usage.useCount) : 0;
        return {
            index,
            skill,
            score: usageScore(useCount, usage?.lastUsedAtMs, options.nowMs),
            fresh: useCount === 0 && isNewSkill(usage?.firstSeenAtMs, options.nowMs),
        };
    });
    return ranked
        .sort((left, right) => right.score - left.score ||
        Number(right.fresh) - Number(left.fresh) ||
        Number(right.skill.builtinTier) - Number(left.skill.builtinTier) ||
        left.skill.name.localeCompare(right.skill.name))
        .map(({ index }) => index);
}
/** useCount × 0.5^(days since last use / 30). */
function usageScore(useCount, lastUsedAtMs, nowMs) {
    if (useCount === 0)
        return 0;
    if (nowMs === undefined || lastUsedAtMs === undefined || !Number.isFinite(lastUsedAtMs)) {
        return useCount;
    }
    return useCount * 0.5 ** (Math.max(0, nowMs - lastUsedAtMs) / USAGE_HALF_LIFE_MS);
}
function isNewSkill(firstSeenAtMs, nowMs) {
    return (nowMs !== undefined &&
        firstSeenAtMs !== undefined &&
        Number.isFinite(firstSeenAtMs) &&
        nowMs - firstSeenAtMs <= NEW_SKILL_PROTECTION_MS);
}
function isProtectedSkill(name) {
    return PROTECTED_SKILL_NAMES.has(name);
}
function renderCatalog(skills, described, notice) {
    const entries = skills.map((skill, index) => described.has(index) && skill.description
        ? `- ${skill.name}: ${skill.description}`
        : `- ${skill.name}`);
    return `<available_skills>\n${[...(notice ? [notice] : []), ...entries].join('\n')}\n</available_skills>`;
}
//# sourceMappingURL=skill-catalog.js.map