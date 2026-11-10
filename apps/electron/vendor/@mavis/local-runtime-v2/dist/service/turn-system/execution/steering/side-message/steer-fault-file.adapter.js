import { readFile, rename, writeFile } from 'node:fs/promises';
/**
 * Verification-only steer fault rules, written by the verification tooling
 * into an instance's data dir and named by config `diagnostics.steerFaultFile`.
 *
 * File shape: `{ "rules": [{ "id", "kind", "session", "remaining", "fired" }] }`.
 * `session` is a Session id or `any`; `remaining` counts the deliveries the
 * rule still substitutes. Rules match in file order; each consumption is
 * written back so the tooling can read `fired` and `lastFired`.
 */
const FAULT_KINDS = new Set([
    'turn-ended',
    'closing',
    'continuation-unavailable',
    'ingress-conflict',
    'undeliverable',
]);
export function createSteerFaultFilePort(options) {
    let tail = Promise.resolve();
    return {
        consume: async (target) => {
            const filePath = options.filePath();
            if (!filePath)
                return undefined;
            // Serialize in-process consumers so one rule count is never spent twice.
            const previous = tail;
            let release;
            tail = new Promise((resolve) => {
                release = resolve;
            });
            try {
                await previous;
                return await consumeRule(filePath, target, options);
            }
            finally {
                release();
            }
        },
    };
}
async function consumeRule(filePath, target, options) {
    const document = await readDocument(filePath, options);
    const rules = Array.isArray(document?.rules) ? document.rules : [];
    const index = rules.findIndex((rule) => matches(rule, target.sessionId));
    const rule = rules[index];
    if (!document || !rule)
        return undefined;
    const nextRules = [...rules];
    nextRules[index] = {
        ...rule,
        remaining: rule.remaining - 1,
        fired: (typeof rule.fired === 'number' ? rule.fired : 0) + 1,
        lastFired: {
            sessionId: target.sessionId,
            turnId: target.turnId,
            atMs: (options.nowMs ?? Date.now)(),
        },
    };
    // A rule whose count cannot be written back must not fire, or it would fire forever.
    if (!(await writeDocument(filePath, { ...document, rules: nextRules }, options)))
        return undefined;
    return rule.kind;
}
async function readDocument(filePath, options) {
    try {
        return JSON.parse(await readFile(filePath, 'utf8'));
    }
    catch (error) {
        if (!isMissingFile(error))
            options.onError?.(error);
        return undefined;
    }
}
async function writeDocument(filePath, document, options) {
    try {
        const temporary = `${filePath}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`);
        await rename(temporary, filePath);
        return true;
    }
    catch (error) {
        options.onError?.(error);
        return false;
    }
}
function matches(rule, sessionId) {
    return (typeof rule.kind === 'string' &&
        FAULT_KINDS.has(rule.kind) &&
        typeof rule.remaining === 'number' &&
        rule.remaining > 0 &&
        (rule.session === 'any' || rule.session === sessionId));
}
function isMissingFile(error) {
    return error?.code === 'ENOENT';
}
//# sourceMappingURL=steer-fault-file.adapter.js.map