import { migration as channelSurface } from './migration-0033-converge-channel-session-project-schema.js';
import { migration as sharedSchema } from './migration-0034-restore-shared-project-schema-compatibility.js';
/** RC/SSH builds published a different version 33. Preserve that receipt while
 * applying the skipped channel data backfill and restoring the shared DDL. */
export const publishedRcChannelSurfaceRepairMigration = {
    version: 37,
    name: 'repair_rc_channel_surface_version_collision',
    up(database) {
        // Receipts store only version/time, not which branch body ran. Reapply the
        // frozen channel-only backfill once; ordinary hidden sessions stay hidden.
        for (const entry of [channelSurface, sharedSchema]) {
            if (typeof entry.up === 'string')
                database.exec(entry.up);
            else
                entry.up(database);
        }
    },
};
//# sourceMappingURL=migration-0037-repair-rc-channel-surface-collision.js.map