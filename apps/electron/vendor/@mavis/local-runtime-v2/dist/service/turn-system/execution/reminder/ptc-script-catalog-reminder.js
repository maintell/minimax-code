import { carriesInWindow, prepareWindowFrozenReminder, } from './window-frozen-reminder.js';
/** @internal Exported only for focused tests. */
export const PTC_SCRIPT_CATALOG_REMINDER_CUSTOM_TYPE = 'ptc_script_catalog';
export function createPtcScriptCatalogReminder(loadCatalog, usageAnchor, onInjected) {
    return {
        async prepare({ hookInput }) {
            let lastRead;
            // Reads the mode and, only when a copy really has to be written, the
            // directories. Re-read at restore time, because both the mode and the
            // catalog can change between placing a copy and restoring it: a script
            // saved later in the same Turn belongs in the window a compaction
            // rebuilds, and a deleted one must not stay listed.
            const load = async () => {
                const catalog = await loadCatalog(hookInput.sessionId);
                if (catalog.status === 'disabled')
                    return { status: 'withdrawn' };
                const block = await catalog.load();
                lastRead = block;
                return block ? { status: 'ready', content: block.content } : { status: 'none' };
            };
            const carried = carriesInWindow(PTC_SCRIPT_CATALOG_REMINDER_CUSTOM_TYPE, hookInput.canonicalMessages);
            // A window that already carries a copy keeps it frozen without reading
            // the directories, but a Session that lost PTC still has every copy
            // withdrawn; the mode alone decides that.
            const content = carried ? statusOnly(await loadCatalog(hookInput.sessionId)) : await load();
            return prepareWindowFrozenReminder({
                customType: PTC_SCRIPT_CATALOG_REMINDER_CUSTOM_TYPE,
                content,
                loadContentWhenRestoring: load,
                hookInput,
                usageAnchor,
                // Reported only when a copy is placed: a Turn whose window already
                // carries one, or whose catalog is empty, reports nothing.
                ...(onInjected
                    ? {
                        onInjected: () => {
                            if (!lastRead)
                                return;
                            onInjected({ entries: lastRead.entries, truncated: lastRead.truncated });
                        },
                    }
                    : {}),
            });
        },
    };
}
/** What the mode alone says about a window that already carries a copy. */
function statusOnly(catalog) {
    return catalog.status === 'disabled' ? { status: 'withdrawn' } : { status: 'none' };
}
//# sourceMappingURL=ptc-script-catalog-reminder.js.map