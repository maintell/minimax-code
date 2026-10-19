import { LocalPluginHookPermissionStore } from './plugin-hook-permissions.js';
/** Creates the single Plugin state owner before Turn admission and drains it after Turn shutdown. */
export function initializePluginHookPermissions(options) {
    const store = new LocalPluginHookPermissionStore({ dataDir: options.dataDir });
    const unbind = options.bind(store);
    let closePromise;
    return {
        close: () => {
            closePromise ??= (async () => {
                unbind();
                await store.close();
            })();
            return closePromise;
        },
    };
}
//# sourceMappingURL=initialize.js.map