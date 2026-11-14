import { currentBetaResolutionContext, resolveBetaFeature } from '@mavis/config';
import { createPtcStoreTempFiles } from '../../sandbox/index.js';
import { PtcSessionStore, } from '../agent-host/execution/ptc/session-store/index.js';
/**
 * Whether this build ships PTC `store` / `load` (`beta.ptcStore`). A product config
 * carries the value it resolved for its package; one without it (a bare runtime config)
 * resolves for this process, the same way `getConfig()` would.
 */
function isPtcSessionStoreEnabled(config) {
    // Same read as the runtime's `beta.ptcScripts` switch: the configured value when
    // the config carries one, this build's default otherwise.
    return resolveBetaFeature('ptcStore', config.beta?.ptcStore, currentBetaResolutionContext());
}
/**
 * The one `beta.ptcStore` decision a runtime assembly makes, resolved on first read
 * and fixed from then on.
 *
 * `getConfig()` re-parses when config.yaml's signature changes, so a per-Turn read
 * would let an edit without a restart promise a store the Host — assembled once at
 * startup — does not have, and would move a live Session's request prefix. The
 * runtime passes this one getter to both the Agent Host and the config builder, so
 * the store and the prompt line that names it can never disagree.
 */
export function createPtcStoreDecision(config) {
    let decided;
    return () => {
        decided ??= isPtcSessionStoreEnabled(config);
        return decided;
    };
}
/**
 * Whether this Host owns a PTC store: the runtime's own decision when the assembly
 * passed one (the production path, shared with the prompt), otherwise this config's
 * build default.
 */
function hostPtcStoreEnabled(preparation, configBuilder) {
    return preparation.ptcStoreRequested
        ? preparation.ptcStoreRequested()
        : isPtcSessionStoreEnabled(configBuilder.config());
}
/**
 * Everything one Host wires for PTC: the session store it owns when
 * `beta.ptcStore` is on, and the saved-script pieces the Turn System resolved
 * for `beta.ptcScripts`.
 *
 * The store decision is the runtime's own (see {@link createPtcStoreDecision}),
 * read once at assembly and shared with the prompt, so the store and the line
 * that names it cannot disagree. The script side is already a resolved value
 * here: the Turn System read that switch once too, and wired nothing when it
 * was off, which is what `ptcScripts` being absent means.
 */
export function createHostPtcWiring(options) {
    const logger = options.product.runner.logger;
    const files = options.storeFiles;
    const store = createHostPtcSessionStore(options.sessions, {
        ...(logger ? { logger } : {}),
        ...(files ? { files } : {}),
        enabled: hostPtcStoreEnabled(options.preparation, options.product.preparation.configBuilder),
    });
    const sessionStore = store.store;
    return {
        store,
        catalog: {
            ...(sessionStore ? { ptcSessionStore: sessionStore } : {}),
            ...(options.ptcScripts ? { ptcScripts: options.ptcScripts } : {}),
        },
        executor: {
            ...(sessionStore ? { ptcSessionStore: sessionStore } : {}),
            // The host wired no script support when `beta.ptcScripts` is off, which is
            // exactly what the `ptc admission` line reports.
            ptcScriptsEnabled: options.ptcScripts !== undefined,
        },
    };
}
/**
 * The PTC session store one Host owns: the values its programs `store` and
 * `load`. The temp files are this Host's own, so its directory is removed when
 * the runtime closes. An abandoned one is not swept at startup either: it goes
 * away the next time any runtime initializes a temp directory under the shared
 * root, and only once its owner process has exited and it is more than 24
 * hours old. They stay behind this object: the Host composition sees the store
 * and the lifecycle it has to wrap, never the files.
 *
 * With `beta.ptcStore` off there is nothing to own: no temp files are created, no
 * store exists, and `bindLifecycle` hands the lifecycle straight back.
 */
function createHostPtcSessionStore(sessions, options) {
    if (!options.enabled)
        return { bindLifecycle: (lifecycle) => lifecycle };
    const { logger } = options;
    const files = options.files ?? createPtcStoreTempFiles();
    const store = new PtcSessionStore({
        files,
        ...(logger ? { logger } : {}),
        // A rewind deletes message rows from the target onward, so the Turn ids
        // still on the Session's rows are exactly the ones its history kept.
        readLiveTurnIds: async (sessionId) => {
            const { messages } = await sessions.messages.repository.list(sessionId);
            return new Set(messages.flatMap((message) => (message.turnId ? [message.turnId] : [])));
        },
        readForkExcludedTurnIds: async ({ sessionId, throughAssistantMessageId }) => {
            const { messages } = await sessions.messages.repository.list(sessionId);
            const excluded = forkExcludedTurnIds(messages, throughAssistantMessageId);
            if (excluded === undefined) {
                warn(logger, {
                    session_id: sessionId,
                    through_assistant_message_id: throughAssistantMessageId,
                }, 'ptc session store could not locate the fork boundary message');
                return new Set();
            }
            return excluded;
        },
    });
    return {
        store,
        bindLifecycle: (lifecycle) => withPtcSessionStoreLifecycle(lifecycle, store, files, logger),
    };
}
/**
 * The Turn a Fork cut in half, or an empty set when the boundary sits on a
 * Turn edge. Undefined when the boundary message is not in the Session's rows,
 * which the caller reports rather than guessing.
 *
 * A Fork that stops at a canonical Assistant message keeps the child's history
 * up to that message. When the same Turn has rows after it in the source, the
 * child never received them, so the values that Turn's programs stored after
 * the boundary are not part of the child's history: the whole Turn is left out
 * rather than half of it.
 *
 * @internal Exported for focused tests.
 */
export function forkExcludedTurnIds(messages, throughAssistantMessageId) {
    const boundaryIndex = messages.findIndex((message) => message.canonical_message_id === throughAssistantMessageId ||
        message.msg_id === throughAssistantMessageId);
    if (boundaryIndex < 0)
        return undefined;
    const boundaryTurnId = messages[boundaryIndex]?.turnId;
    if (!boundaryTurnId)
        return undefined;
    const cutInHalf = messages
        .slice(boundaryIndex + 1)
        .some((message) => message.turnId === boundaryTurnId);
    return cutInHalf ? new Set([boundaryTurnId]) : new Set();
}
/**
 * The Host lifecycle with the store's own cleanup: Session deletion also drops
 * that Session's stored values, and closing the runtime removes the whole temp
 * tree they live in.
 *
 * Both cleanups are best-effort. The store is an optional capability: losing a
 * Session's stored values is recoverable, refusing to delete the Session or to
 * close the runtime is not. A failure is reported with the Session id and the
 * error, and the operation it belongs to still finishes.
 */
function withPtcSessionStoreLifecycle(lifecycle, store, files, logger) {
    return {
        ...lifecycle,
        disposeSession: async (sessionId) => {
            await lifecycle.disposeSession(sessionId);
            try {
                await store.deleteSession(sessionId);
            }
            catch (error) {
                warn(logger, { session_id: sessionId, error: describeError(error) }, STORE_CLEANUP_FAILED);
            }
        },
        close: async () => {
            try {
                await files.close();
            }
            catch (error) {
                warn(logger, { error: describeError(error) }, TEMP_CLEANUP_FAILED);
            }
        },
    };
}
const STORE_CLEANUP_FAILED = 'ptc session store cleanup failed during session disposal';
const TEMP_CLEANUP_FAILED = 'ptc session store temp cleanup failed during runtime close';
function describeError(error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
function warn(logger, fields, message) {
    try {
        logger?.warn?.(fields, message);
    }
    catch {
        // A failing logger cannot report itself; the cleanup must not depend on it.
    }
}
//# sourceMappingURL=ptc-session-store-composition.js.map