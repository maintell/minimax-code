export class LocalPermissionRuleError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
        this.name = 'LocalPermissionRuleError';
    }
}
export class LocalPermissionStoreUnhealthyError extends LocalPermissionRuleError {
    reasonCode;
    source;
    constructor(reasonCode, source) {
        super(reasonCode === 'unsupported-version'
            ? 'Unsupported permission.json version.'
            : `Permission rule store is unhealthy: ${reasonCode}.`, 503);
        this.reasonCode = reasonCode;
        this.source = source;
        this.name = 'LocalPermissionStoreUnhealthyError';
    }
}
//# sourceMappingURL=rule-model.js.map