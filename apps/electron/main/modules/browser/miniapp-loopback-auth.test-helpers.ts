import { vi } from "vitest";
/**
 * Minimal `Session.webRequest` double shared by the `registerMiniAppLoopbackAuth`
 * tests: captures the single registered `onBeforeSendHeaders` listener so a test
 * can invoke it directly without re-declaring the same mock shape twice.
 */
export function createFakeWebRequestSession() {
    const onBeforeSendHeaders = vi.fn();
    return {
        session: { webRequest: { onBeforeSendHeaders } },
        listener: () => onBeforeSendHeaders.mock.calls[0]?.[1],
    };
}
