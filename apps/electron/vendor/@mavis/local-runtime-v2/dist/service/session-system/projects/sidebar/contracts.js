export class SidebarQueryError extends Error {
    key;
    status;
    constructor(key, message, status = 400) {
        super(message);
        this.key = key;
        this.status = status;
        this.name = 'SidebarQueryError';
    }
}
//# sourceMappingURL=contracts.js.map