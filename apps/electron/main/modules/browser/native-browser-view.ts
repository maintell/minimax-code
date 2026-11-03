import { WebContentsView } from "electron";
/** Owns the native page allocation and child-view attachment, not tab state or CDP. */
export class NativeBrowserView {
    constructor(preferences) {
        this.view = new WebContentsView({ webPreferences: preferences });
    }
    attachInitial(parent) {
        // Initial attachment failures must fail creation so the controller tears down
        // the allocated renderer; later native handoffs remain best-effort.
        parent.contentView.addChildView(this.view);
    }
    attach(parent) {
        if (!parent || parent.isDestroyed() || !parent.contentView)
            return;
        try {
            if (!parent.contentView.children?.includes(this.view))
                parent.contentView.addChildView(this.view);
        }
        catch {
            // The host can close during a background/foreground handoff.
        }
    }
    detach(parent) {
        if (!parent || parent.isDestroyed() || !parent.contentView)
            return;
        try {
            if (parent.contentView.children?.includes(this.view))
                parent.contentView.removeChildView(this.view);
        }
        catch {
            // Teardown and native reparenting can race.
        }
    }
    destroy(parent) {
        this.detach(parent);
        // Removing the child view does not release its renderer or compositor buffers.
        try {
            if (!this.view.webContents.isDestroyed())
                this.view.webContents.close();
        }
        catch {
            // WebContents may already be closing with its owner.
        }
    }
}

