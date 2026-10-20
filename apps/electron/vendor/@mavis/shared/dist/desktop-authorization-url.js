/** URL decoration shared by Desktop Main and Renderer authorization entry points. */
export function markDesktopAuthorizationUrl(verificationUrl, options) {
    const url = new URL(verificationUrl);
    // account-test currently returns account-pre links for Device Flow.
    if ((options.buildEnv === 'dev' || options.buildEnv === 'test') &&
        url.hostname === 'account-pre.xaminim.com') {
        url.hostname = 'account-test.xaminim.com';
    }
    url.searchParams.set('client_surface', 'desktop');
    url.searchParams.set('download_source', options.downloadSource || 'default');
    return url.toString();
}
//# sourceMappingURL=desktop-authorization-url.js.map