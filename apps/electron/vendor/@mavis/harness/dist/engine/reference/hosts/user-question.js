const STOPPED = 'The Turn stopped before the question was answered.';
/**
 * Questions held in memory. A question the model asks with `async: true` is
 * async; every other question is sync. `await` waits once per sync question;
 * a Stop rejects the wait and releases the question.
 */
export function createInMemoryUserQuestionHost() {
    const questions = new Map();
    let sequence = 0;
    return {
        host: {
            begin: async (_ctx, input, signal) => {
                if (signal?.aborted)
                    throw new Error(STOPPED);
                sequence += 1;
                const requestId = `question-${String(sequence)}`;
                const responseMode = input.async === true ? 'async' : 'sync';
                questions.set(requestId, { responseMode, awaited: false });
                return {
                    requestId,
                    schemaVersion: 2,
                    stepCount: input.steps?.length ?? 0,
                    responseMode,
                    policyOverridden: false,
                };
            },
            await: (handle, signal) => awaitAnswer(questions, handle.requestId, signal),
        },
        answer: (requestId, content = 'answered') => {
            const question = questions.get(requestId);
            if (!question || question.outcome)
                throw new Error(`No pending question: ${requestId}`);
            question.outcome = { kind: 'answered', content };
            question.settle?.(question.outcome);
        },
        pending: () => [...questions].flatMap(([requestId, question]) => (question.outcome ? [] : [requestId])),
    };
}
async function awaitAnswer(questions, requestId, signal) {
    const question = questions.get(requestId);
    if (!question || question.responseMode !== 'sync' || question.awaited) {
        throw new Error(`ask_user ${requestId} has no sync wait to await`);
    }
    question.awaited = true;
    if (question.outcome)
        return question.outcome;
    if (signal?.aborted) {
        questions.delete(requestId);
        throw new Error(STOPPED);
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            questions.delete(requestId);
            reject(new Error(STOPPED));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        question.settle = (outcome) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(outcome);
        };
    });
}
//# sourceMappingURL=user-question.js.map