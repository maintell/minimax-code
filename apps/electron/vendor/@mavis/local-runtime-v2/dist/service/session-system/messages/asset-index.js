import { replaceMessageAssets as replaceMessageAssetsInRepository } from '../files/repo/assets.js';
/** Message-owned transaction helper backed by the target Files asset DAO/schema. */
export function replaceMessageAssets(db, sessionId, message, nowMs) {
    replaceMessageAssetsInRepository(db, sessionId, message, nowMs);
}
//# sourceMappingURL=asset-index.js.map