/**
 * Remote-tunable collection policy for automatic desktop/cloud metadata capture.
 *
 * The policy is a plain, JSON-serialisable, deny-only document. It can narrow what automatic
 * collection reports, never widen it: the collectors keep their own hard safety baseline
 * (excluded directory names, "inventory PATH filenames but never execute them", no file
 * contents) regardless of what the policy says.
 *
 * Field names use the same snake_case spelling as the Apollo document so there is exactly one
 * vocabulary between remote config, the parser and the collected payload.
 */
export const COLLECTION_POLICY_SCHEMA_VERSION = 1;
/** Apollo `plg-yingshi` / `web_config` key carrying the raw policy document. */
export const COLLECTION_POLICY_APOLLO_KEY = 'agent_desktop_collection_policy';
//# sourceMappingURL=types.js.map