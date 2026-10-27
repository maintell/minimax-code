/** Renderer-safe device choices. Browser identity overrides are owned by Electron main. */
export const BROWSER_PREVIEW_DEVICES = [
    {
        id: 'qhd-desktop',
        group: 'desktop',
        name: 'QHD',
        width: 2560,
        height: 1440,
        dpr: 1,
        touch: false,
        mobile: false,
        identity: 'native',
    },
    {
        id: 'laptop-l',
        group: 'desktop',
        name: 'Laptop L',
        width: 1440,
        height: 900,
        dpr: 1,
        touch: false,
        mobile: false,
        identity: 'native',
    },
    {
        id: 'laptop',
        group: 'desktop',
        name: 'Laptop',
        width: 1024,
        height: 768,
        dpr: 1,
        touch: false,
        mobile: false,
        identity: 'native',
    },
    {
        id: 'surface-pro-7',
        group: 'tablet',
        name: 'Surface Pro 7',
        width: 912,
        height: 1368,
        dpr: 2,
        touch: true,
        mobile: false,
        identity: 'windows',
    },
    {
        id: 'ipad-air',
        group: 'tablet',
        name: 'iPad Air',
        width: 820,
        height: 1180,
        dpr: 2,
        touch: true,
        mobile: true,
        identity: 'ipad',
    },
    {
        id: 'ipad-mini',
        group: 'tablet',
        name: 'iPad Mini',
        width: 768,
        height: 1024,
        dpr: 2,
        touch: true,
        mobile: true,
        identity: 'ipad',
    },
    {
        id: 'surface-duo',
        group: 'tablet',
        name: 'Surface Duo',
        width: 540,
        height: 720,
        dpr: 2.5,
        touch: true,
        mobile: true,
        identity: 'android',
    },
    {
        id: 'iphone-15-pro-max',
        group: 'phone',
        name: 'iPhone 15 Pro Max',
        width: 430,
        height: 932,
        dpr: 3,
        touch: true,
        mobile: true,
        identity: 'iphone',
    },
    {
        id: 'pixel-8',
        group: 'phone',
        name: 'Pixel 8',
        width: 412,
        height: 915,
        dpr: 2.625,
        touch: true,
        mobile: true,
        identity: 'android',
    },
    {
        id: 'iphone-15-pro',
        group: 'phone',
        name: 'iPhone 15 Pro',
        width: 393,
        height: 852,
        dpr: 3,
        touch: true,
        mobile: true,
        identity: 'iphone',
    },
    {
        id: 'galaxy-s24-ultra',
        group: 'phone',
        name: 'Samsung Galaxy S24 Ultra',
        width: 384,
        height: 832,
        dpr: 3.75,
        touch: true,
        mobile: true,
        identity: 'android',
    },
    {
        id: 'iphone-se',
        group: 'phone',
        name: 'iPhone SE',
        width: 375,
        height: 667,
        dpr: 2,
        touch: true,
        mobile: true,
        identity: 'iphone',
    },
];
export function isBrowserPreviewScope(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const raw = value;
    return (Object.keys(raw).length === 2 &&
        Object.prototype.hasOwnProperty.call(raw, 'kind') &&
        Object.prototype.hasOwnProperty.call(raw, 'source') &&
        raw.kind === 'local' &&
        raw.source === 'local');
}
export function isBrowserPreviewLayout(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const raw = value;
    const pair = (candidate, keys, positive) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
            return false;
        const fields = candidate;
        return (Object.keys(fields).length === keys.length &&
            keys.every((key) => Object.prototype.hasOwnProperty.call(fields, key) &&
                typeof fields[key] === 'number' &&
                Number.isFinite(fields[key]) &&
                Math.abs(fields[key]) <= 30000 &&
                (!positive || fields[key] > 0)));
    };
    return (Object.keys(raw).length === 2 &&
        Object.prototype.hasOwnProperty.call(raw, 'offset') &&
        Object.prototype.hasOwnProperty.call(raw, 'available') &&
        pair(raw.offset, ['x', 'y'], false) &&
        pair(raw.available, ['width', 'height'], true));
}
export const BROWSER_PREVIEW_SIZE_LIMITS = {
    minWidth: 240,
    maxWidth: 4096,
    minHeight: 160,
    maxHeight: 4096,
};
export function getBrowserPreviewDevice(id) {
    return BROWSER_PREVIEW_DEVICES.find((device) => device.id === id);
}
export function createBrowserDevicePreviewState() {
    return {
        enabled: false,
        selection: 'responsive',
        identityPreset: 'native',
        viewport: null,
        orientation: 'portrait',
        displayScale: 'fit',
        lastCustom: null,
    };
}
export function cloneBrowserDevicePreviewState(state) {
    return {
        ...state,
        viewport: state.viewport ? { ...state.viewport } : null,
        lastCustom: state.lastCustom
            ? { ...state.lastCustom, viewport: { ...state.lastCustom.viewport } }
            : null,
    };
}
/** Preserve an untouched rotated dimension; edited axes still obey manual input limits. */
export function isBrowserPreviewSizeUpdate(size, previous) {
    const limits = BROWSER_PREVIEW_SIZE_LIMITS;
    return (Number.isInteger(size.width) &&
        Number.isInteger(size.height) &&
        (size.width >= limits.minWidth || size.width === previous?.width) &&
        (size.height >= limits.minHeight || size.height === previous?.height) &&
        size.width <= limits.maxWidth &&
        size.height <= limits.maxHeight);
}
function validSize(width, height) {
    const limits = BROWSER_PREVIEW_SIZE_LIMITS;
    return (typeof width === 'number' &&
        Number.isInteger(width) &&
        // Admit an exact rotated width below the manual minimum; main checks the edited axis.
        width >= Math.min(limits.minWidth, limits.minHeight) &&
        width <= limits.maxWidth &&
        typeof height === 'number' &&
        Number.isInteger(height) &&
        height >= limits.minHeight &&
        height <= limits.maxHeight);
}
/** Reject unknown fields as well as arbitrary UA, DPR, metrics and scale values. */
export function isBrowserDevicePreviewRequest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const request = value;
    const only = (...keys) => Object.keys(request).length === keys.length &&
        Object.keys(request).every((key) => keys.includes(key));
    switch (request.type) {
        case 'open':
        case 'close':
        case 'rotate':
            return only('type');
        case 'select':
            return (only('type', 'selection') &&
                typeof request.selection === 'string' &&
                (request.selection === 'responsive' ||
                    request.selection === 'custom' ||
                    Boolean(getBrowserPreviewDevice(request.selection))));
        case 'resize':
            return only('type', 'width', 'height') && validSize(request.width, request.height);
        case 'scale':
            return (only('type', 'scale') &&
                ['fit', 0.5, 0.75, 1].includes(request.scale));
        default:
            return false;
    }
}
function orientation(size) {
    return size.width > size.height ? 'landscape' : 'portrait';
}
/** Shared UI prediction and main-process transition; callers serialize requests per tab. */
export function reduceBrowserDevicePreview(previous, request) {
    if (!isBrowserDevicePreviewRequest(request))
        throw new Error('INVALID_DEVICE_PREVIEW_REQUEST');
    const state = cloneBrowserDevicePreviewState(previous);
    switch (request.type) {
        case 'open':
            state.enabled = true;
            break;
        case 'close':
            state.enabled = false;
            break;
        case 'scale':
            state.displayScale = request.scale;
            break;
        case 'select': {
            if (request.selection === 'custom') {
                if (!state.lastCustom)
                    throw new Error('DEVICE_PREVIEW_CUSTOM_UNAVAILABLE');
                state.identityPreset = state.lastCustom.identityPreset;
                state.viewport = { ...state.lastCustom.viewport };
            }
            else if (request.selection === 'responsive') {
                state.identityPreset = 'native';
                state.viewport = null;
            }
            else {
                const device = getBrowserPreviewDevice(request.selection);
                state.identityPreset = device.id;
                state.viewport = { width: device.width, height: device.height };
            }
            state.selection = request.selection;
            state.orientation = state.viewport ? orientation(state.viewport) : 'portrait';
            state.enabled = true;
            break;
        }
        case 'resize': {
            if (!state.enabled)
                throw new Error('DEVICE_PREVIEW_DISABLED');
            if (!isBrowserPreviewSizeUpdate(request, state.viewport))
                throw new Error('INVALID_DEVICE_PREVIEW_REQUEST');
            state.viewport = { width: request.width, height: request.height };
            state.selection = 'custom';
            state.orientation = orientation(state.viewport);
            state.lastCustom = { identityPreset: state.identityPreset, viewport: { ...state.viewport } };
            break;
        }
        case 'rotate': {
            if (!state.enabled || !state.viewport)
                break;
            const rotated = { width: state.viewport.height, height: state.viewport.width };
            // Rotation preserves exact dimensions, including a portrait QHD preset.
            // Manual edits are independently constrained by validSize above.
            state.viewport = rotated;
            state.orientation = orientation(rotated);
            if (state.selection === 'custom')
                state.lastCustom = { identityPreset: state.identityPreset, viewport: { ...rotated } };
            break;
        }
    }
    return state;
}
/** Fit never changes the logical viewport. Fixed scale can exceed the visible stage. */
export function getBrowserPreviewDisplayScale(viewport, available, scale) {
    if (scale !== 'fit')
        return scale;
    if (!available)
        return 1;
    return Math.max(0.01, Math.min(1, available.width / viewport.width, available.height / viewport.height));
}
//# sourceMappingURL=browser-device-preview.js.map