/** Startup override shared by desktop and cloud; user consent is checked separately. */
export function resolveSessionClioCaptureEnabled(envValue, configuredEnabled = true) {
    const value = envValue?.trim().toLowerCase();
    if (!value)
        return configuredEnabled;
    if (['1', 'true', 'yes', 'on'].includes(value))
        return true;
    if (['0', 'false', 'no', 'off'].includes(value))
        return false;
    throw new Error(`session-clio: invalid boolean env value ${JSON.stringify(envValue)}`);
}
//# sourceMappingURL=capture-config.js.map