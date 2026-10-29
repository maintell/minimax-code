import { miniAppPermissionId } from "@mavis/shared/miniapp-surface";
const MICROPHONE = miniAppPermissionId('device', 'microphone');
/**
 * Chromium grants these to an active tab without a prompt, so a page may keep them; everything
 * else Chrome would prompt for, which Electron cannot, so the gate denies it.
 */
const PROMPT_FREE_PERMISSIONS = new Set([
    'clipboard-sanitized-write',
    'fullscreen',
    'pointerLock',
    'keyboardLock',
]);
/**
 * Permission policy of the Mini App partition. Without a handler Electron grants every request
 * silently; this installs the equivalent of Chrome's prompt-or-deny for pages the Host embeds:
 * the microphone is granted only to a Mini App whose manifest declares `deviceAccess:
 * ["microphone"]` and whose `device:microphone` switch is on, read at every request so a switch
 * turned off denies the next `getUserMedia` while the page keeps running.
 *
 * The synchronous check handler answers from the last request decision. Only the plugin-detail
 * switch clears it (`revokeMicrophone`); a package update that drops `deviceAccess` leaves
 * `permissions.query` answering `granted` until the next request, which is denied.
 */
export class MiniAppDevicePermissionGate {
    constructor(options) {
        this.options = options;
        /** WebContents ids whose last microphone request was granted, with the plugin granted to. */
        this.microphoneGrants = new Map();
    }
    register(session) {
        session.setPermissionRequestHandler((webContents, permission, callback, details) => {
            void this.decideRequest(webContents, permission, details).then(callback, () => callback(false));
        });
        session.setPermissionCheckHandler((webContents, permission, _origin, details) => this.check(webContents, permission, details));
    }
    /** The user turned `device:microphone` off: later checks for this plugin's pages answer denied. */
    revokeMicrophone(pluginId) {
        for (const [webContentsId, grantedTo] of this.microphoneGrants) {
            if (grantedTo === pluginId)
                this.microphoneGrants.delete(webContentsId);
        }
    }
    async decideRequest(webContents, permission, details) {
        if (PROMPT_FREE_PERMISSIONS.has(permission))
            return true;
        if (permission !== 'media' || !details.isMainFrame)
            return false;
        const mediaTypes = details.mediaTypes;
        if (!mediaTypes?.length || mediaTypes.some((type) => type !== 'audio'))
            return false;
        const plugin = this.options.resolvePlugin(webContents);
        const granted = plugin
            ? await this.options.switches.isEnabled(plugin.pluginId, MICROPHONE)
            : false;
        if (plugin && granted)
            this.microphoneGrants.set(webContents.id, plugin.pluginId);
        else
            this.microphoneGrants.delete(webContents.id);
        return granted;
    }
    /**
     * Synchronous, so it answers from the last request decision: a page reads `granted` from
     * `navigator.permissions.query({ name: 'microphone' })` only after a granted `getUserMedia`.
     */
    check(webContents, permission, details) {
        if (PROMPT_FREE_PERMISSIONS.has(permission))
            return true;
        if (permission !== 'media' || details.mediaType !== 'audio' || !details.isMainFrame) {
            return false;
        }
        if (!webContents)
            return false;
        const grantedTo = this.microphoneGrants.get(webContents.id);
        if (grantedTo === undefined)
            return false;
        const plugin = this.options.resolvePlugin(webContents);
        if (plugin?.pluginId === grantedTo)
            return true;
        this.microphoneGrants.delete(webContents.id);
        return false;
    }
}

