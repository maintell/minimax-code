/**
 * Terminal module types — shared between main, preload, and renderer.
 *
 * All payload shapes for the terminal IPC contract live here so that the
 * renderer-side `electronAPI.terminal` typings can re-use them without
 * pulling node-pty into the renderer build.
 */

export {};
