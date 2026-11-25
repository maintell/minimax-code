/** Filters private prompt markers and credentials before output enters replay or IPC. */
export class InlineOutputFilter {
    constructor(token, onPrompt, onReady) {
        this.onPrompt = onPrompt;
        this.onReady = onReady;
        this.pending = '';
        this.secrets = [];
        this.marker = `\x1b]777;${token};`;
    }
    addSecret(secret) {
        if (secret && !this.secrets.includes(secret)) {
            this.secrets.push(secret);
            this.secrets.sort((a, b) => b.length - a.length);
        }
    }
    clear() {
        this.pending = '';
        this.secrets = [];
    }
    feed(data, final = false) {
        this.pending += data;
        let output = '';
        while (this.pending) {
            if (this.pending.startsWith(this.marker)) {
                const end = this.pending.indexOf('\x07', this.marker.length);
                if (end === -1 && !final && this.pending.length < 512)
                    break;
                if (end !== -1) {
                    const code = this.pending.slice(this.marker.length, end);
                    if (/^ready;[0-9][\w.()+-]{0,79}$/.test(code))
                        this.onReady?.(code.slice(6));
                    else if (/^-?\d{1,10}$/.test(code)) {
                        const value = Number(code);
                        if (value >= -2147483648 && value <= 4294967295)
                            this.onPrompt(value);
                    }
                    this.pending = this.pending.slice(end + 1);
                    continue;
                }
            }
            const secret = this.secrets.find((value) => this.pending.startsWith(value));
            if (secret) {
                output += '[REDACTED]';
                this.pending = this.pending.slice(secret.length);
                continue;
            }
            // Keep only a possible prefix, so ordinary interactive prompts are never buffered.
            if (!final &&
                [this.marker, ...this.secrets].some((value) => value.startsWith(this.pending))) {
                break;
            }
            if (final && this.secrets.some((value) => value.startsWith(this.pending))) {
                output += '[REDACTED]';
                this.pending = '';
                break;
            }
            output += this.pending[0];
            this.pending = this.pending.slice(1);
        }
        return output;
    }
}

