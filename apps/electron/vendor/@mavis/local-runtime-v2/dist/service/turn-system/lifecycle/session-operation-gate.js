export function createSessionOperationGate() {
    const states = new Map();
    const gate = {
        isExclusiveActive: (sessionId) => states.get(sessionId)?.mutation !== undefined,
        tryEnter: (sessionId) => {
            const state = states.get(sessionId) ?? createState();
            if (state.deleting || state.mutation)
                return undefined;
            states.set(sessionId, state);
            state.active += 1;
            let released = false;
            return {
                release: () => {
                    if (released)
                        return;
                    released = true;
                    state.active -= 1;
                    settleState(states, sessionId, state);
                },
            };
        },
        tryRun: async (sessionId, operation) => {
            const permit = gate.tryEnter(sessionId);
            if (!permit)
                return { entered: false };
            try {
                return { entered: true, value: await operation() };
            }
            finally {
                permit.release();
            }
        },
        tryAcquireExclusive: (sessionId) => {
            const state = states.get(sessionId) ?? createState();
            if (state.deleting || state.mutation)
                return undefined;
            const token = Symbol(sessionId);
            state.mutation = token;
            states.set(sessionId, state);
            const drained = sharedDrain(state);
            let released = false;
            return {
                drained,
                release: () => {
                    if (released)
                        return;
                    released = true;
                    if (state.mutation !== token) {
                        throw new Error(`Session exclusive operation lease was lost: ${sessionId}`);
                    }
                    state.mutation = undefined;
                    settleState(states, sessionId, state);
                },
            };
        },
        block: (sessionId) => {
            const state = states.get(sessionId) ?? createState();
            states.set(sessionId, state);
            state.deleting = true;
            if (state.active === 0 && !state.mutation)
                return Promise.resolve();
            state.fullDrain ??= deferred();
            return state.fullDrain.promise;
        },
        release: (sessionId) => {
            const state = states.get(sessionId);
            if (!state)
                return;
            if (state.active !== 0 || state.mutation) {
                throw new Error(`Session operation gate released while active: ${sessionId}`);
            }
            state.deleting = false;
            settleState(states, sessionId, state);
        },
    };
    return gate;
}
function createState() {
    return { active: 0, deleting: false };
}
function sharedDrain(state) {
    if (state.active === 0)
        return Promise.resolve();
    state.sharedDrain ??= deferred();
    return state.sharedDrain.promise;
}
function settleState(states, sessionId, state) {
    if (state.active === 0) {
        state.sharedDrain?.resolve();
        state.sharedDrain = undefined;
        if (!state.mutation) {
            state.fullDrain?.resolve();
            state.fullDrain = undefined;
        }
    }
    if (state.active === 0 && !state.deleting && !state.mutation && states.get(sessionId) === state) {
        states.delete(sessionId);
    }
}
function deferred() {
    let resolve;
    const promise = new Promise((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
}
//# sourceMappingURL=session-operation-gate.js.map