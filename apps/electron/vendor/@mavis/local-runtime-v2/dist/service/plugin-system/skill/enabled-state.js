import { deletePreferenceValue, readPreferenceValue, upsertPreferenceValue, } from '../../../infra/db/preference-values.js';
const STANDALONE_SKILL_STATE_KEY = 'standalone-skill-disabled-state';
/** V2-owned enabled-state capability injected into the V1 discovery engine. */
export class SkillEnabledState {
    db;
    loaded;
    mutationTail = Promise.resolve();
    constructor(db) {
        this.db = db;
    }
    async getDisabledLocationUris() {
        return new Set(this.read());
    }
    async setEnabled(locationUri, enabled) {
        await this.mutate((disabled) => {
            if (enabled)
                disabled.delete(locationUri);
            else
                disabled.add(locationUri);
        });
    }
    async forget(locationUri) {
        await this.mutate((disabled) => disabled.delete(locationUri));
    }
    async mutate(update) {
        const previous = this.mutationTail;
        let release;
        this.mutationTail = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            const next = new Set(this.read());
            update(next);
            this.write(next);
            this.loaded = next;
        }
        finally {
            release();
        }
    }
    read() {
        if (this.loaded)
            return this.loaded;
        const parsed = readPreferenceValue(this.db, STANDALONE_SKILL_STATE_KEY);
        const values = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed.disabledLocationUris
            : undefined;
        this.loaded = new Set(Array.isArray(values)
            ? values.filter((value) => typeof value === 'string' && value.length > 0)
            : []);
        return this.loaded;
    }
    write(disabled) {
        if (disabled.size === 0) {
            deletePreferenceValue(this.db, STANDALONE_SKILL_STATE_KEY);
            return;
        }
        upsertPreferenceValue(this.db, STANDALONE_SKILL_STATE_KEY, {
            version: 1,
            disabledLocationUris: [...disabled].sort(),
        });
    }
}
//# sourceMappingURL=enabled-state.js.map