/**
 * SystemReminderRegistry — chain-of-responsibility registry for reminder providers.
 *
 * Each provider is a ReminderProviderFn that receives SystemReminderInput and
 * returns a string block (or undefined to skip). Providers are executed in
 * registration order and their outputs are assembled into <system-reminder>.
 *
 * Different AgentFrameworkType can register different sets of providers via
 * `appendFor()`. At build time, default providers run first, followed by any
 * framework-specific providers.
 */
// ─── Registry ───────────────────────────────────────────────────────────────
export class SystemReminderRegistry {
    defaults = [];
    perFramework = new Map();
    /** Append a provider that runs for ALL framework types. */
    append(name, provider) {
        this.defaults.push({ name, fn: provider, critical: false });
        return this;
    }
    /** Append a default provider that still runs when full SR is disabled for a model. */
    appendCritical(name, provider) {
        this.defaults.push({ name, fn: provider, critical: true });
        return this;
    }
    /** Append a provider that runs ONLY for a specific framework type. */
    appendFor(frameworkType, name, provider) {
        let list = this.perFramework.get(frameworkType);
        if (!list) {
            list = [];
            this.perFramework.set(frameworkType, list);
        }
        list.push({ name, fn: provider, critical: false });
        return this;
    }
    /** Append a framework-specific provider that still runs when full SR is disabled. */
    appendCriticalFor(frameworkType, name, provider) {
        let list = this.perFramework.get(frameworkType);
        if (!list) {
            list = [];
            this.perFramework.set(frameworkType, list);
        }
        list.push({ name, fn: provider, critical: true });
        return this;
    }
    /**
     * Resolve the full provider chain for a given framework type.
     * Returns default providers followed by any framework-specific providers.
     */
    resolve(frameworkType) {
        return [...this.defaults, ...(this.perFramework.get(frameworkType) ?? [])];
    }
    /** Resolve only critical providers, preserving the normal provider order. */
    resolveCritical(frameworkType) {
        return this.resolve(frameworkType).filter((np) => np.critical);
    }
}
//# sourceMappingURL=registry.js.map