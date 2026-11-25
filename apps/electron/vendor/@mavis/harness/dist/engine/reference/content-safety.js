const VERDICTS = Object.freeze({
    pass: Object.freeze({ kind: 'pass' }),
    violation: Object.freeze({ kind: 'block', reason: 'in-memory review violation' }),
    'api-error': Object.freeze({ kind: 'unavailable', cause: 'upstream' }),
});
export function createInMemoryContentSafety(initial = 'pass') {
    let current = initial;
    const requests = [];
    return {
        check: async (input, signal) => {
            requests.push(input);
            if (current === 'hang')
                return await unanswered(signal);
            return VERDICTS[current];
        },
        answer: (next) => {
            current = next;
        },
        requests,
    };
}
/** A review that never answers; it rejects with the signal reason once the check aborts. */
async function unanswered(signal) {
    return await new Promise((_resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}
//# sourceMappingURL=content-safety.js.map