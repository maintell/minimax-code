import { createHash } from 'node:crypto';
/** Captures one credential generation without retaining it outside an active snapshot. */
export class RuntimePromptConfigAuthProvider {
    options;
    fingerprint;
    generation = 0;
    constructor(options) {
        this.options = options;
    }
    capture() {
        const deployment = this.options.deploymentGetter().trim();
        const context = this.options.authContextGetter();
        const accessToken = context?.accessToken?.trim();
        const realUserID = context?.realUserID?.trim();
        const loggedIn = Boolean(deployment && accessToken && realUserID);
        const fingerprint = loggedIn
            ? `account\0${deployment}\0${realUserID}\0${accessToken}`
            : `anonymous\0${deployment}`;
        if (this.fingerprint !== undefined && this.fingerprint !== fingerprint)
            this.generation += 1;
        this.fingerprint = fingerprint;
        if (!loggedIn) {
            return {
                scopeId: 'anonymous',
                subject: 'anonymous',
                keyVersion: 'desktop-v1',
                generation: this.generation,
            };
        }
        return {
            scopeId: createHash('sha256').update(`${deployment}\0${realUserID}`, 'utf8').digest('hex'),
            subject: realUserID,
            keyVersion: 'desktop-v1',
            accessToken: accessToken,
            generation: this.generation,
        };
    }
    authContextChanged() {
        this.generation += 1;
        this.fingerprint = undefined;
    }
}
//# sourceMappingURL=runtime-auth.js.map