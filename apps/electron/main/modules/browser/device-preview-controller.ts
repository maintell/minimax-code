import { getBrowserPreviewDevice, getBrowserPreviewDisplayScale, cloneBrowserDevicePreviewState, createBrowserDevicePreviewState, isBrowserDevicePreviewRequest, reduceBrowserDevicePreview } from "@mavis/shared/browser-device-preview";
const IOS_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';
const IOS_17_SAFARI_SUFFIX = 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
function iosIdentity(options) {
    const { device, mobileClientHint } = options;
    const userAgent = device === 'iPhone'
        ? `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ${IOS_17_SAFARI_SUFFIX}`
        : `Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) ${IOS_17_SAFARI_SUFFIX}`;
    return {
        userAgent,
        acceptLanguage: IOS_ACCEPT_LANGUAGE,
        platform: device,
        userAgentMetadata: {
            brands: [],
            fullVersionList: [],
            platform: 'iOS',
            platformVersion: '17.0.0',
            architecture: '',
            model: device,
            mobile: mobileClientHint,
            bitness: '',
            formFactors: [device === 'iPhone' ? 'Mobile' : 'Tablet'],
        },
    };
}
export let DEVICE_PREVIEW_PRESETS = {
    desktop: {
        mode: 'desktop',
        mobile: false,
        viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
        userAgent: null,
        maxTouchPoints: 0,
    },
    'iphone-xr': {
        mode: 'iphone-xr',
        mobile: true,
        viewport: { width: 414, height: 896, deviceScaleFactor: 2 },
        userAgent: iosIdentity({ device: 'iPhone', mobileClientHint: true }),
        maxTouchPoints: 5,
    },
    mobile: {
        mode: 'mobile',
        mobile: true,
        viewport: { width: 375, height: 812, deviceScaleFactor: 3 },
        userAgent: iosIdentity({ device: 'iPhone', mobileClientHint: true }),
        maxTouchPoints: 5,
    },
    tablet: {
        mode: 'tablet',
        mobile: true,
        viewport: { width: 768, height: 1024, deviceScaleFactor: 2 },
        userAgent: iosIdentity({ device: 'iPad', mobileClientHint: false }),
        maxTouchPoints: 5,
    },
};
function previewIdentity(deviceId, chromiumVersion) {
    const device = getBrowserPreviewDevice(deviceId);
    if (device.identity === 'native')
        return null;
    if (device.identity === 'iphone' || device.identity === 'ipad') {
        return iosIdentity({
            device: device.identity === 'ipad' ? 'iPad' : 'iPhone',
            mobileClientHint: device.identity === 'iphone',
        });
    }
    if (!chromiumVersion || !/^\d+(\.\d+){3}$/.test(chromiumVersion)) {
        throw new Error('DEVICE_PREVIEW_CHROMIUM_VERSION_UNAVAILABLE');
    }
    const windows = device.identity === 'windows';
    const androidVersion = device.id === 'surface-duo' ? '12' : '14';
    const model = device.id === 'galaxy-s24-ultra' ? 'SM-S928B' : device.name;
    const platform = windows ? 'Windows' : 'Android';
    const platformVersion = windows ? '10.0.0' : `${androidVersion}.0.0`;
    const platformToken = windows
        ? 'Windows NT 10.0; Win64; x64'
        : `Linux; Android ${androidVersion}; ${model}`;
    return {
        userAgent: `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion}${windows ? '' : ' Mobile'} Safari/537.36`,
        platform: windows ? 'Win32' : 'Linux armv8l',
        userAgentMetadata: {
            brands: [{ brand: 'Chromium', version: chromiumVersion.split('.')[0] }],
            fullVersionList: [{ brand: 'Chromium', version: chromiumVersion }],
            platform,
            platformVersion,
            architecture: windows ? 'x86' : 'arm',
            model: windows ? '' : model,
            mobile: device.mobile,
            bitness: '64',
            wow64: false,
            formFactors: [windows ? 'Desktop' : device.group === 'tablet' ? 'Tablet' : 'Mobile'],
        },
    };
}
function resolvePreviewPreset(state, chromiumVersion) {
    if (!state.enabled || !state.viewport)
        return null;
    const device = state.identityPreset === 'native' ? undefined : getBrowserPreviewDevice(state.identityPreset);
    const rotated = device && device.width > device.height !== state.viewport.width > state.viewport.height;
    return {
        mode: state.selection === 'responsive' ? 'custom' : state.selection,
        mobile: device?.mobile ?? false,
        orientationAngle: rotated ? 90 : 0,
        viewport: { ...state.viewport, deviceScaleFactor: device?.dpr ?? 1 },
        userAgent: device ? previewIdentity(device.id, chromiumVersion) : null,
        maxTouchPoints: device?.touch ? 5 : 0,
    };
}
function identityKey(state, legacy) {
    if (!state.enabled)
        return legacy === 'responsive' || legacy === 'desktop' ? 'native' : `legacy:${legacy}`;
    if (!state.viewport || state.identityPreset === 'native')
        return 'native';
    const device = getBrowserPreviewDevice(state.identityPreset);
    return device.identity === 'native' ? 'native' : device.id;
}
function normalizeDisplayBounds(bounds) {
    return {
        width: Math.max(1, Math.round(bounds.width)),
        height: Math.max(1, Math.round(bounds.height)),
    };
}
function displayScale(bounds, preset) {
    if (!bounds)
        return 1;
    const fitted = Math.min(1, bounds.width / preset.viewport.width, bounds.height / preset.viewport.height);
    return Math.max(0.1, Math.round(fitted * 1000) / 1000);
}
function previewDisplayScale(preset, bounds, state, hostZoomFactor) {
    const cssBounds = bounds
        ? { width: bounds.width / hostZoomFactor, height: bounds.height / hostZoomFactor }
        : null;
    return (getBrowserPreviewDisplayScale(preset.viewport, cssBounds, state.displayScale) * hostZoomFactor);
}
function metricsParams(preset, bounds, previewState, hostZoomFactor = 1) {
    const { width, height, deviceScaleFactor } = preset.viewport;
    return {
        width,
        height,
        deviceScaleFactor,
        mobile: preset.mobile,
        scale: previewState
            ? previewDisplayScale(preset, bounds, previewState, hostZoomFactor)
            : displayScale(bounds, preset),
        ...(previewState ? { dontSetVisibleSize: true } : {}),
        screenWidth: width,
        screenHeight: height,
        positionX: 0,
        positionY: 0,
        screenOrientation: {
            type: width > height ? 'landscapePrimary' : 'portraitPrimary',
            angle: preset.orientationAngle ?? 0,
        },
    };
}
/**
 * Owns the complete, whitelisted device identity for one embedded Browser tab.
 *
 * Device identity changes are serialized because UA, metrics and touch must
 * never be observed as independently mutable renderer inputs. Any partial
 * apply is rolled back to Responsive before the caller can continue.
 */
export class DevicePreviewController {
    constructor(getCDP, chromiumVersion = process.versions.chrome) {
        this.getCDP = getCDP;
        this.chromiumVersion = chromiumVersion;
        this.mode = 'responsive';
        this.previewState = null;
        this.displayBounds = null;
        this.hostZoomFactor = 1;
        this.displayBoundsRevision = 0;
        this.displayBoundsTask = null;
        this.pageScaleFactor = 1;
        this.deviceIdentityApplied = false;
        this.operationTail = Promise.resolve();
    }
    getMode() {
        return this.mode;
    }
    getPreviewState() {
        return cloneBrowserDevicePreviewState(this.previewState ?? createBrowserDevicePreviewState());
    }
    getPreset() {
        if (this.previewState?.enabled)
            return resolvePreviewPreset(this.previewState, this.chromiumVersion);
        return this.mode === 'responsive' ? null : DEVICE_PREVIEW_PRESETS[this.mode];
    }
    getDisplayScale() {
        const preset = this.getPreset();
        if (!preset)
            return 1;
        return this.previewState?.enabled
            ? previewDisplayScale(preset, this.displayBounds, this.previewState, this.hostZoomFactor)
            : displayScale(this.displayBounds, preset);
    }
    reset() {
        this.mode = 'responsive';
        this.previewState = null;
        this.displayBounds = null;
        this.hostZoomFactor = 1;
        this.displayBoundsRevision += 1;
        this.displayBoundsTask = null;
        this.pageScaleFactor = 1;
        this.deviceIdentityApplied = false;
        this.operationTail = Promise.resolve();
    }
    setPageScaleFactor(factor) {
        this.pageScaleFactor = factor;
        return this.enqueue(async () => {
            if (!this.getPreset()?.mobile)
                return;
            await this.requireCDP().sendCommand('Emulation.setPageScaleFactor', {
                pageScaleFactor: factor,
            });
        });
    }
    setDisplayBounds(bounds, hostZoomFactor = 1) {
        if (!Number.isFinite(hostZoomFactor) || hostZoomFactor <= 0) {
            return Promise.reject(new Error('INVALID_DEVICE_PREVIEW_HOST_ZOOM'));
        }
        const normalized = normalizeDisplayBounds(bounds);
        if (this.displayBounds?.width === normalized.width &&
            this.displayBounds?.height === normalized.height &&
            this.hostZoomFactor === hostZoomFactor) {
            return Promise.resolve();
        }
        this.displayBounds = normalized;
        this.hostZoomFactor = hostZoomFactor;
        this.displayBoundsRevision += 1;
        if (!this.getPreset())
            return Promise.resolve();
        if (this.displayBoundsTask)
            return this.displayBoundsTask;
        const task = this.enqueue(async () => {
            for (;;) {
                const preset = this.getPreset();
                const appliedRevision = this.displayBoundsRevision;
                const bounds = this.displayBounds;
                if (!bounds || !preset)
                    return;
                await this.requireCDP().sendCommand('Emulation.setDeviceMetricsOverride', metricsParams(preset, bounds, this.previewState?.enabled ? this.previewState : undefined, this.hostZoomFactor));
                if (appliedRevision === this.displayBoundsRevision)
                    return;
            }
        });
        const trackedTask = task.finally(() => {
            if (this.displayBoundsTask === trackedTask)
                this.displayBoundsTask = null;
        });
        this.displayBoundsTask = trackedTask;
        return trackedTask;
    }
    updatePreview(request) {
        if (!isBrowserDevicePreviewRequest(request))
            return Promise.reject(new Error('INVALID_DEVICE_PREVIEW_REQUEST'));
        const captured = { ...request };
        return this.enqueue(() => this.applyPreviewState(reduceBrowserDevicePreview(this.getPreviewState(), captured)));
    }
    /** Only accepts the main-owned in-memory snapshot saved before tab suspension. */
    restorePreviewState(state) {
        const captured = cloneBrowserDevicePreviewState(state);
        return this.enqueue(async () => {
            if (captured.enabled)
                await this.applyPreviewState(captured);
            else
                this.previewState = captured;
        });
    }
    async applyPreviewState(next) {
        const previous = this.getPreviewState();
        if (JSON.stringify(next) === JSON.stringify(previous) && this.mode === 'responsive') {
            return { changed: false, identityChanged: false };
        }
        const preset = resolvePreviewPreset(next, this.chromiumVersion);
        const previousPreset = this.getPreset();
        const identityChanged = identityKey(previous, this.mode) !== identityKey(next, 'responsive');
        const cdp = this.requireCDP();
        const revision = this.displayBoundsRevision;
        try {
            if (identityChanged) {
                if (preset)
                    await this.applyPreset(cdp, preset, next);
                else
                    await this.applyResponsive(cdp);
            }
            else if (preset) {
                await cdp.sendCommand('Emulation.setDeviceMetricsOverride', metricsParams(preset, this.displayBounds, next, this.hostZoomFactor));
            }
            else if (previousPreset) {
                await this.applyResponsive(cdp);
            }
            if (preset && revision !== this.displayBoundsRevision) {
                await cdp.sendCommand('Emulation.setDeviceMetricsOverride', metricsParams(preset, this.displayBounds, next, this.hostZoomFactor));
            }
            this.previewState = next;
            this.mode = 'responsive';
            return { changed: true, identityChanged };
        }
        catch (error) {
            return this.rollback(cdp, error);
        }
    }
    setMode(mode) {
        return this.enqueue(async () => {
            if (mode === this.mode && !this.previewState?.enabled)
                return { changed: false };
            const cdp = this.requireCDP();
            const displayBoundsRevisionBeforeApply = this.displayBoundsRevision;
            try {
                if (mode === 'responsive') {
                    await this.applyResponsive(cdp);
                }
                else {
                    await this.applyPreset(cdp, DEVICE_PREVIEW_PRESETS[mode]);
                }
                this.mode = mode;
                if (this.previewState)
                    this.previewState = { ...this.previewState, enabled: false };
                if (mode !== 'responsive' &&
                    this.displayBounds &&
                    displayBoundsRevisionBeforeApply !== this.displayBoundsRevision) {
                    await cdp.sendCommand('Emulation.setDeviceMetricsOverride', metricsParams(DEVICE_PREVIEW_PRESETS[mode], this.displayBounds));
                }
                return { changed: true };
            }
            catch (error) {
                return this.rollback(cdp, error);
            }
        });
    }
    async rollback(cdp, error) {
        const applyError = error instanceof Error ? error.message : String(error);
        try {
            await this.applyResponsive(cdp);
            this.mode = 'responsive';
            if (this.previewState)
                this.previewState = { ...this.previewState, enabled: false };
        }
        catch (rollbackError) {
            const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            throw new Error(`DEVICE_PREVIEW_ROLLBACK_FAILED: ${applyError}; rollback: ${message}`);
        }
        throw new Error(`DEVICE_PREVIEW_APPLY_FAILED: ${applyError}`);
    }
    requireCDP() {
        const cdp = this.getCDP();
        if (!cdp)
            throw new Error('CDP helper not available');
        return cdp;
    }
    async applyPreset(cdp, preset, previewState) {
        if (!preset.userAgent) {
            // Restore native identity and desktop zoom semantics when leaving a mobile preset.
            await this.applyResponsive(cdp);
            await cdp.sendCommand('Emulation.setDeviceMetricsOverride', metricsParams(preset, this.displayBounds, previewState, this.hostZoomFactor));
            return;
        }
        this.deviceIdentityApplied = true;
        await cdp.sendCommand('Emulation.setUserAgentOverride', { ...preset.userAgent });
        await cdp.sendCommand('Emulation.setDeviceMetricsOverride', metricsParams(preset, this.displayBounds, previewState, this.hostZoomFactor));
        await cdp.sendCommand('Emulation.setTouchEmulationEnabled', {
            enabled: preset.maxTouchPoints > 0,
            maxTouchPoints: Math.max(1, preset.maxTouchPoints),
        });
        await cdp.sendCommand('Emulation.setPageScaleFactor', {
            pageScaleFactor: preset.mobile ? this.pageScaleFactor : 1,
        });
    }
    async applyResponsive(cdp) {
        await cdp.sendCommand('Emulation.setPageScaleFactor', {
            pageScaleFactor: 1,
        });
        await cdp.sendCommand('Emulation.setTouchEmulationEnabled', {
            enabled: false,
            maxTouchPoints: 1,
        });
        await cdp.sendCommand('Emulation.clearDeviceMetricsOverride');
        // Clear the override so Chromium restores every native identity signal.
        // Replaying a page snapshot can preserve emulated values or empty UA-CH.
        if (this.deviceIdentityApplied) {
            await cdp.sendCommand('Emulation.setUserAgentOverride', { userAgent: '' });
            this.deviceIdentityApplied = false;
        }
    }
    enqueue(operation) {
        const task = this.operationTail.catch(() => undefined).then(operation);
        this.operationTail = task.then(() => undefined, () => undefined);
        return task;
    }
}

