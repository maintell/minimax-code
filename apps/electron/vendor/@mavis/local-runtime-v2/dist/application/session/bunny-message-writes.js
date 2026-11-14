import { createBunnyStoreSearchSpaceLinks, storedMediaDescriptions, } from '../../service/bunny/index.js';
import { createMessageSearchIndexObserver, } from '../../service/session-system/index.js';
/**
 * Bunny's message write observers: the conversation search index of its main
 * conversation (spec 15.1), kept in the shared database inside each message
 * write's transaction. The observer only sees Bunny's Sessions, so the writes
 * of every other Session never reach it.
 */
export function bunnyMessageWriteObservers(bunnyDb) {
    return [
        createMessageSearchIndexObserver({
            spaces: createBunnyStoreSearchSpaceLinks(bunnyDb),
            descriptions: storedMediaDescriptions(bunnyDb),
        }),
    ];
}
//# sourceMappingURL=bunny-message-writes.js.map