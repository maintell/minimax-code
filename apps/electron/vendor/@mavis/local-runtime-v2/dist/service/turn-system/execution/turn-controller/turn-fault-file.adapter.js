import { readFile, rename, writeFile } from 'node:fs/promises';
const TURN_FAULT_KINDS = new Set([
    'hold-before-history',
    'hold-ignore-abort',
]);
/** A hold that is never aborted or released ends here and the Turn goes on. */
export const TURN_FAULT_HOLD_CAP_MS = 300_000;
/** How often a `hold-ignore-abort` hold reads the file for its release. */
const RELEASE_POLL_MS = 200;
/** The late assistant text of a released `hold-ignore-abort` rule without its own. */
const TURN_FAULT_LATE_TEXT = 'TURN-FAULT-LATE';
export function createTurnFaultFilePort(options) {
    let tail = Promise.resolve();
    const consume = async (sessionId) => {
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
            return await consumeRule(filePath, sessionId, options);
        }
        finally {
            release();
        }
    };
    return {
        holdBeforeHistory: async ({ sessionId, signal }) => {
            if (signal.aborted)
                return undefined;
            const fired = await consume(sessionId);
            if (!fired)
                return undefined;
            const capMs = options.holdCapMs ?? TURN_FAULT_HOLD_CAP_MS;
            if (fired.kind !== 'hold-ignore-abort') {
                await waitForAbort(signal, capMs);
                return undefined;
            }
            const released = await waitForRelease(fired, options, capMs);
            return released ? { lateText: fired.lateText ?? TURN_FAULT_LATE_TEXT } : undefined;
        },
    };
}
async function consumeRule(filePath, sessionId, options) {
    const document = await readDocument(filePath, options);
    const rules = Array.isArray(document?.rules) ? document.rules : [];
    const index = rules.findIndex((rule) => matches(rule, sessionId));
    const rule = rules[index];
    if (!document || !rule)
        return undefined;
    const nextRules = [...rules];
    nextRules[index] = {
        ...rule,
        remaining: rule.remaining - 1,
        fired: (typeof rule.fired === 'number' ? rule.fired : 0) + 1,
        lastFired: (options.nowMs ?? Date.now)(),
    };
    // A rule whose count cannot be written back must not fire, or it would fire forever.
    if (!(await writeDocument(filePath, { ...document, rules: nextRules }, options)))
        return undefined;
    return {
        filePath,
        id: rule.id,
        kind: rule.kind,
        ...(typeof rule.lateText === 'string' ? { lateText: rule.lateText } : {}),
    };
}
/** Polls the file until the rule says `released`; false when the cap passes first. */
async function waitForRelease(fired, options, capMs) {
    const nowMs = options.nowMs ?? Date.now;
    const deadline = nowMs() + capMs;
    const pollMs = options.releasePollMs ?? RELEASE_POLL_MS;
    while (nowMs() < deadline) {
        const document = await readDocument(fired.filePath, options);
        const rules = Array.isArray(document?.rules) ? document.rules : [];
        if (rules.some((rule) => rule.id === fired.id && rule.released === true))
            return true;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return false;
}
function waitForAbort(signal, capMs) {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, capMs);
        signal.addEventListener('abort', done, { once: true });
    });
}
async function readDocument(filePath, options) {
    try {
        return JSON.parse(await readFile(filePath, 'utf8'));
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
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
        TURN_FAULT_KINDS.has(rule.kind) &&
        typeof rule.remaining === 'number' &&
        rule.remaining > 0 &&
        (rule.session === 'any' || rule.session === sessionId));
}
//# sourceMappingURL=turn-fault-file.adapter.js.map