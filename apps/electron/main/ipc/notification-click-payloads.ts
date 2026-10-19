import fs from "node:fs";
import path from "node:path";
const MAX_ENTRIES = 100;
const MAX_BYTES = 256 * 1024;
export class NotificationClickPayloadStore {
    constructor(filePath) {
        this.payloads = new Map();
        this.filePath = filePath;
        try {
            const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (saved.version === 1 && saved.payloads && typeof saved.payloads === 'object') {
                this.payloads = new Map(Object.entries(saved.payloads));
                this.trim();
            }
        }
        catch {
            this.payloads.clear();
        }
    }
    get(id) {
        const payload = this.payloads.get(id);
        return payload && structuredClone(payload);
    }
    put(id, payload) {
        this.payloads.set(id, payload);
        this.trim();
        this.persist();
    }
    delete(id) {
        if (this.payloads.delete(id))
            this.persist();
    }
    retainOnly(ids) {
        for (const id of this.payloads.keys()) {
            if (!ids.has(id))
                this.payloads.delete(id);
        }
        this.persist();
    }
    trim() {
        while (this.payloads.size > MAX_ENTRIES) {
            const oldest = this.payloads.keys().next().value;
            if (oldest === undefined)
                return;
            this.payloads.delete(oldest);
        }
    }
    persist() {
        const json = JSON.stringify({ version: 1, payloads: Object.fromEntries(this.payloads) });
        if (Buffer.byteLength(json, 'utf8') > MAX_BYTES)
            return;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(this.filePath, json, { encoding: 'utf8', mode: 0o600 });
        }
        catch {
            // The in-memory payload still makes the current process clickable.
        }
    }
}

