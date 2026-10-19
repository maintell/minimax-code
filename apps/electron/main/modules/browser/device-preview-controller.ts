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
        viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
        userAgent: null,
        maxTouchPoints: 0,
    },
    'iphone-xr': {
        mode: 'iphone-xr',
        viewport: { width: 414, height: 896, deviceScaleFactor: 2 },
        userAgent: iosIdentity({ device: 'iPhone', mobileClientHint: true }),
        maxTouchPoints: 5,
    },
    mobile: {
        mode: 'mobile',
        viewport: { width: 375, height: 812, deviceScaleFactor: 3 },
        userAgent: iosIdentity({ device: 'iPhone', mobileClientHint: true }),
        maxTouchPoints: 5,
    },
    tablet: {
        mode: 'tablet',
        viewport: { width: 768, height: 1024, deviceScaleFactor: 2 },
        userAgent: iosIdentity({ device: 'iPad', mobileClientHint: false }),
        maxTouchPoints: 5,
    },
};
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
function metricsParams(preset, bounds) {
    const { width, height, deviceScaleFactor } = preset.viewport;
    return {
        width,
        height,
        deviceScaleFactor,
        mobile: preset.mode !== 'desktop',
        scale: displayScale(bounds, preset),
        screenWidth: width,
        screenHeight: height,
        positionX: 0,
        positionY: 0,
        screenOrientation: {
            type: width > height ? 'landscapePrimary' : 'portraitPrimary',
            angle: 0,
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
    constructor(getCDP) {
        this.getCDP = getCDP;
        this.mode = 'responsive';
        this.displayBounds = null;
        this.displayBoundsRevision = 0;
        this.displayBoundsTask = null;
        this.pageScaleFactor = 1;
        this.deviceIdentityApplied = false;
        this.operationTail = Promise.resolve();
    }
    getMode() {
        return this.mode;
    }
    getPreset() {
        return this.mode === 'responsive' ? null : DEVICE_PREVIEW_PRESETS[this.mode];
    }
    getDisplayScale() {
        return this.mode === 'responsive'
            ? 1
            : displayScale(this.displayBounds, DEVICE_PREVIEW_PRESETS[this.mode]);
    }
    reset() {
        this.mode = 'responsive';
        this.displayBounds = null;
        this.displayBoundsRevision += 1;
        this.displayBoundsTask = null;
        this.pageScaleFactor = 1;
        this.deviceIdentityApplied = false;
        this.operationTail = Promise.resolve();
    }
    setPageScaleFactor(factor) {
        this.pageScaleFactor = factor;
        return this.enqueue(async () => {
            if (this.mode === 'responsive' || this.mode === 'desktop')
                return;
            await this.requireCDP().sendCommand('Emulation.setPageScaleFactor', {
                pageScaleFactor: factor,
            });
        });
    }
    setDisplayBounds(bounds) {
        const normalized = normalizeDisplayBounds(bounds);
        if (this.displayBounds?.width === normalized.width &&
            this.displayBounds?.height === normalized.height) {
            return Promise.resolve();
        }
        this.displayBounds = normalized;
        this.displayBoundsRevision += 1;
        if (this.mode === 'responsive')
            return Promise.resolve();
        if (this.displayBoundsTask)
            return this.displayBoundsTask;
        const task = this.enqueue(async () => {
            while (this.mode !== 'responsive') {
                const appliedRevision = this.displayBoundsRevision;
                const bounds = this.displayBounds;
                if (!bounds)
                    return;
                await this.requireCDP().sendCommand('Emulation.setDeviceMetricsOverride', metricsParams(DEVICE_PREVIEW_PRESETS[this.mode], bounds));
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
    setMode(mode) {
        return this.enqueue(async () => {
            if (mode === this.mode)
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
                if (mode !== 'responsive' &&
                    this.displayBounds &&
                    displayBoundsRevisionBeforeApply !== this.displayBoundsRevision) {
                    await cdp.sendCommand('Emulation.setDeviceMetricsOverride', metricsParams(DEVICE_PREVIEW_PRESETS[mode], this.displayBounds));
                }
                return { changed: true };
            }
            catch (error) {
                const applyError = error instanceof Error ? error.message : String(error);
                try {
                    await this.applyResponsive(cdp);
                    this.mode = 'responsive';
                }
                catch (rollbackError) {
                    const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                    throw new Error(`DEVICE_PREVIEW_ROLLBACK_FAILED: ${applyError}; rollback: ${rollbackMessage}`);
                }
                throw new Error(`DEVICE_PREVIEW_APPLY_FAILED: ${applyError}`);
            }
        });
    }
    requireCDP() {
        const cdp = this.getCDP();
        if (!cdp)
            throw new Error('CDP helper not available');
        return cdp;
    }
    async applyPreset(cdp, preset) {
        if (preset.mode === 'desktop') {
            // Restore native identity and desktop zoom semantics when leaving a mobile preset.
            await this.applyResponsive(cdp);
            await cdp.sendCommand('Emulation.setDeviceMetricsOverride', metricsParams(preset, this.displayBounds));
            return;
        }
        this.deviceIdentityApplied = true;
        await cdp.sendCommand('Emulation.setUserAgentOverride', { ...preset.userAgent });
        await cdp.sendCommand('Emulation.setDeviceMetricsOverride', metricsParams(preset, this.displayBounds));
        await cdp.sendCommand('Emulation.setTouchEmulationEnabled', {
            enabled: true,
            maxTouchPoints: preset.maxTouchPoints,
        });
        await cdp.sendCommand('Emulation.setPageScaleFactor', {
            pageScaleFactor: this.pageScaleFactor,
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

