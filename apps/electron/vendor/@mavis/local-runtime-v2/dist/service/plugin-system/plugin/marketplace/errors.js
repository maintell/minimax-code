import { PluginSystemError } from '../../errors.js';
import { PluginPackageContractError } from '../package/package-contract.js';
import { PluginReaderError } from '../package/reader-errors.js';
import { GitCommandError } from '../source/git-runner.js';
/** Stable user-visible codes of user-added marketplaces. */
export const MarketplaceErrorCode = {
    SOURCE_INVALID: 'PLUGIN_MARKETPLACE_SOURCE_INVALID',
    UNREACHABLE: 'PLUGIN_MARKETPLACE_UNREACHABLE',
    REF_NOT_FOUND: 'PLUGIN_MARKETPLACE_REF_NOT_FOUND',
    REPO_EMPTY: 'PLUGIN_MARKETPLACE_REPO_EMPTY',
    MANIFEST_NOT_FOUND: 'PLUGIN_MARKETPLACE_MANIFEST_NOT_FOUND',
    MANIFEST_INVALID: 'PLUGIN_MARKETPLACE_MANIFEST_INVALID',
    NAME_INVALID: 'PLUGIN_MARKETPLACE_NAME_INVALID',
    NAME_RESERVED: 'PLUGIN_MARKETPLACE_NAME_RESERVED',
    NAME_TAKEN: 'PLUGIN_MARKETPLACE_NAME_TAKEN',
    NOT_FOUND: 'PLUGIN_MARKETPLACE_NOT_FOUND',
    /** reasonCode carries the CatalogEntryUnavailableReason. */
    ENTRY_UNAVAILABLE: 'PLUGIN_MARKETPLACE_ENTRY_UNAVAILABLE',
    /** Folder marketplaces load in place and never upgrade. */
    UPDATE_UNSUPPORTED: 'PLUGIN_MARKETPLACE_UPDATE_UNSUPPORTED',
    /** Recorded (never thrown) when a sync fails for an unclassified reason. */
    SYNC_FAILED: 'PLUGIN_MARKETPLACE_SYNC_FAILED',
    /** Reported per Plugin when removing a marketplace stops at an unclassified uninstall failure. */
    UNINSTALL_FAILED: 'PLUGIN_MARKETPLACE_UNINSTALL_FAILED',
    /** `beta.pluginMarketplaces` is off for this build; nothing was attempted. */
    DISABLED: 'PLUGIN_MARKETPLACE_DISABLED',
};
const GIT_FAILURE_CODES = {
    UNREACHABLE: MarketplaceErrorCode.UNREACHABLE,
    AUTH_REQUIRED: MarketplaceErrorCode.UNREACHABLE,
    TIMEOUT: MarketplaceErrorCode.UNREACHABLE,
    GIT_UNAVAILABLE: MarketplaceErrorCode.UNREACHABLE,
    REF_NOT_FOUND: MarketplaceErrorCode.REF_NOT_FOUND,
    REPO_EMPTY: MarketplaceErrorCode.REPO_EMPTY,
    PATH_NOT_FOUND: MarketplaceErrorCode.ENTRY_UNAVAILABLE,
};
export function marketplaceError(code, message, reasonCode) {
    return new PluginSystemError(code, message, reasonCode ? { reasonCode } : undefined);
}
/**
 * Converts git and package-reader failures into PluginSystemError codes the
 * Desktop controller already maps; the git category stays as reasonCode
 * (`AUTH_REQUIRED`, `TIMEOUT`, …) so the UI can suggest `git ls-remote`.
 */
export function normalizeMarketplaceError(error) {
    if (error instanceof GitCommandError) {
        const reason = error.category === 'PATH_NOT_FOUND' ? 'SOURCE_MISSING' : error.category;
        return marketplaceError(GIT_FAILURE_CODES[error.category], error.message, reason);
    }
    if (error instanceof PluginReaderError || error instanceof PluginPackageContractError) {
        return new PluginSystemError(error.code, error.message);
    }
    return error;
}
/** Code recorded as `lastErrorCode` and in metrics; never a message or a path. */
export function errorCodeOf(error, fallback = MarketplaceErrorCode.SYNC_FAILED) {
    const normalized = normalizeMarketplaceError(error);
    return normalized instanceof PluginSystemError ? normalized.code : fallback;
}
//# sourceMappingURL=errors.js.map