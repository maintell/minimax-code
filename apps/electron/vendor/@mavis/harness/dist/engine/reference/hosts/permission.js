import { canonicalJson } from '../conformance-case.js';
const ABORTED = 'The permission update was aborted.';
/**
 * Permissions held in memory. A Session rule added through `mutations` wins
 * over the configured rule for the same tool; a tool without any rule asks.
 * `mutations` applies whole-tool `addRules` updates for the Session only and
 * rejects any other batch. A Mini App root has no listener here, so its
 * prompts are denied; an aborted prompt resolves `deny`.
 */
export function createInMemoryPermissionHost(options = {}) {
    const sessionRules = new Map();
    const prompts = [];
    const grants = new Map();
    const sideSessions = new Set();
    const configured = new Map(Object.entries(options.rules ?? {}));
    return {
        host: {
            decisions: {
                check: async ({ sessionId, toolName }) => decide(toolName, sessionRules.get(sessionId)?.get(toolName), configured.get(toolName)),
            },
            approval: { request: async ({ signal }) => prompt(prompts, signal) },
            executionPlans: { snapshotInput: snapshot, validate: validatePlan },
            mutations: {
                applyAtomic: async ({ sessionId, updates, signal }) => {
                    if (signal?.aborted)
                        throw new Error(ABORTED);
                    addSessionRules(sessionRules, sessionId, updates);
                },
                clearSession: async (sessionId) => {
                    sessionRules.delete(sessionId);
                },
            },
            resolveSessionOwnedReadablePaths: async (sessionId) => [...(grants.get(sessionId) ?? [])],
            sideSessions: { isSideSession: async (sessionId) => sideSessions.has(sessionId) },
            miniAppApprovals: {
                shouldDenyApproval: async (_sessionId, lineage) => lineage?.miniApp === true,
            },
        },
        reply: (decision) => {
            const settle = prompts.shift();
            if (!settle)
                throw new Error('No approval prompt is pending.');
            settle(decision);
        },
        pending: () => prompts.length,
        grantReadable: (sessionId, path) => {
            grants.set(sessionId, [...(grants.get(sessionId) ?? []), path]);
        },
        markSideSession: (sessionId) => {
            sideSessions.add(sessionId);
        },
    };
}
function decide(toolName, sessionRule, configuredRule) {
    if (sessionRule)
        return verdict(sessionRule, `A Session rule sets ${toolName} to ${sessionRule}.`, toolName);
    if (configuredRule)
        return verdict(configuredRule, `A rule sets ${toolName} to ${configuredRule}.`, toolName);
    return verdict('ask', `No rule covers ${toolName}.`, toolName);
}
function verdict(behavior, reason, toolName) {
    if (behavior !== 'ask')
        return { behavior, reason };
    return { behavior, reason, ruleContents: [toolName], ruleMatchers: [{ kind: 'tool' }] };
}
function prompt(prompts, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve('deny');
            return;
        }
        const onAbort = () => {
            prompts.splice(prompts.indexOf(settle), 1);
            resolve('deny');
        };
        const settle = (decision) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(decision);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        prompts.push(settle);
    });
}
function isSessionToolRule(update) {
    return (update.type === 'addRules' &&
        update.destination === 'session' &&
        update.rules.every((rule) => rule.ruleContent === undefined));
}
function addSessionRules(sessionRules, sessionId, updates) {
    if (!updates.every(isSessionToolRule)) {
        throw new Error('The in-memory permission host applies only whole-tool Session addRules.');
    }
    const rules = sessionRules.get(sessionId) ?? new Map();
    for (const update of updates) {
        for (const rule of update.rules)
            rules.set(rule.toolName, update.behavior);
    }
    sessionRules.set(sessionId, rules);
}
function snapshot(input) {
    return deepFreeze(structuredClone(input));
}
function deepFreeze(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value))
            deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
function validatePlan(plan, originalInput) {
    if (!isExecutionPlan(plan))
        throw new TypeError('A permission execution plan is malformed.');
    if (canonicalJson(plan.originalInput) !== canonicalJson(originalInput)) {
        throw new TypeError('The execution plan was made for another tool input.');
    }
    return deepFreeze(structuredClone(plan));
}
function isExecutionPlan(plan) {
    if (!isRecord(plan))
        return false;
    return (isRecord(plan.originalInput) &&
        isRecord(plan.effectiveInput) &&
        Array.isArray(plan.intents) &&
        Array.isArray(plan.transforms));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=permission.js.map