import { publishedRcChannelSurfaceRepairMigration42 as rcChannelRepair } from './migration-0042-repair-rc-channel-surface-version-collision.js';
import { migration as sidechatRepair } from './migration-0042-repair-session-sidechats-version-collision.js';
// Both trains published version 42. Preserve those markers and apply both
// frozen, idempotent repairs under one new version before schema validation.
export const migration = {
    version: 44,
    name: 'converge_rc_sidechat_version_collision',
    up(database) {
        for (const repair of [rcChannelRepair, sidechatRepair]) {
            if (typeof repair.up === 'string')
                database.exec(repair.up);
            else
                repair.up(database);
        }
    },
};
//# sourceMappingURL=migration-0044-converge-rc-sidechat-version-collision.js.map