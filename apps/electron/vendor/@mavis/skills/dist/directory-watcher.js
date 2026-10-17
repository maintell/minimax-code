import { watch } from 'node:fs';
import path from 'node:path';
// Registries differ by workspace and selectors but commonly watch the same
// global Skill directories. Native watcher teardown can block the JS thread
// on macOS; evicting one registry must only release its own subscriptions.
const sharedWatchers = new Map();
export function subscribeToSkillDirectory(target, subscriber) {
    // Include filesystem identity so replacing a directory at the same path
    // never reuses a watcher still bound to the removed directory.
    const key = JSON.stringify([path.resolve(target.targetPath), target.dev, target.ino]);
    let shared = sharedWatchers.get(key);
    if (!shared) {
        const subscribers = new Set();
        const watcher = watch(target.targetPath, { persistent: false }, () => {
            for (const current of [...subscribers])
                current.onChange();
        });
        shared = { watcher, subscribers };
        const created = shared;
        watcher.on('error', () => {
            if (sharedWatchers.get(key) !== created)
                return;
            sharedWatchers.delete(key);
            const currentSubscribers = [...subscribers];
            subscribers.clear();
            watcher.close();
            for (const current of currentSubscribers)
                current.onError();
        });
        sharedWatchers.set(key, shared);
    }
    const subscription = shared;
    subscription.subscribers.add(subscriber);
    return {
        close() {
            if (!subscription.subscribers.delete(subscriber))
                return;
            if (subscription.subscribers.size > 0)
                return;
            if (sharedWatchers.get(key) === subscription)
                sharedWatchers.delete(key);
            subscription.watcher.close();
        },
    };
}
//# sourceMappingURL=directory-watcher.js.map