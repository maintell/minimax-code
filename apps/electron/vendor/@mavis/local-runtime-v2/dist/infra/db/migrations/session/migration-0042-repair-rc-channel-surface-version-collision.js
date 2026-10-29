import { publishedRcChannelSurfaceRepairMigration as publishedRcRepair } from './migration-0037-repair-rc-channel-surface-collision.js';
/**
 * SSH builds used version 37 for the RC channel repair; PreviewTrain used it for
 * Memory V2. Preserve both published receipts and converge through a new version.
 */
export const publishedRcChannelSurfaceRepairMigration42 = {
    version: 42,
    name: 'repair_rc_channel_surface_version_collision',
    up(database) {
        if (typeof publishedRcRepair.up === 'string')
            database.exec(publishedRcRepair.up);
        else
            publishedRcRepair.up(database);
    },
};
//# sourceMappingURL=migration-0042-repair-rc-channel-surface-version-collision.js.map