import { CRON_MIGRATIONS } from '../cron/schema.js';
import { QUESTIONNAIRE_MIGRATIONS } from '../questionnaire/schema.js';
import { SESSION_ASSET_MIGRATIONS } from '../session-assets/schema.js';
import { WORKSPACE_INDEXING_MIGRATIONS } from '../workspace-indexing/schema.js';
export const FEATURE_MIGRATIONS = [
    ...QUESTIONNAIRE_MIGRATIONS,
    ...CRON_MIGRATIONS,
    ...SESSION_ASSET_MIGRATIONS,
    ...WORKSPACE_INDEXING_MIGRATIONS,
];
//# sourceMappingURL=feature-migrations.js.map