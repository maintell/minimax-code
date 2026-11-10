export function isRuntimeNetworkServiceGoneMessage(message) {
    return (typeof message === 'object' &&
        message !== null &&
        message.type === 'runtime-network-service-gone');
}
/**
 * Electron `net` fetch that can be switched once to Node fetch (undici, with
 * the fork-time proxy env and system CA) for the rest of this utility process.
 * A refork starts on Electron `net` again.
 */
export function createNetworkServiceAwareFetch(electronFetch, createNodeFetch) {
    let current = electronFetch;
    let nodeFetch = null;
    let switched = false;
    return {
        fetch: ((input, init) => current(input, init)),
        fallbackToNodeFetch: () => {
            if (switched)
                return false;
            switched = true;
            nodeFetch = createNodeFetch();
            current = nodeFetch?.fetch ?? globalThis.fetch.bind(globalThis);
            return true;
        },
        close: async () => {
            await nodeFetch?.close();
        },
    };
}
