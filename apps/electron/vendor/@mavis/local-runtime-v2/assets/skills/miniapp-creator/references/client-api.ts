/**
 * Copyable Mini App Client declarations for TypeScript and JavaScript/JSDoc authoring.
 * No Host implementation or runtime import: Electron preload provides window.mcode.
 * Keep the .ts filename because Electron dependency packaging filters out .d.ts assets.
 * Node start(context) uses miniapp-api.ts instead. See client-api.md for usage and errors.
 */
export interface MiniAppMessageAPI {
  /**
   * Ask the user to append plain text to this Mini App's conversation input.
   * Accepts at most 100,000 UTF-16 code units and preserves spaces, tabs, and newlines.
   * An empty string still requires confirmation and leaves the draft unchanged.
   * Resolves after the confirmed append; rejects on cancellation or failure.
   * Does not send a message or insert, edit, or delete sent chat history.
   */
  append(text: string): Promise<void>;
}

export interface MiniAppClientAPI {
  readonly message: MiniAppMessageAPI;
}

export interface McodeClientAPI {
  readonly miniapp: MiniAppClientAPI;
}

declare global {
  interface Window {
    /** Absent outside a supported managed Mini App main page. Check before use. */
    readonly mcode?: McodeClientAPI;
  }
}
