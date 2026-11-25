import { randomUUID } from 'node:crypto';
import { ExtensionServiceError } from '../errors.js';
/** The renderer answers from its own stores at once; past this it is treated as not there. */
const EXTENSION_QUERY_TIMEOUT_MS = 2_000;
/**
 * "Runtime asks renderer, renderer answers": a query rides the extension stream, its answer comes
 * back over one route and `requestId` binds the two. Queries are short-lived and never reach the
 * user, so nothing persists and a renderer that is not there is just a timeout. A new question
 * adds an op and its optional payload structs; this is not the permission pending-record pattern.
 */
export class ExtensionQueryService {
    deps;
    pending = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    ask(input) {
        const { signal, ...query } = input;
        if (signal?.aborted)
            return Promise.resolve({ kind: 'timeout' });
        const requestId = (this.deps.makeId ?? randomUUID)();
        return new Promise((resolve) => {
            const settle = (answer) => {
                this.pending.delete(requestId);
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                resolve(answer);
            };
            const onAbort = () => settle({ kind: 'timeout' });
            const timer = setTimeout(onAbort, this.deps.timeoutMs ?? EXTENSION_QUERY_TIMEOUT_MS);
            timer.unref?.();
            signal?.addEventListener('abort', onAbort, { once: true });
            // Tracked before it is sent: an answer can never outrun its record.
            this.pending.set(requestId, { sessionId: query.sessionId, op: query.op, settle });
            this.deps.stream.emit({ type: 'query', requestId, ...query });
        });
    }
    /** The renderer's answer. Unknown, settled or foreign ids and misfit payloads leave no effect. */
    answer(input) {
        const query = this.pending.get(input.requestId);
        if (!query || query.sessionId !== input.sessionId) {
            throw new ExtensionServiceError('EXTENSION_QUERY_UNKNOWN', `EXTENSION_QUERY_UNKNOWN: no open query ${input.requestId} in session ${input.sessionId}`);
        }
        query.settle(answerOf(query.op, input));
    }
    /** The session is gone: nobody can answer its queries any more. */
    abortSession(sessionId) {
        for (const query of [...this.pending.values()]) {
            if (query.sessionId === sessionId)
                query.settle({ kind: 'timeout' });
        }
    }
}
function answerOf(op, input) {
    if (input.error !== undefined)
        return { kind: 'error', error: input.error };
    if (op === 'composer.suggest' && input.composerSuggest) {
        const { shown, reason } = input.composerSuggest;
        return { kind: op, shown, ...(reason === undefined ? {} : { reason }) };
    }
    if (op === 'composer.read' && input.composerRead) {
        return { kind: op, draft: input.composerRead.draft };
    }
    if (op === 'composer.fill' && input.composerFill) {
        const { written, reason } = input.composerFill;
        return { kind: op, written, ...(reason === undefined ? {} : { reason }) };
    }
    throw new ExtensionServiceError('EXTENSION_REQUEST_INVALID', `the answer to query ${input.requestId} carries no ${op} payload`);
}
//# sourceMappingURL=query.service.js.map