export class LocalQuestionnaireError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
//# sourceMappingURL=questionnaire-errors.js.map