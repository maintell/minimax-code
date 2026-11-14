import { MiniAppLaunchpadStore } from './launchpad-store.service.js';
export function initializeMiniAppLaunchpad(db, deployment, onChanged) {
    return new MiniAppLaunchpadStore(db, deployment, onChanged);
}
//# sourceMappingURL=initialize.js.map