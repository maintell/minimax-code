import { DesktopWebsiteServiceBase } from './desktop-website-service-base.js';
/** Keeps independent published contracts unavailable until their owners are integrated. */
export class DesktopPendingContractsBase extends DesktopWebsiteServiceBase {
    // Published IDL includes these independent features; this lane has no owners for them.
    listExtensionEntries = () => this.unimplementedGeneratedMethod('listExtensionEntries');
    renderExtension = () => this.unimplementedGeneratedMethod('renderExtension');
    pressExtension = () => this.unimplementedGeneratedMethod('pressExtension');
    inputExtension = () => this.unimplementedGeneratedMethod('inputExtension');
    selectExtension = () => this.unimplementedGeneratedMethod('selectExtension');
    ackExtensionApplied = () => this.unimplementedGeneratedMethod('ackExtensionApplied');
    reportExtensionFallback = () => this.unimplementedGeneratedMethod('reportExtensionFallback');
    answerExtensionQuery = () => this.unimplementedGeneratedMethod('answerExtensionQuery');
    closeExtensionPane = () => this.unimplementedGeneratedMethod('closeExtensionPane');
    subscribeExtensionStream = () => this.unimplementedGeneratedMethod('subscribeExtensionStream');
    restoreSessionWorktree = () => this.unimplementedGeneratedMethod('restoreSessionWorktree');
}
//# sourceMappingURL=desktop-pending-contracts-base.js.map