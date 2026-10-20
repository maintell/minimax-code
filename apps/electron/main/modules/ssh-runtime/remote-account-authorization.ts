/** Main-owned UI orchestration only. Device polling and credentials stay on the remote host. */
export class RemoteAccountAuthorization {
    constructor(options) {
        this.options = options;
        this.suppressed = false;
        this.disposed = false;
        this.revision = 0;
    }
    current() {
        return !this.disposed && this.options.isCurrent();
    }
    async connected() {
        if (!this.current())
            return;
        try {
            await this.request({ action: 'read' });
        }
        catch {
            // Connection recovery never launches an account authorization flow.
        }
    }
    async request(input) {
        if (input.action === 'login') {
            this.suppressed = false;
            return this.start();
        }
        if (input.action === 'cancel' || input.action === 'logout') {
            // Invalidate before awaiting an in-flight start; its late prompt must not open a browser.
            this.suppressed = true;
            this.revision += 1;
            this.failure = undefined;
            await this.pending?.catch(() => undefined);
        }
        if (!this.current())
            throw new Error('The SSH connection changed.');
        const account = await this.options.request(input);
        if (input.action !== 'read')
            return account;
        this.observe(account);
        return this.failure && account.state !== 'authenticated'
            ? { ...account, failure: this.failure }
            : account;
    }
    observe(account) {
        if (this.current() && account.state === 'authenticated')
            this.failure = undefined;
    }
    dispose() {
        this.disposed = true;
        this.revision += 1;
    }
    start() {
        if (this.pending)
            return this.pending;
        const revision = this.revision;
        this.failure = undefined;
        const task = this.authorize(revision)
            .catch((error) => {
            if (this.current() && this.revision === revision) {
                this.failure = {
                    code: 'SSH_ACCOUNT_AUTHORIZATION_FAILED',
                    message: 'Remote account authorization failed. Retry from the SSH connection.',
                    retryable: true,
                };
            }
            throw error;
        })
            .finally(() => {
            if (this.pending === task)
                this.pending = undefined;
        });
        this.pending = task;
        return task;
    }
    async authorize(revision) {
        let account = await this.options.request({ action: 'read' });
        const active = () => this.current() && revision === this.revision && !this.suppressed;
        if (!active())
            return account;
        if (account.state === 'authenticated') {
            this.observe(account);
            return account;
        }
        if (!account.pendingLogin)
            account = await this.options.request({ action: 'login' });
        if (!active())
            return account;
        const prompt = account.state === 'authorizing' ? account.pendingLogin : undefined;
        if (!prompt)
            return account;
        if (prompt.expiresAtMs <= Date.now()) {
            this.failure = {
                code: 'SSH_ACCOUNT_AUTHORIZATION_EXPIRED',
                message: 'The remote authorization expired. Cancel it and start a new login.',
                retryable: true,
            };
            return { ...account, failure: this.failure };
        }
        const url = prompt.verificationUriComplete ?? prompt.verificationUri;
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
                throw new Error('Invalid authorization URL.');
            }
            await this.options.openBrowser(url);
        }
        catch {
            if (active()) {
                this.failure = {
                    code: 'SSH_ACCOUNT_BROWSER_OPEN_FAILED',
                    message: 'Unable to open the browser. Open the authorization page from the SSH connection.',
                    retryable: true,
                };
            }
        }
        return this.failure ? { ...account, failure: this.failure } : account;
    }
}

