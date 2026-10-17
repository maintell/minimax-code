import { readPreferenceValue, upsertPreferenceValue } from '../../infra/db/preference-values.js';
const SEND_PREFERENCE_KEY = 'composer-send-behavior';
export class ComposerSendBehaviorPreference {
    db;
    constructor(db) {
        this.db = db;
    }
    async get() {
        return readPreferenceValue(this.db, SEND_PREFERENCE_KEY) === 'steer' ? 'steer' : 'queue';
    }
    async set(value) {
        if (value !== 'queue' && value !== 'steer')
            throw new Error('Invalid composer send behavior');
        upsertPreferenceValue(this.db, SEND_PREFERENCE_KEY, value);
    }
}
const ENTER_PREFERENCE_KEY = 'composer-enter-behavior';
function isComposerEnterBehavior(value) {
    return value === 'enter' || value === 'cmdIfMultiline' || value === 'cmdAlways';
}
export class ComposerEnterBehaviorPreference {
    db;
    constructor(db) {
        this.db = db;
    }
    async get() {
        const stored = readPreferenceValue(this.db, ENTER_PREFERENCE_KEY);
        // Unknown or corrupted stored values degrade to the historical default
        // instead of failing the preferences surface.
        return isComposerEnterBehavior(stored) ? stored : 'enter';
    }
    async set(value) {
        if (!isComposerEnterBehavior(value))
            throw new Error('Invalid composer enter behavior');
        upsertPreferenceValue(this.db, ENTER_PREFERENCE_KEY, value);
    }
}
export function createComposerPreferences(db) {
    return {
        composerSendBehavior: new ComposerSendBehaviorPreference(db),
        composerEnterBehavior: new ComposerEnterBehaviorPreference(db),
    };
}
//# sourceMappingURL=composer-preferences.js.map