/**
 * CloudGatewayClient — daemon-side abstraction over the existing managed
 * permission classify endpoint.
 *
 * Wire contract is pixel-aligned to the production endpoint already in use:
 *
 *   POST {region-routed-host}/mavis/api/v1/permission/check
 *   Authorization: Bearer <managed-auth-token>
 *
 *   Request:
 *     {
 *       "tool_name":         string,
 *       "input":             string,         // serialized tool input
 *       "platform":          string,
 *       "home_dir":          string,
 *       "workspace_root":    string,
 *       "mode":              "auto",
 *       "conversation_context": string,      // pre-rendered by daemon
 *       "agent_id":          string?,
 *       "session_id":        string?
 *     }
 *
 *   Response:
 *     {
 *       "base_resp": { "status_code": number, "status_msg": string },
 *       "verdict":   "allow" | "confirm" | "block",
 *       "reason":    string
 *     }
 *
 * The cloud side is intentionally untouched. Prompt assembly stays in the
 * local runtime (`packages/local-runtime/prompts/llm-gate-classifier.md`),
 * conversation context is rendered runtime-side (see `conversation-renderer.ts`),
 * and the cloud endpoint remains a thin wrapper around gemini-flash with the
 * same prompt baked in.
 *
 * Future-compatibility hooks:
 *   - `daemonPromptVersion` is sent so the cloud side can log/route by
 *     prompt revision when it adopts a registry. Unknown today, ignored
 *     server-side.
 *   - `suggestedRule` is reserved in the verdict shape so a future cloud
 *     response can carry a persistence recommendation without a wire bump.
 *     Today: cloud never returns it, the daemon never persists from a gateway
 *     verdict.
 */
export {};
//# sourceMappingURL=cloud-gateway.js.map