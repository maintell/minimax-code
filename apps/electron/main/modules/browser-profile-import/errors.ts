export class BrowserProfileImportFailure extends Error {
    constructor(code) {
        super(code);
        this.name = 'BrowserProfileImportFailure';
        this.code = code;
    }
}

