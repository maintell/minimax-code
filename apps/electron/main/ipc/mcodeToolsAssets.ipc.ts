import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../config/constants";
import { downloadSpacePreviewFile, getSpaceAssetsStatus, uploadSpaceAsset, statSpaceAsset } from "../modules/space/assets";
import { SpacePreviewStaging } from "../modules/space/preview-staging";
import logger from "../utils/logger";
import { trustedHost } from "./miniAppComposer.ipc";
const UNTRUSTED = { ok: false, code: 'UNTRUSTED_SENDER', message: 'Untrusted sender' };
const INVALID = { ok: false, code: 'INVALID_ARGUMENT', message: 'Invalid arguments' };
function optionalString(value) {
    return value === undefined || (typeof value === 'string' && value.length > 0);
}
function isUploadInput(value) {
    if (!value || typeof value !== 'object')
        return false;
    const input = value;
    return (typeof input.localPath === 'string' &&
        input.localPath.length > 0 &&
        optionalString(input.to) &&
        optionalString(input.id) &&
        (input.onConflict === undefined || input.onConflict === 'fail' || input.onConflict === 'rename'));
}
function isStatInput(value) {
    if (!value || typeof value !== 'object')
        return false;
    const input = value;
    return typeof input.path === 'string' && input.path.length > 0;
}
/**
 * Main-owned copies for read-only previews of Space files (document-preview `driveNodeId`
 * claims), downloaded with the same shared Desktop session as manual uploads.
 */
export function createSpacePreviewStaging(deps) {
    return new SpacePreviewStaging({
        download: async (input) => {
            const result = await downloadSpacePreviewFile(input, deps);
            if (!result.ok)
                logger.warn(`[space] preview download failed code=${result.code}`);
            return result.ok ? { fileName: result.output.fileName } : { failureCode: result.code };
        },
        onCleanupError: () => logger.warn('[space] failed to remove a preview copy'),
    });
}
/**
 * Manual Space uploads from the file panel. The channel and renderer API keep their
 * `mcodeTools` names; the work runs in the Space core (see modules/space/assets).
 */
export function setupMcodeToolsAssetsIPC(deps) {
    ipcMain.handle(IPC_CHANNELS.MCODE_TOOLS_ASSETS_STATUS, (event) => {
        if (!trustedHost(event))
            return { available: false };
        return getSpaceAssetsStatus(deps);
    });
    ipcMain.handle(IPC_CHANNELS.MCODE_TOOLS_ASSETS_UPLOAD, (event, value) => {
        if (!trustedHost(event))
            return UNTRUSTED;
        if (!isUploadInput(value))
            return INVALID;
        return uploadSpaceAsset({
            localPath: value.localPath,
            to: value.to,
            id: value.id,
            onConflict: value.onConflict,
        }, deps);
    });
    ipcMain.handle(IPC_CHANNELS.MCODE_TOOLS_ASSETS_STAT, (event, value) => {
        if (!trustedHost(event))
            return UNTRUSTED;
        if (!isStatInput(value))
            return INVALID;
        return statSpaceAsset({ path: value.path }, deps);
    });
}
