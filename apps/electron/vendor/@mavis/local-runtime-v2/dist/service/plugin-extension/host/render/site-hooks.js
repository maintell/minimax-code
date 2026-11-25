import { isUiRenderSite, parseOwnedSiteKey, UI_RENDER_EVENT } from '@mavis/shared/plugin-extension';
import { breakerKeyOf, entryLabel } from '../breaker.js';
/** A hook's literal matcher claims a site instance when every field both sides name agrees. */
function matchesLayer(matcher, fields, site) {
    if (!matcher)
        return false;
    let compared = 0;
    for (const field of site.matcherFields) {
        const got = fields[field.name];
        const want = matcher[field.name];
        if (got === undefined || want === undefined)
            continue;
        if (got !== want)
            return false;
        compared += 1;
    }
    return compared > 0;
}
/**
 * The hook of one plugin that draws a tree site instance. An `on(slot, matcher, hook)` site takes
 * the hook whose literal matcher claims the instance. A `ui.render` site takes the plugin's
 * `on('ui.render', { site, ... }, hook)` whose fields all equal the instance's; a field the hook
 * leaves out matches every value, and one naming the field wins over one leaving it out. `id` is a
 * plain string: another plugin's `{ site: 'pane', id: 'board' }` joins the owner's `board`.
 */
function findSiteHook(hooks, site, fields) {
    if (!isUiRenderSite(site)) {
        return hooks.find((hook) => hook.slot === site.slot && matchesLayer(hook.matcher, fields, site));
    }
    const drawings = hooks.filter((hook) => hook.slot === UI_RENDER_EVENT &&
        hook.matcher?.site === site.slot &&
        site.matcherFields.every((field) => hook.matcher?.[field.name] === undefined ||
            hook.matcher[field.name] === fields[field.name]));
    const named = (hook) => site.matcherFields.filter((field) => hook.matcher?.[field.name] !== undefined).length;
    return drawings.sort((a, b) => named(b) - named(a))[0];
}
/**
 * `undefined` when a site marked `drawnBy` gets a key that names no owner, or a chained `ui.render`
 * site (`above-prompt`) a key other than its own name.
 */
export function siteClaimOf(site, request) {
    if (site.drawnBy !== UI_RENDER_EVENT) {
        if (isUiRenderSite(site) && request.key !== site.slot)
            return undefined;
        return { fields: { id: request.key, ...request.match } };
    }
    const owned = parseOwnedSiteKey(request.key);
    return owned ? { fields: { id: owned.id }, owner: owned.pluginId } : undefined;
}
/**
 * The event a `ui.render` layer receives: `{ site }`, or `{ site: 'pane', id }` with the id of the
 * pane drawn, whether or not the hook's matcher named it.
 */
export function uiRenderEventOf(site, key) {
    if (site.drawnBy !== UI_RENDER_EVENT)
        return { site: site.slot };
    return { site: site.slot, id: parseOwnedSiteKey(key)?.id ?? '' };
}
/** The activation's layer on the claimed instance. */
export function layerOf(record, site, claim) {
    const { input } = record;
    const hook = findSiteHook(input.artifact.hooks, site, claim.fields);
    if (!hook)
        return undefined;
    return {
        plugin: input.pluginId,
        tier: input.tier,
        breakerKey: breakerKeyOf({
            pluginId: input.pluginId,
            slot: site.slot,
            entry: entryLabel(hook.matcher),
            tier: input.tier,
            artifactDigest: input.artifact.digest,
            sessionId: input.sessionId,
        }),
        activation: record,
        hook,
    };
}
//# sourceMappingURL=site-hooks.js.map