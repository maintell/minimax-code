import { parseMiniAppPermissionId, isMiniAppDeviceAccessItem, miniAppPermissionId, MINIAPP_DEVICE_ACCESS_ITEMS } from "@mavis/shared/miniapp-surface";
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
 * the microphone, the camera and notifications are granted only to a Mini App whose manifest
 * declares that `deviceAccess` item and whose `device:<item>` switch is on.
 *
 * Requests (`getUserMedia`, `Notification.requestPermission()`, every `new Notification()`) read
 * the switches at each call, so a switch turned off denies the next one while the page keeps
 * running. A request for audio and video together needs both switches on.
 *
 * Electron's check handler is synchronous and has no "not asked yet" answer, so checks
 * (`permissions.query`, `Notification.permission`, and the gate Chromium consults before showing
 * a notification) answer from a per-plugin snapshot of the last successful switch read: `load`
 * before a launch is opened and every request, kept in step by `applySwitch`. A failed read
 * leaves the snapshot as it was.
 */
export class MiniAppDevicePermissionGate {
    constructor(options) {
        this.options = options;
        /** Declared device items whose switch is on, per plugin, as of the last successful read. */
        this.enabledDevices = new Map();
        /** WebContents ids whose last microphone request was granted, with the plugin granted to. */
        this.microphoneGrants = new Map();
        /** One in-flight request per page; a newer request, navigation or switch-off supersedes it. */
        this.pendingRequests = new Map();
    }
    register(session) {
        session.setPermissionRequestHandler((webContents, permission, callback, details) => {
            void this.decideRequest(webContents, permission, details).then(callback, () => callback(false));
        });
        session.setPermissionCheckHandler((webContents, permission, _origin, details) => this.check(webContents, permission, details));
    }
    /** Reads one Mini App's device switches; called before its page loads so its first check holds. */
    async load(pluginId) {
        try {
            this.remember(pluginId, await this.options.switches.enabledPermissions(pluginId));
        }
        catch {
            // Unreachable: checks keep the last known answer (denied when never read).
        }
    }
    /** The page's document ended (navigation, crash, rebuild); its grant and in-flight request go. */
    forgetPage(webContentsId) {
        this.microphoneGrants.delete(webContentsId);
        this.pendingRequests.delete(webContentsId);
    }
    hasPendingRequest(webContentsId) {
        return this.pendingRequests.has(webContentsId);
    }
    hasMicrophoneGrant(webContentsId) {
        return this.microphoneGrants.has(webContentsId);
    }
    /** The user switched one permission in the plugin detail; Utility has already stored it. */
    applySwitch(pluginId, permission, enabled) {
        const loaded = this.enabledDevices.get(pluginId);
        const parsed = parseMiniAppPermissionId(permission);
        const item = parsed?.domain === 'device' ? parsed.item : undefined;
        if (!enabled && isMiniAppDeviceAccessItem(item))
            this.revokePages(pluginId, item);
        // Not loaded yet: the next `load` reads the stored switch.
        if (!loaded || !isMiniAppDeviceAccessItem(item))
            return;
        const next = new Set(loaded);
        if (enabled)
            next.add(item);
        else
            next.delete(item);
        this.enabledDevices.set(pluginId, next);
    }
    async decideRequest(webContents, permission, details) {
        if (PROMPT_FREE_PERMISSIONS.has(permission))
            return true;
        if (!details.isMainFrame)
            return false;
        const items = requestedDeviceItems(permission, details);
        if (!items)
            return false;
        const plugin = this.options.resolvePlugin(webContents);
        if (!plugin) {
            this.forgetPage(webContents.id);
            return false;
        }
        const token = Symbol('device-request');
        this.pendingRequests.set(webContents.id, { token, pluginId: plugin.pluginId });
        try {
            const enabled = await this.options.switches.enabledPermissions(plugin.pluginId);
            this.remember(plugin.pluginId, enabled);
            // Same-origin navigation may keep the WebContents and plugin identity;
            // forgetPage/applySwitch must still fence the old document's async decision.
            if (this.pendingRequests.get(webContents.id)?.token !== token)
                return false;
            const granted = items.every((item) => enabled.has(miniAppPermissionId('device', item))) &&
                this.options.resolvePlugin(webContents)?.pluginId === plugin.pluginId;
            if (granted && items.includes('microphone')) {
                this.microphoneGrants.set(webContents.id, plugin.pluginId);
            }
            else if (items.includes('microphone')) {
                this.microphoneGrants.delete(webContents.id);
            }
            return granted;
        }
        finally {
            if (this.pendingRequests.get(webContents.id)?.token === token)
                this.pendingRequests.delete(webContents.id);
        }
    }
    /** A switch turned off: in-flight requests of that plugin fail, and a revoked mic grant goes. */
    revokePages(pluginId, item) {
        for (const [id, request] of this.pendingRequests) {
            if (request.pluginId === pluginId)
                this.pendingRequests.delete(id);
        }
        if (item !== 'microphone')
            return;
        for (const [id, grantedTo] of this.microphoneGrants) {
            if (grantedTo === pluginId)
                this.microphoneGrants.delete(id);
        }
    }
    remember(pluginId, enabled) {
        this.enabledDevices.set(pluginId, new Set(MINIAPP_DEVICE_ACCESS_ITEMS.filter((item) => enabled.has(miniAppPermissionId('device', item)))));
    }
    check(webContents, permission, details) {
        if (PROMPT_FREE_PERMISSIONS.has(permission))
            return true;
        if (!details.isMainFrame)
            return false;
        const item = permission === 'notifications'
            ? 'notifications'
            : permission === 'media'
                ? mediaTypeItem(details.mediaType)
                : null;
        if (!item)
            return false;
        const plugin = this.options.resolvePlugin(webContents);
        return plugin ? this.enabledDevices.get(plugin.pluginId)?.has(item) === true : false;
    }
}

/** The `deviceAccess` items one request needs, each its own switch; null for anything else. */
function requestedDeviceItems(permission, details) {
    if (permission === 'notifications')
        return ['notifications'];
    if (permission !== 'media')
        return null;
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    if (!mediaTypes?.length)
        return null;
    const items = new Set();
    for (const type of mediaTypes) {
        const item = mediaTypeItem(type);
        if (!item)
            return null;
        items.add(item);
    }
    return [...items];
}
/** The `deviceAccess` item a `getUserMedia` media type needs. */
function mediaTypeItem(type) {
    if (type === 'audio')
        return 'microphone';
    if (type === 'video')
        return 'camera';
    return null;
}
