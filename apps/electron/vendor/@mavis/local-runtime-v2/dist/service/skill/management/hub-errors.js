export class LocalSkillHubInstallError extends Error {
    code;
    status;
    constructor(message, code, status) {
        super(message);
        this.code = code;
        this.status = status;
        this.name = 'LocalSkillHubInstallError';
    }
}
//# sourceMappingURL=hub-errors.js.map