import { screen, BrowserWindow } from "electron";
import { registerTransparentWindow } from "../../../windows/utils";
import { getCategoryLogger } from "../../../utils/logger";
// User-provided 54px artwork. The pointer tip is approximately (21, 21).
export let CUA_POINTER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="54" height="54" viewBox="0 0 54 54" fill="none"><g clip-path="url(#clip)"><g filter="url(#shadow)"><path d="M20.9447 23.2355C20.3934 21.5818 21.9667 20.0085 23.6204 20.5597L37.1547 25.0711C39.0589 25.7058 39.0912 28.3875 37.203 29.0681L32.4418 30.784C31.8491 30.9975 31.3825 31.4642 31.1689 32.0568L29.453 36.818C28.7725 38.7063 26.0908 38.6739 25.4561 36.7697L20.9447 23.2355Z" fill="var(--text_default_accent)" stroke="var(--icon_default_inverted_static)" stroke-width="1.69231"/></g></g><defs><filter id="shadow" x="-0.32283" y="0.984498" width="60.0778" height="60.0779" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/><feOffset dy="1.69231"/><feGaussianBlur stdDeviation="10.1538"/><feComposite in2="hardAlpha" operator="out"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0.478431 0 0 0 0 1 0 0 0 0.8 0"/><feBlend in2="BackgroundImageFix" result="glow"/><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/><feOffset dy="1.69231"/><feGaussianBlur stdDeviation="0.846154"/><feComposite in2="hardAlpha" operator="out"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0.0967733 0 0 0 0 0.164776 0 0 0 0.24 0"/><feBlend in2="glow" result="shadow"/><feBlend in="SourceGraphic" in2="shadow"/></filter><clipPath id="clip"><rect width="54" height="54" fill="white"/></clipPath></defs></svg>`;
export function pointerDipPoint(point, platform = process.platform) {
    if (![point.x, point.y].every(Number.isFinite))
        return;
    if (point.desktop) {
        const display = screen.getPrimaryDisplay();
        if (point.x < 0 ||
            point.y < 0 ||
            point.x >= display.bounds.width * display.scaleFactor ||
            point.y >= display.bounds.height * display.scaleFactor)
            return;
        return {
            x: display.bounds.x + point.x / display.scaleFactor,
            y: display.bounds.y + point.y / display.scaleFactor,
        };
    }
    return platform === 'win32' ? screen.screenToDipPoint(point) : point;
}
/** Small non-interactive presentation window; never reads or moves the user's cursor. */
export class CuaPointer {
    show(event) {
        if (!['darwin', 'win32'].includes(process.platform))
            return;
        if (event.phase !== 'show') {
            if (this.current?.requestId !== event.requestId || this.current.sessionId !== event.sessionId)
                return;
            if (event.phase === 'complete') {
                this.current = { ...this.current, phase: 'complete' };
            }
            else if (this.current.phase !== 'complete')
                this.clear();
            return;
        }
        if (!event.point)
            return;
        const point = pointerDipPoint(event.point);
        if (!point)
            return;
        this.current = event;
        if (this.window && !this.window.isDestroyed()) {
            this.window.setPosition(Math.round(point.x - 21), Math.round(point.y - 21));
            return;
        }
        const window = new BrowserWindow({
            x: Math.round(point.x - 21),
            y: Math.round(point.y - 21),
            width: 54,
            height: 54,
            show: false,
            frame: false,
            transparent: true,
            backgroundColor: '#00000000',
            hasShadow: false,
            focusable: false,
            resizable: false,
            movable: false,
            skipTaskbar: true,
            minimizable: false,
            maximizable: false,
            webPreferences: {
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                devTools: false,
            },
        });
        registerTransparentWindow(window);
        this.window = window;
        window.setIgnoreMouseEvents(true);
        window.setAlwaysOnTop(true, 'screen-saver');
        window.setContentProtection(true);
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (e) => e.preventDefault());
        // Match colorPlugin.ts tokens; nativeTheme also covers the app theme override.
        const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>:root{--text_default_accent:#0094fc;--icon_default_inverted_static:rgba(255,255,255,.95)}@media(prefers-color-scheme:dark){:root{--text_default_accent:#0077d9}}html,body{margin:0;overflow:hidden;background:transparent;pointer-events:none}</style>${CUA_POINTER_SVG}`;
        void window
            .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
            .then(() => {
            if (this.window === window && !window.isDestroyed())
                window.showInactive();
        })
            .catch((error) => {
            getCategoryLogger('main', 'computer-use').warn('pointer_display_failed', {
                error: String(error),
            });
            if (this.window === window)
                this.clear();
        });
    }
    clear(sessionId, turnId) {
        if (sessionId && this.current?.sessionId !== sessionId)
            return;
        if (turnId && this.current?.turnId !== turnId)
            return;
        this.current = undefined;
        const window = this.window;
        this.window = undefined;
        if (window && !window.isDestroyed())
            window.destroy();
    }
}

