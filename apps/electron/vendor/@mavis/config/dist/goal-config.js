export const GOAL_VERIFICATION_MODES = ['none', 'evaluator', 'subagent'];
export const GOAL_VERIFICATION_EVIDENCE_MODES = ['brief', 'transcript'];
export const GOAL_EVALUATOR_MODEL_POLICIES = ['same-route-small-fast'];
export const GOAL_VERIFIER_READONLY_PROFILE = 'goal-verifier-readonly';
export const GOAL_SUBAGENT_PROFILES = [GOAL_VERIFIER_READONLY_PROFILE];
export const GOAL_CONFIG_DEFAULTS = {
    budget: {
        graceSteps: 1,
    },
    breaker: { repeatedReplyLimit: 3 },
    verifier: { repeatedNotMetLimit: 5, evidence: 'brief' },
    evaluator: {
        modelPolicy: 'same-route-small-fast',
        maxTokens: 32_000,
        timeoutSeconds: 60,
        maxRetries: 1,
    },
};
export const GOAL_CONFIG_LIMITS = {
    budget: { graceSteps: 3 },
    evaluator: { maxRetries: 1 },
};
/**
 * Goal configuration is deliberately fault-tolerant: one malformed Goal leaf
 * must not make the process-wide configuration unavailable. Invalid leaves
 * fall back independently, optional limits are dropped, bounded values are
 * clamped, and every correction is returned as a startup diagnostic.
 */
export function parseGoalConfig(raw) {
    const warnings = [];
    const goal = goalObject(raw, 'goal', warnings);
    warnUnknownKeys(goal, 'goal', warnings, [
        'objectiveMaxChars',
        'verification',
        'budget',
        'breaker',
        'verifier',
        'evaluator',
        'subagent',
    ]);
    const budget = goalObject(goal.budget, 'goal.budget', warnings);
    warnUnknownKeys(budget, 'goal.budget', warnings, [
        'defaultTokens',
        'defaultMainTurns',
        'defaultActiveSeconds',
        'graceSteps',
    ]);
    const breaker = goalObject(goal.breaker, 'goal.breaker', warnings);
    warnUnknownKeys(breaker, 'goal.breaker', warnings, ['repeatedReplyLimit']);
    const verifier = goalObject(goal.verifier, 'goal.verifier', warnings);
    warnUnknownKeys(verifier, 'goal.verifier', warnings, ['repeatedNotMetLimit', 'evidence']);
    const evaluator = goalObject(goal.evaluator, 'goal.evaluator', warnings);
    warnUnknownKeys(evaluator, 'goal.evaluator', warnings, [
        'modelPolicy',
        'maxTokens',
        'timeoutSeconds',
        'maxRetries',
    ]);
    const subagent = goalObject(goal.subagent, 'goal.subagent', warnings);
    warnUnknownKeys(subagent, 'goal.subagent', warnings, [
        'profile',
        'maxTurns',
        'maxTokens',
        'timeoutSeconds',
    ]);
    // No default and no initialization: an absent (or invalid) value leaves the
    // key off entirely so the runtime falls through to route-derived resolution.
    const verification = goalOptionalEnum(goal.verification, 'goal.verification', GOAL_VERIFICATION_MODES, warnings);
    const objectiveMaxChars = goalOptionalInteger(goal.objectiveMaxChars, 'goal.objectiveMaxChars', warnings, { min: 1 });
    const defaultTokens = goalOptionalInteger(budget.defaultTokens, 'goal.budget.defaultTokens', warnings, { min: 1 });
    const defaultMainTurns = goalOptionalInteger(budget.defaultMainTurns, 'goal.budget.defaultMainTurns', warnings, { min: 1 });
    const defaultActiveSeconds = goalOptionalInteger(budget.defaultActiveSeconds, 'goal.budget.defaultActiveSeconds', warnings, { min: 1 });
    const subagentProfile = goalOptionalEnum(subagent.profile, 'goal.subagent.profile', GOAL_SUBAGENT_PROFILES, warnings);
    const subagentMaxTurns = goalOptionalInteger(subagent.maxTurns, 'goal.subagent.maxTurns', warnings, { min: 1 });
    const subagentMaxTokens = goalOptionalInteger(subagent.maxTokens, 'goal.subagent.maxTokens', warnings, { min: 1 });
    const subagentTimeoutSeconds = goalOptionalInteger(subagent.timeoutSeconds, 'goal.subagent.timeoutSeconds', warnings, { min: 1 });
    const parsedSubagent = {
        ...(subagentProfile !== undefined ? { profile: subagentProfile } : {}),
        ...(subagentMaxTurns !== undefined ? { maxTurns: subagentMaxTurns } : {}),
        ...(subagentMaxTokens !== undefined ? { maxTokens: subagentMaxTokens } : {}),
        ...(subagentTimeoutSeconds !== undefined ? { timeoutSeconds: subagentTimeoutSeconds } : {}),
    };
    return {
        config: {
            ...(objectiveMaxChars !== undefined ? { objectiveMaxChars } : {}),
            ...(verification !== undefined ? { verification } : {}),
            budget: {
                ...(defaultTokens !== undefined ? { defaultTokens } : {}),
                ...(defaultMainTurns !== undefined ? { defaultMainTurns } : {}),
                ...(defaultActiveSeconds !== undefined ? { defaultActiveSeconds } : {}),
                graceSteps: goalInteger(budget.graceSteps, 'goal.budget.graceSteps', GOAL_CONFIG_DEFAULTS.budget.graceSteps, warnings, { min: 0, max: GOAL_CONFIG_LIMITS.budget.graceSteps }),
            },
            breaker: {
                repeatedReplyLimit: goalInteger(breaker.repeatedReplyLimit, 'goal.breaker.repeatedReplyLimit', GOAL_CONFIG_DEFAULTS.breaker.repeatedReplyLimit, warnings, { min: 1 }),
            },
            verifier: {
                repeatedNotMetLimit: goalInteger(verifier.repeatedNotMetLimit, 'goal.verifier.repeatedNotMetLimit', GOAL_CONFIG_DEFAULTS.verifier.repeatedNotMetLimit, warnings, { min: 1 }),
                evidence: goalEnum(verifier.evidence, 'goal.verifier.evidence', GOAL_VERIFICATION_EVIDENCE_MODES, GOAL_CONFIG_DEFAULTS.verifier.evidence, warnings),
            },
            evaluator: {
                modelPolicy: goalEnum(evaluator.modelPolicy, 'goal.evaluator.modelPolicy', GOAL_EVALUATOR_MODEL_POLICIES, GOAL_CONFIG_DEFAULTS.evaluator.modelPolicy, warnings),
                maxTokens: goalInteger(evaluator.maxTokens, 'goal.evaluator.maxTokens', GOAL_CONFIG_DEFAULTS.evaluator.maxTokens, warnings, { min: 1 }),
                timeoutSeconds: goalInteger(evaluator.timeoutSeconds, 'goal.evaluator.timeoutSeconds', GOAL_CONFIG_DEFAULTS.evaluator.timeoutSeconds, warnings, { min: 1 }),
                maxRetries: goalInteger(evaluator.maxRetries, 'goal.evaluator.maxRetries', GOAL_CONFIG_DEFAULTS.evaluator.maxRetries, warnings, { min: 0, max: GOAL_CONFIG_LIMITS.evaluator.maxRetries }),
            },
            ...(Object.keys(parsedSubagent).length > 0 ? { subagent: parsedSubagent } : {}),
        },
        warnings,
    };
}
function goalObject(raw, path, warnings) {
    if (raw === undefined)
        return {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        warnings.push(goalWarning(path, 'expected an object; using defaults'));
        return {};
    }
    return raw;
}
function warnUnknownKeys(raw, path, warnings, allowed) {
    for (const key of Object.keys(raw)) {
        if (!allowed.includes(key))
            warnings.push(goalWarning(`${path}.${key}`, 'unknown key ignored'));
    }
}
function goalInteger(raw, path, fallback, warnings, range) {
    if (raw == null)
        return fallback;
    if (!Number.isInteger(raw) || raw < range.min) {
        warnings.push(goalWarning(path, `expected an integer >= ${range.min}; using default`));
        return fallback;
    }
    if (range.max != null && raw > range.max) {
        warnings.push(goalWarning(path, `exceeds maximum ${range.max}; clamped`));
        return range.max;
    }
    return raw;
}
/** Parse an opt-in integer limit without inventing a fallback policy. */
function goalOptionalInteger(raw, path, warnings, range) {
    if (raw == null)
        return undefined;
    if (!Number.isInteger(raw) || raw < range.min) {
        warnings.push(goalWarning(path, `expected an integer >= ${range.min}; ignored`));
        return undefined;
    }
    if (range.max != null && raw > range.max) {
        warnings.push(goalWarning(path, `exceeds maximum ${range.max}; clamped`));
        return range.max;
    }
    return raw;
}
function goalEnum(raw, path, allowed, fallback, warnings) {
    if (raw == null)
        return fallback;
    if (typeof raw !== 'string' || !allowed.includes(raw)) {
        warnings.push(goalWarning(path, `expected one of: ${allowed.join(', ')}; using default`));
        return fallback;
    }
    return raw;
}
/**
 * Like {@link goalEnum} but with no fallback: the key is only produced when the
 * user supplied a valid value. An invalid value is reported and dropped rather
 * than silently becoming a policy the user never asked for.
 */
function goalOptionalEnum(raw, path, allowed, warnings) {
    if (raw == null)
        return undefined;
    if (typeof raw !== 'string' || !allowed.includes(raw)) {
        warnings.push(goalWarning(path, `expected one of: ${allowed.join(', ')}; ignored`));
        return undefined;
    }
    return raw;
}
function goalWarning(path, message) {
    return `Invalid goal config at ${path}: ${message}`;
}
//# sourceMappingURL=goal-config.js.map