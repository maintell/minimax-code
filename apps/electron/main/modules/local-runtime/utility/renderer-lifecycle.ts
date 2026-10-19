export function bindUtilityRuntimeRendererLifecycle(target, disconnect) {
    target.onNavigation((isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace)
            disconnect(target.rendererId, 'navigation');
    });
    target.onRenderProcessGone(() => {
        disconnect(target.rendererId, 'render-process-gone');
    });
    target.onDestroyed(() => {
        disconnect(target.rendererId, 'web-contents-destroyed');
    });
}
/** Production sender adapter shared by the global IPC handler and real-chain E2E. */
export function bindUtilityRuntimeRendererWebContentsLifecycle(webContents, disconnect) {
    bindUtilityRuntimeRendererLifecycle({
        rendererId: webContents.id,
        onNavigation: (listener) => {
            webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => listener(isInPlace, isMainFrame));
        },
        onRenderProcessGone: (listener) => {
            webContents.on('render-process-gone', listener);
        },
        onDestroyed: (listener) => {
            webContents.on('destroyed', listener);
        },
    }, disconnect);
}
