import { CDPHelper as browserCoreCDPHelper } from "@mavis/browser-core";
import { ElectronCdpTransport } from "./electron-cdp-transport";
/** Electron compatibility adapter for the provider-neutral shared CDPHelper. */
export class CDPHelper extends browserCoreCDPHelper {
    constructor(webContents, getInputCoordinateScale = () => 1, transport = new ElectronCdpTransport(webContents, {
        autoAttachOopif: false,
    })) {
        super(transport, getInputCoordinateScale);
    }
    setWebContents(webContents) {
        this.setTransport(new ElectronCdpTransport(webContents, { autoAttachOopif: false }));
    }
}

