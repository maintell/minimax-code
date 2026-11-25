import { BACKGROUND_TASK_READ_SETTLEMENT_CUSTOM_TYPE, isBackgroundTaskReadSettlement, } from '../../contracts.js';
export { isBackgroundTaskReadSettlement };
export function createBackgroundTaskReadSettlement(timestamp) {
    return {
        role: 'custom',
        customType: BACKGROUND_TASK_READ_SETTLEMENT_CUSTOM_TYPE,
        content: '',
        display: false,
        details: { version: 1 },
        hostMetadata: { providerVisibility: 'omit' },
        timestamp,
    };
}
//# sourceMappingURL=task-read-settlement.js.map