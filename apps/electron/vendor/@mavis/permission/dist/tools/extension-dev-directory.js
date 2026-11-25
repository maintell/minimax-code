/**
 * Where extension dev directories live under a runtime data dir:
 * `<dataDir>/<...EXTENSION_DEV_ROOT_SEGMENTS>/<sessionId>/<pluginId>/`. The runtime creates them
 * (`extension init`) and previews and tests from them; the `extension` permission check treats code
 * inside one as written by the Agent under the ordinary file-write permission, so both read the
 * layout from here. Segments, not a path: each side joins them with its platform path module.
 */
export const EXTENSION_DEV_ROOT_SEGMENTS = ['v2', 'plugin-dev', 'extensions'];
/** A session id that can name its dev directory. */
export const EXTENSION_DEV_SESSION_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/u;
//# sourceMappingURL=extension-dev-directory.js.map