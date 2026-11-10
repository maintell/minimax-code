import { randomBytes } from "node:crypto";
import { quoteRemoteShellArg } from "./ssh-command.js";
/** Per-invocation framing; the complete marker never occurs in the input script. */
export class SshOutputProtocol {
    constructor(maxOutputBytes = 1024 * 1024) {
        this.maxOutputBytes = maxOutputBytes;
        this.id = randomBytes(24).toString('hex');
        this.start = Buffer.from(`\x1eMCODE/1/${this.id}/start\n`);
        this.end = Buffer.from(`\x1eMCODE/1/${this.id}/end:`);
        this.inputReady = Buffer.from(`\x1eMCODE/1/${this.id}/input\n`);
        this.buffer = Buffer.alloc(0);
        this.started = false;
        this.discardedBytes = 0;
    }
    print(suffix) {
        // Split the nonce so even verbatim shell echo cannot impersonate output.
        return `printf '\\036MCODE/1/%s%s/${suffix}' '${this.id.slice(0, 24)}' '${this.id.slice(24)}'`;
    }
    streamScript(script) {
        return `${this.print('start\\n')}; ${script}`;
    }
    readyScript() {
        return this.print('input\\n');
    }
    hasStarted() {
        return this.started;
    }
    /** Bounded partial output for an explicitly requested command diagnostic. */
    commandOutputTail() {
        if (!this.started)
            return '';
        const end = this.buffer.indexOf(this.end);
        return this.buffer
            .subarray(0, end < 0 ? undefined : end)
            .subarray(-64 * 1024)
            .toString('utf8');
    }
    commandScript(script) {
        return `${this.streamScript(`( ${script}\n)`)}; mcode_status=$?; ${this.print('end:')}; printf '%s\\n' "$mcode_status"; exit "$mcode_status"`;
    }
    shellInput(script) {
        // One parsed shell command; the nested process owns all subsequent stdin.
        return `exec sh -c ${quoteRemoteShellArg(script)}\n`;
    }
    /** Consume only the preamble; after the marker, bytes are never text-filtered. */
    acceptStart(chunk) {
        if (this.started)
            return chunk;
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const index = this.buffer.indexOf(this.start);
        if (index < 0) {
            this.discardedBytes += Math.max(0, this.buffer.length - this.start.length);
            this.buffer = this.buffer.subarray(-this.start.length);
            if (this.discardedBytes > 64 * 1024)
                throw new Error('ssh_preamble_too_large');
            return null;
        }
        if (this.discardedBytes + index > 64 * 1024)
            throw new Error('ssh_preamble_too_large');
        const remainder = this.buffer.subarray(index + this.start.length);
        this.buffer = Buffer.alloc(0);
        this.started = true;
        return remainder;
    }
    acceptCommand(chunk) {
        const bytes = this.acceptStart(chunk);
        if (bytes === null)
            return null;
        this.buffer = Buffer.concat([this.buffer, bytes]);
        const index = this.buffer.indexOf(this.end);
        if (index < 0) {
            if (this.buffer.length > this.maxOutputBytes + this.end.length) {
                throw new Error('ssh_output_too_large');
            }
            return null;
        }
        if (index > this.maxOutputBytes)
            throw new Error('ssh_output_too_large');
        const statusBytes = this.buffer.subarray(index + this.end.length);
        if (statusBytes.length > 4 && statusBytes.indexOf(10) < 0)
            throw new Error('ssh_invalid_completion');
        const newline = statusBytes.indexOf(10);
        if (newline < 0)
            return null;
        const status = statusBytes.subarray(0, newline).toString('ascii');
        if (!/^\d{1,3}$/u.test(status) || Number(status) > 255)
            throw new Error('ssh_invalid_completion');
        return { stdout: this.buffer.subarray(0, index).toString('utf8'), exitCode: Number(status) };
    }
}

