import { composeRuntimeCronDelivery } from '../../service/cron/index.js';
import { composeRuntimeWorktreeCleanup, } from './worktree-cleanup-composition.js';
/** Owners driven by runtime events rather than requests: cron delivery and worktree cleanup. */
export function composeRuntimeBackgroundOwners(options, owners, product, composition) {
    const cronDelivery = composeRuntimeCronDelivery(owners, options, product);
    const worktreeCleanup = composeRuntimeWorktreeCleanup(options, composition, owners);
    return {
        ...(cronDelivery ? { cronDelivery } : {}),
        ...(worktreeCleanup ? { worktreeCleanup } : {}),
    };
}
//# sourceMappingURL=runtime-background-owners.js.map