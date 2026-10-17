const SESSION_ASSET_INDEX_VERSION = 1;
export function isSessionAssetIndexCurrent(state, latestRowId) {
    return (state?.status === 'ready' &&
        state.indexVersion === SESSION_ASSET_INDEX_VERSION &&
        state.indexedThroughMessageRowId >= latestRowId);
}
//# sourceMappingURL=index-policy.js.map