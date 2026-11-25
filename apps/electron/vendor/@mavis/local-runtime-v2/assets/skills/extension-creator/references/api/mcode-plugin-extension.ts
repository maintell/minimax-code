// Agent-facing Extension authoring declarations, generated from sdk/author; do not edit.
// The host provides these virtual modules; no package is installed or resolved from disk.
// Keep the .ts filename: dependency packaging excludes .d.ts files.
// init and preview copy these declarations to .minimax-plugin/types/mcode-plugin-extension/index.d.ts.

declare module '@minimax/mcode-plugin-extension' {
  type SPACING_TOKENS = readonly [
      "1",
      "1.5",
      "2",
      "3",
      "4",
      "5",
      "6"
  ];
  export type SpacingToken = (SPACING_TOKENS)[number];
  type SIZE_TOKENS = readonly [
      "xs",
      "sm",
      "base",
      "lg"
  ];
  export type SizeToken = (SIZE_TOKENS)[number];
  type WEIGHT_TOKENS = readonly [
      "default",
      "medium",
      "semibold"
  ];
  export type WeightToken = (WEIGHT_TOKENS)[number];
  type TONE_TOKENS = readonly [
      "primary",
      "secondary",
      "tertiary",
      "accent",
      "danger",
      "success",
      "warning"
  ];
  export type ToneToken = (TONE_TOKENS)[number];
  type RADIUS_TOKENS = readonly [
      "sm",
      "md",
      "lg",
      "full"
  ];
  export type RadiusToken = (RADIUS_TOKENS)[number];
  type BOX_DIRECTIONS = readonly [
      "row",
      "column"
  ];
  export type BoxDirection = (BOX_DIRECTIONS)[number];
  type BOX_ALIGNS = readonly [
      "start",
      "center",
      "end",
      "stretch"
  ];
  export type BoxAlign = (BOX_ALIGNS)[number];
  type BOX_JUSTIFIES = readonly [
      "start",
      "center",
      "end",
      "between"
  ];
  export type BoxJustify = (BOX_JUSTIFIES)[number];
  type HOVER_DISPLAYS = readonly [
      "show",
      "hide"
  ];
  export type HoverDisplay = (HOVER_DISPLAYS)[number];
  type BUTTON_VARIANTS = readonly [
      "default",
      "plain"
  ];
  export type ButtonVariant = (BUTTON_VARIANTS)[number];
  export const ICON_NAMES: readonly [
      "plus",
      "minus",
      "check",
      "close",
      "search",
      "refresh",
      "settings",
      "edit",
      "trash",
      "copy",
      "link",
      "external-link",
      "file",
      "folder",
      "code",
      "terminal",
      "play",
      "stop",
      "kanban",
      "list",
      "info",
      "warning",
      "error",
      "star",
      "user",
      "clock",
      "calendar",
      "bug",
      "branch",
      "plugin",
      "chevron-right",
      "chevron-down",
      "more"
  ];
  export type IconName = (typeof ICON_NAMES)[number];
  export const Icon: {
      readonly [N in IconName]: N;
  };
  export const ELEMENT_NAMES: readonly [
      "Box",
      "Text",
      "Markdown",
      "Code",
      "Tag",
      "Button",
      "Input",
      "Select",
      "Switch",
      "Spinner"
  ];
  export type ElementName = (typeof ELEMENT_NAMES)[number];
  interface BoxPresentationProps {
      readonly padding?: SpacingToken;
      readonly gap?: SpacingToken;
      readonly direction?: BoxDirection;
      readonly align?: BoxAlign;
      readonly justify?: BoxJustify;
      readonly wrap?: boolean;
      readonly grow?: boolean;
      readonly border?: boolean;
      readonly radius?: RadiusToken;
      readonly background?: ToneToken;
      readonly hover?: {
          readonly background?: ToneToken;
          readonly display?: HoverDisplay;
      };
      readonly scope?: string;
  }
  interface TextPresentationProps {
      readonly size?: SizeToken;
      readonly weight?: WeightToken;
      readonly tone?: ToneToken;
      readonly truncate?: boolean;
  }
  interface MarkdownPresentationProps {
      readonly text: string;
  }
  interface CodePresentationProps {
      readonly source: string;
      readonly language?: string;
  }
  interface TagPresentationProps {
      readonly label: string;
      readonly tone?: ToneToken;
  }
  interface ButtonPresentationProps {
      readonly label: string;
      readonly tone?: ToneToken;
      readonly size?: SizeToken;
      readonly disabled?: boolean;
      readonly icon?: IconName;
      readonly variant?: ButtonVariant;
  }
  interface InputPresentationProps {
      readonly value?: string;
      readonly placeholder?: string;
      readonly label?: string;
  }
  export interface SelectOption {
      readonly value: string;
      readonly label: string;
  }
  interface SelectPresentationProps {
      readonly value?: string;
      readonly options: readonly SelectOption[];
      readonly label?: string;
  }
  interface SwitchPresentationProps {
      readonly checked: boolean;
      readonly label?: string;
  }
  interface SpinnerPresentationProps {
      readonly label?: string;
  }
  export type Json = null | boolean | number | string | Json[] | {
      [key: string]: Json;
  };
  export interface Handle {
      readonly plugin: string;
      readonly handle: number;
  }
  export interface RenderCatalogElement {
      readonly type: ElementName;
      readonly key?: string;
      readonly props: Readonly<Record<string, Json | Handle>>;
      readonly children?: readonly RenderNode[];
  }
  export interface RenderHostNode {
      readonly type: "host";
  }
  export type RenderElement = RenderCatalogElement | RenderHostNode;
  export type RenderNode = string | RenderElement;
  export type RenderTree = RenderNode | readonly RenderNode[];
  export interface TreeLimits {
      readonly maxNodes: number;
      readonly maxDepth: number;
      readonly maxBytes: number;
      readonly maxTextLength: number;
      readonly maxHostNodes: number;
  }
  export const TREE_LIMITS: TreeLimits;
  interface Disposable$1 {
      dispose(): void;
  }
  export interface McpContent {
      readonly type: string;
      readonly [field: string]: Json;
  }
  export interface McpResult {
      readonly content: readonly McpContent[];
      readonly isError?: boolean;
  }
  export type McpCallOutcome = "not_dispatched" | "provider_reported" | "unknown_after_dispatch";
  export interface McpCallOptions {
      readonly signal?: AbortSignal;
  }
  export interface StoreChange {
      readonly key: string;
      readonly value: Json | undefined;
  }
  export interface ExtensionStore {
      get(key: string): Promise<Json | undefined>;
      set(key: string, value: Json): Promise<void>;
      delete(key: string): Promise<void>;
      keys(): Promise<string[]>;
      onDidChange(listener: (change: StoreChange) => void | Promise<unknown>): Disposable$1;
  }
  export type ClockCallback = () => void | Promise<unknown>;
  export interface ExtensionClock {
      after(ms: number, fn: ClockCallback): Disposable$1;
      every(ms: number, fn: ClockCallback): Disposable$1;
      now(): number;
  }
  export interface ToastOptions {
      readonly tone?: "secondary" | "success" | "warning" | "danger";
  }
  export interface PaneOpenOptions {
      readonly id: string;
      readonly title: string;
      readonly focus?: boolean;
  }
  export interface ExtensionUi {
      toast(text: string, opts?: ToastOptions): Promise<void>;
      invalidate(): void;
      open(options: PaneOpenOptions): Promise<void>;
      close(id: string): Promise<void>;
  }
  export type PromptFillMode = "replace" | "append";
  export type PromptFillReason = "draft" | "modal" | "no-composer";
  export type PromptFillResult = {
      readonly written: true;
  } | {
      readonly written: false;
      readonly reason: PromptFillReason;
  };
  export type PromptSuggestReason = "draft-not-empty" | "turn-running" | "dismissed" | "no-turn" | "no-composer";
  export type PromptSuggestResult = {
      readonly isShown: true;
  } | {
      readonly isShown: false;
      readonly reason: PromptSuggestReason;
  };
  export interface ExtensionPrompt {
      fill(args: {
          readonly text: string;
          readonly mode?: PromptFillMode;
      }): Promise<PromptFillResult>;
      suggest(args: {
          readonly text: string;
      }): Promise<PromptSuggestResult>;
      read(): Promise<{
          readonly text: string;
      }>;
  }
  export interface SessionContextPart {
      readonly kind: string;
      readonly tokens: number;
  }
  export interface SessionContextUsage {
      readonly window: number;
      readonly tokens?: number;
      readonly percent?: number;
      readonly breakdown?: readonly SessionContextPart[];
  }
  export interface SessionUsage {
      readonly startedAt: number;
      readonly context: SessionContextUsage;
      readonly rateLimits: readonly never[];
  }
  export interface ExtensionSession {
      readonly id: string;
      readonly cwd: string;
      readonly root?: string;
      readonly model: string;
      usage(): Promise<SessionUsage>;
  }
  export interface AgentSpawnSpec {
      readonly prompt: string;
      readonly description?: string;
      readonly agentType?: string;
      readonly model?: string;
  }
  export interface AgentSpawnResult {
      readonly agentId: string;
      readonly model: string;
  }
  export interface AgentInfo {
      readonly id: string;
      readonly description: string;
      readonly type: string;
      readonly status: "pending" | "running" | "waiting" | "idle" | "completed" | "failed" | "killed";
      readonly parentId?: string;
      readonly spawnedBy?: string;
      readonly name?: string;
  }
  export interface ExtensionAgent {
      list(): Promise<readonly AgentInfo[]>;
      spawn(spec: AgentSpawnSpec): Promise<AgentSpawnResult>;
  }
  export interface ExtensionContext {
      readonly agent: ExtensionAgent;
      readonly model: ExtensionModel;
      readonly plugin: {
          readonly id: string;
          readonly version: string;
      };
      readonly session: ExtensionSession;
      readonly mcp: {
          call(server: string, tool: string, args?: Json, opts?: McpCallOptions): Promise<McpResult>;
      };
      readonly store: ExtensionStore;
      readonly state: PluginState;
      readonly clock: ExtensionClock;
      readonly ui: ExtensionUi;
      readonly prompt: ExtensionPrompt;
  }
  export interface ModelCompleteRequest {
      readonly model: string;
      readonly prompt: string;
      readonly system?: string;
      readonly maxTokens?: number;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
  }
  export type ModelUsage = {
      readonly inputTokens: number;
      readonly outputTokens: number;
  };
  export type ModelCompleteReason = "empty-reply" | "timeout" | "aborted" | "model-unavailable" | "provider-error";
  export type ModelCompleteResult = {
      readonly isAnswered: true;
      readonly text: string;
      readonly usage?: ModelUsage;
  } | {
      readonly isAnswered: false;
      readonly reason: ModelCompleteReason;
      readonly usage?: ModelUsage;
  };
  export interface ExtensionModel {
      complete(request: ModelCompleteRequest): Promise<ModelCompleteResult>;
  }
  export interface StateFieldSpec<T extends Json = Json> {
      readonly default: T;
  }
  export type StateSpec = {
      readonly [key: string]: StateFieldSpec;
  };
  export type WidenState<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : T extends readonly (infer U)[] ? WidenState<U>[] : T extends object ? {
      [K in keyof T]: WidenState<T[K]>;
  } : T;
  export type StateValue<F> = F extends StateFieldSpec<infer T> ? WidenState<T> : never;
  export interface StateDeclaration<S extends StateSpec = StateSpec> {
      readonly spec: S;
  }
  export interface ExtensionStateRegistry {
  }
  export type RegisteredStateSpec = ExtensionStateRegistry extends {
      readonly spec: infer S extends StateSpec;
  } ? S : StateSpec;
  export interface TypedPluginState<S extends StateSpec> {
      get<K extends keyof S & string>(key: K): StateValue<S[K]>;
      set<K extends keyof S & string>(key: K, value: StateValue<S[K]>): Promise<void>;
      update<K extends keyof S & string>(key: K, fn: (value: StateValue<S[K]>) => StateValue<S[K]>): Promise<void>;
  }
  export interface UntypedPluginState {
      get(key: string): Json | undefined;
      set(key: string, value: Json): Promise<void>;
      update(key: string, fn: (value: Json | undefined) => Json): Promise<void>;
  }
  export type PluginState<S extends StateSpec = RegisteredStateSpec> = string extends keyof S ? UntypedPluginState : TypedPluginState<S>;
  export function defineState<const S extends StateSpec>(spec: S): StateDeclaration<S>;
  type EXTENSION_ERROR_CODES = readonly [
      "ARGUMENT_INVALID",
      "HOOK_MODULES_INVALID",
      "HOOK_MODULE_EXPORT_INVALID",
      "HOOK_MODULES_UNSUPPORTED_FORMAT",
      "MODS_NOT_SUPPORTED_YET",
      "EXTENSION_PACKAGE_INVALID",
      "EXTENSION_PACKAGE_SKIPPED",
      "EXTENSION_NAME_MISMATCH",
      "EXTENSION_EVENT_UNSUPPORTED",
      "EXTENSION_MATCHER_INVALID",
      "EXTENSION_DUPLICATE_ENTRY",
      "EXTENSION_REGISTER_SHAPE_INVALID",
      "EXTENSION_REGISTER_FAILED",
      "EXTENSION_ENTRY_MISMATCH",
      "EXTENSION_CALL_SHAPE_INVALID",
      "EXTENSION_STATE_SHAPE_INVALID",
      "EXTENSION_RENDER_SIDE_EFFECT",
      "EXTENSION_SHADOWING",
      "CALL_NOT_DECLARED",
      "EXTENSION_IMPORT_FORBIDDEN",
      "EXTENSION_COMPILE_FAILED",
      "EXTENSION_PREVIEW_NOT_ACTIVE",
      "EXTENSION_NAME_RESERVED",
      "EXTENSION_DISABLED",
      "STATE_WRITE_IN_RENDER",
      "PERMISSION_REQUIRED",
      "PERMISSION_DENIED",
      "CANCELLED",
      "PROMPT_READ_UNAVAILABLE",
      "AGENT_CONCURRENCY_LIMIT",
      "AGENT_UNKNOWN_TYPE",
      "AGENT_START_FAILED",
      "MCP_SERVER_AMBIGUOUS",
      "MCP_CALL_RATE_LIMITED",
      "GESTURE_QUEUE_FULL",
      "EXTENSION_CANDIDATE_DRIFTED",
      "EXTENSION_CORE_PROPS_INVALID",
      "INVOCATION_SETTLED",
      "ACTIVATION_RETIRED",
      "VIEW_LEASE_HELD",
      "EXTENSION_NEXT_TWICE"
  ];
  export type ExtensionErrorCode = (EXTENSION_ERROR_CODES)[number];
  export type ElementCallback<Args extends unknown[] = [
  ]> = (...args: Args) => void | Promise<unknown>;
  type ElementKey = string | number;
  type RenderChild = RenderNode | RenderTree | number | boolean | null | undefined;
  type RenderChildren = RenderChild | readonly RenderChildren[];
  type TextChild = string | number | boolean | null | undefined;
  type TextChildren = TextChild | readonly TextChildren[];
  export interface BoxProps extends BoxPresentationProps {
      readonly key?: ElementKey;
      readonly children?: RenderChildren;
  }
  export interface TextProps extends TextPresentationProps {
      readonly key?: ElementKey;
      readonly children?: TextChildren;
  }
  export interface MarkdownProps extends MarkdownPresentationProps {
      readonly key?: ElementKey;
  }
  export interface CodeProps extends CodePresentationProps {
      readonly key?: ElementKey;
  }
  export interface TagProps extends TagPresentationProps {
      readonly key?: ElementKey;
  }
  export interface ButtonProps extends ButtonPresentationProps {
      readonly key?: ElementKey;
      readonly onPress?: ElementCallback;
  }
  export interface InputProps extends InputPresentationProps {
      readonly key?: ElementKey;
      readonly onInput?: ElementCallback<[
          value: string
      ]>;
      readonly onSubmit?: ElementCallback<[
          value: string
      ]>;
  }
  export interface SelectProps extends SelectPresentationProps {
      readonly key?: ElementKey;
      readonly onSelect?: ElementCallback<[
          value: string
      ]>;
  }
  export interface SwitchProps extends SwitchPresentationProps {
      readonly key?: ElementKey;
      readonly onChange?: ElementCallback<[
          checked: boolean
      ]>;
  }
  export interface SpinnerProps extends SpinnerPresentationProps {
      readonly key?: ElementKey;
  }
  export interface ElementPropsMap {
      Box: BoxProps;
      Text: TextProps;
      Markdown: MarkdownProps;
      Code: CodeProps;
      Tag: TagProps;
      Button: ButtonProps;
      Input: InputProps;
      Select: SelectProps;
      Switch: SwitchProps;
      Spinner: SpinnerProps;
  }
  export type ExtensionSurface = "desktop" | "web" | "tui";
  export interface EntryMatcher {
      readonly id: string;
      readonly title: string;
      readonly icon?: IconName;
  }
  export type AbovePromptSiteProps = Readonly<Record<string, never>>;
  export type PaneSiteProps = Readonly<Record<string, never>>;
  export interface ExtensionSites {
      "above-prompt": {
          matcher: never;
          props: AbovePromptSiteProps;
          result: "band";
      };
      pane: {
          matcher: never;
          props: PaneSiteProps;
          result: "pane";
      };
  }
  export type ExtensionSlot = keyof ExtensionSites;
  export type RenderSlot = {
      [S in ExtensionSlot]: ExtensionSites[S]["result"] extends "tree" ? S : never;
  }[ExtensionSlot];
  export type BandSite = {
      [S in ExtensionSlot]: ExtensionSites[S]["result"] extends "band" ? S : never;
  }[ExtensionSlot];
  export type UiRenderSite = BandSite;
  export type SiteProps<S extends ExtensionSlot> = ExtensionSites[S]["props"];
  export type SiteMatcher<S extends ExtensionSlot> = ExtensionSites[S]["matcher"];
  export type SlotEvent<S extends ExtensionSlot = ExtensionSlot> = S extends ExtensionSlot ? {
      readonly slot: S;
      readonly key: string;
      readonly surface: ExtensionSurface;
      readonly props: Readonly<SiteProps<S>>;
  } : never;
  export type RenderNext<S extends ExtensionSlot> = (e?: SlotEvent<S>) => Promise<RenderTree>;
  export type RenderHook<S extends ExtensionSlot> = (ctx: ExtensionContext, e: SlotEvent<S>, next: RenderNext<S>) => RenderTree | Promise<RenderTree>;
  export interface UiRenderMatcher<S extends UiRenderSite = UiRenderSite> {
      readonly site: S;
  }
  export interface UiRenderEvent<S extends UiRenderSite = UiRenderSite> {
      readonly site: S;
  }
  export type UiDrawing = RenderTree | null | undefined;
  export type UiRenderNext = () => Promise<RenderTree>;
  export type UiRenderHook<S extends UiRenderSite = UiRenderSite> = (ctx: ExtensionContext, e: UiRenderEvent<S>, next: UiRenderNext) => UiDrawing | Promise<UiDrawing>;
  export interface PaneRenderMatcher {
      readonly site: "pane";
      readonly id?: string;
  }
  export interface PaneRenderEvent {
      readonly site: "pane";
      readonly id: string;
  }
  export type PaneRenderHook = (ctx: ExtensionContext, e: PaneRenderEvent, next: UiRenderNext) => UiDrawing | Promise<UiDrawing>;
  export interface ToolMatcher {
      readonly tool?: string;
      readonly server?: string;
  }
  interface ObserveEnvelope {
      readonly sessionId: string;
      readonly turnId: string;
      readonly agentId?: string;
  }
  export interface PromptAttachment {
      readonly kind: string;
      readonly name?: string;
  }
  export interface TurnStartEvent extends ObserveEnvelope {
      readonly startedAt: number;
      readonly prompt?: {
          readonly text: string;
          readonly attachments?: readonly PromptAttachment[];
      };
  }
  export interface TurnCompleteEvent extends ObserveEnvelope {
      readonly status: "completed" | "aborted" | "error";
      readonly durationMs: number;
      readonly usage?: {
          readonly inputTokens: number;
          readonly outputTokens: number;
      };
      readonly answer?: string;
      readonly answerTruncated?: true;
      readonly reason?: "answer" | "aborted" | "refusal" | "error";
  }
  export interface ToolCallEvent extends ObserveEnvelope {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly server?: string;
      readonly startedAt: number;
      readonly input?: Json;
  }
  export interface ToolResultEvent extends ObserveEnvelope {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status: "ok" | "error" | "denied";
      readonly durationMs: number;
      readonly output?: {
          readonly text?: string;
          readonly result?: Json;
      };
  }
  export interface SessionMeasureEvent {
      readonly sessionId: string;
      readonly context: SessionUsage["context"];
      readonly rateLimits: readonly never[];
      readonly changed: readonly "context"[];
  }
  export interface SessionStartEvent {
      readonly cwd: string;
  }
  export interface UiCloseEvent {
      readonly sessionId: string;
      readonly id: string;
  }
  export interface UiCloseMatcher {
      readonly id?: string;
  }
  export interface ExtensionObserveEvents {
      "session.start": {
          event: SessionStartEvent;
          matcher: never;
      };
      "turn.start": {
          event: TurnStartEvent;
          matcher: never;
      };
      "turn.complete": {
          event: TurnCompleteEvent;
          matcher: never;
      };
      "tool.call": {
          event: ToolCallEvent;
          matcher: ToolMatcher;
      };
      "tool.result": {
          event: ToolResultEvent;
          matcher: ToolMatcher;
      };
      "session.measure": {
          event: SessionMeasureEvent;
          matcher: never;
      };
      "ui.close": {
          event: UiCloseEvent;
          matcher: UiCloseMatcher;
      };
  }
  export type ObserveEventName = keyof ExtensionObserveEvents;
  export type ObserveEvent<E extends ObserveEventName> = Readonly<ExtensionObserveEvents[E]["event"]>;
  type ObserveEventsWithMatcher = {
      [E in ObserveEventName]: [
          ExtensionObserveEvents[E]["matcher"]
      ] extends [
          never
      ] ? never : E;
  }[ObserveEventName];
  export type ObserveHook<E extends ObserveEventName> = (ctx: ExtensionContext, e: ObserveEvent<E>) => void | Promise<unknown>;
  export interface On {
      <S extends UiRenderSite>(event: "ui.render", matcher: UiRenderMatcher<S>, hook: UiRenderHook<S>): void;
      (event: "ui.render", matcher: PaneRenderMatcher, hook: PaneRenderHook): void;
      <S extends RenderSlot>(slot: S, matcher: SiteMatcher<S>, hook: RenderHook<S>): void;
      <E extends ObserveEventName>(event: E, hook: ObserveHook<E>): void;
      <E extends ObserveEventsWithMatcher>(event: E, matcher: ExtensionObserveEvents[E]["matcher"], hook: ObserveHook<E>): void;
  }
  export type Register = (on: On, options?: Readonly<Record<string, never>>) => void;
  export { Disposable$1 as Disposable, };
  export {};
}

declare module '@minimax/mcode-plugin-extension/ui' {
  import { BoxAlign, BoxDirection, BoxJustify, BoxProps, ButtonProps, ButtonVariant, CodeProps, ElementCallback, Handle, HoverDisplay, ICON_NAMES, Icon, IconName, InputProps, Json, MarkdownProps, RadiusToken, RenderCatalogElement, RenderElement, RenderHostNode, RenderNode, RenderTree, SelectOption, SelectProps, SizeToken, SpacingToken, SpinnerProps, SwitchProps, TagProps, TextProps, ToneToken, WeightToken } from '@minimax/mcode-plugin-extension';
  export { BoxProps, ButtonProps, CodeProps, ElementCallback, ICON_NAMES, Icon, IconName, InputProps, MarkdownProps, SelectOption, SelectProps, SpinnerProps, SwitchProps, TagProps, TextProps };
  export const Box: (props: BoxProps) => RenderCatalogElement, Text: (props: TextProps) => RenderCatalogElement, Markdown: (props: MarkdownProps) => RenderCatalogElement, Code: (props: CodeProps) => RenderCatalogElement, Tag: (props: TagProps) => RenderCatalogElement, Button: (props: ButtonProps) => RenderCatalogElement, Input: (props: InputProps) => RenderCatalogElement, Select: (props: SelectProps) => RenderCatalogElement, Switch: (props: SwitchProps) => RenderCatalogElement, Spinner: (props: SpinnerProps) => RenderCatalogElement;
  export {};
}

declare module '@minimax/mcode-plugin-extension/jsx-runtime' {
  import { BoxAlign, BoxDirection, BoxJustify, BoxProps, ButtonProps, ButtonVariant, CodeProps, ElementCallback, ElementPropsMap, Handle, HoverDisplay, InputProps, Json, MarkdownProps, RadiusToken, RenderCatalogElement, RenderElement, RenderHostNode, RenderNode, RenderTree, SelectOption, SelectProps, SizeToken, SpacingToken, SpinnerProps, SwitchProps, TagProps, TextProps, ToneToken, WeightToken } from '@minimax/mcode-plugin-extension';
  type ELEMENT_NAMES = readonly [
      "Box",
      "Text",
      "Markdown",
      "Code",
      "Tag",
      "Button",
      "Input",
      "Select",
      "Switch",
      "Spinner"
  ];
  type ElementName = (ELEMENT_NAMES)[number];
  type CatalogIntrinsicElements = {
      [N in ElementName]: ElementPropsMap[N];
  };
  type Element = RenderTree;
  interface ElementChildrenAttribute {
      children: unknown;
  }
  interface IntrinsicAttributes {
      key?: string | number;
  }
  interface IntrinsicElements extends CatalogIntrinsicElements {
  }
  type JsxElementType = ElementName | ((props: never) => RenderTree);
  export const jsx: (type: JsxElementType, props: Readonly<Record<string, unknown>> | null, key?: string | number) => RenderTree, jsxs: (type: JsxElementType, props: Readonly<Record<string, unknown>> | null, key?: string | number) => RenderTree, Fragment: (props: {
      readonly children?: unknown;
  }) => RenderNode[];
  namespace JSX {
      export { Element, ElementChildrenAttribute, IntrinsicAttributes, IntrinsicElements };
  }
  export { JSX, };
  export {};
}

declare module '@minimax/mcode-plugin-extension/jsx-dev-runtime' {
  import { BoxAlign, BoxDirection, BoxJustify, BoxProps, ButtonProps, ButtonVariant, CodeProps, ElementCallback, ElementPropsMap, Handle, HoverDisplay, InputProps, Json, MarkdownProps, RadiusToken, RenderCatalogElement, RenderElement, RenderHostNode, RenderNode, RenderTree, SelectOption, SelectProps, SizeToken, SpacingToken, SpinnerProps, SwitchProps, TagProps, TextProps, ToneToken, WeightToken } from '@minimax/mcode-plugin-extension';
  import { JSX } from '@minimax/mcode-plugin-extension/jsx-runtime';
  type ELEMENT_NAMES = readonly [
      "Box",
      "Text",
      "Markdown",
      "Code",
      "Tag",
      "Button",
      "Input",
      "Select",
      "Switch",
      "Spinner"
  ];
  type ElementName = (ELEMENT_NAMES)[number];
  type JsxElementType = ElementName | ((props: never) => RenderTree);
  export const jsx: (type: JsxElementType, props: Readonly<Record<string, unknown>> | null, key?: string | number) => RenderTree, jsxs: (type: JsxElementType, props: Readonly<Record<string, unknown>> | null, key?: string | number) => RenderTree, Fragment: (props: {
      readonly children?: unknown;
  }) => RenderNode[];
  export function jsxDEV(type: JsxElementType, props: Readonly<Record<string, unknown>> | null, key?: string | number): RenderTree;
  export { JSX, };
  export {};
}

declare module '@minimax/mcode-plugin-extension/testing' {
  import { AbovePromptSiteProps, AgentInfo, AgentSpawnResult, AgentSpawnSpec, BandSite, ClockCallback, Disposable as Disposable$1, ExtensionAgent, ExtensionClock, ExtensionContext, ExtensionModel, ExtensionObserveEvents, ExtensionPrompt, ExtensionSession, ExtensionSites, ExtensionSlot, ExtensionStateRegistry, ExtensionStore, ExtensionSurface, ExtensionUi, Handle, Json, McpCallOptions, McpContent, McpResult, ModelCompleteReason, ModelCompleteRequest, ModelCompleteResult, ModelUsage, ObserveEvent, ObserveEventName, ObserveHook, On, PaneOpenOptions, PaneRenderEvent, PaneRenderHook, PaneRenderMatcher, PaneSiteProps, PluginState, PromptAttachment, PromptFillMode, PromptFillReason, PromptFillResult, PromptSuggestReason, PromptSuggestResult, Register, RegisteredStateSpec, RenderCatalogElement, RenderElement, RenderHook, RenderHostNode, RenderNext, RenderNode, RenderSlot, RenderTree, SessionContextPart, SessionContextUsage, SessionMeasureEvent, SessionStartEvent, SessionUsage, SiteMatcher, SiteProps, SlotEvent, StateFieldSpec, StateSpec, StateValue, StoreChange, ToastOptions, ToolCallEvent, ToolMatcher, ToolResultEvent, TurnCompleteEvent, TurnStartEvent, TypedPluginState, UiCloseEvent, UiCloseMatcher, UiDrawing, UiRenderEvent, UiRenderHook, UiRenderMatcher, UiRenderNext, UiRenderSite, UntypedPluginState, WidenState } from '@minimax/mcode-plugin-extension';
  type ELEMENT_NAMES = readonly [
      "Box",
      "Text",
      "Markdown",
      "Code",
      "Tag",
      "Button",
      "Input",
      "Select",
      "Switch",
      "Spinner"
  ];
  type ElementName = (ELEMENT_NAMES)[number];
  export type TestMcpHandler = (server: string, tool: string, args: Json | undefined) => McpResult | Promise<McpResult>;
  export type TestModelHandler = (request: ModelCompleteRequest) => ModelCompleteResult | Promise<ModelCompleteResult>;
  export interface TestComposer {
      readonly draft?: string;
      readonly suggest?: (text: string) => PromptSuggestResult;
  }
  export interface TestAgentHandlers {
      readonly list?: () => readonly AgentInfo[] | Promise<readonly AgentInfo[]>;
      readonly spawn?: (spec: AgentSpawnSpec) => AgentSpawnResult | Promise<AgentSpawnResult>;
  }
  export interface TestAgentCompletion {
      readonly agentId: string;
      readonly answer: string;
      readonly reason?: "answer" | "aborted" | "refusal" | "error";
  }
  interface MountCommon {
      readonly agent?: TestAgentHandlers;
      readonly model?: TestModelHandler;
      readonly composer?: TestComposer;
      readonly usage?: SessionUsage;
      readonly register: Register;
      readonly mcp?: TestMcpHandler;
      readonly clock?: "fake" | "real";
      readonly state?: Readonly<Record<string, Json>>;
  }
  export type UiRenderMountOptions<S extends UiRenderSite | "pane" = UiRenderSite | "pane"> = MountCommon & {
      readonly site: S;
  } & (S extends "pane" ? {
      readonly id: string;
  } : {
      readonly id?: never;
  });
  export interface MountOptions<S extends ExtensionSlot = ExtensionSlot> extends MountCommon {
      readonly slot: S;
      readonly key: string;
      readonly props?: SiteProps<S>;
      readonly match?: Readonly<Record<string, string>>;
      readonly core?: (e: SlotEvent<S>) => RenderTree | Promise<RenderTree>;
      readonly mods?: readonly Register[];
  }
  export type TestEffect = {
      readonly type: "ui.toast";
      readonly plugin: string;
      readonly text: string;
  } | {
      readonly type: "ui.open";
      readonly plugin: string;
      readonly id: string;
      readonly title: string;
      readonly focus?: boolean;
  } | {
      readonly type: "ui.close";
      readonly plugin: string;
      readonly id: string;
  } | {
      readonly type: "prompt.fill";
      readonly plugin: string;
      readonly text: string;
      readonly mode: "replace" | "append";
  } | {
      readonly type: "agent.spawn";
      readonly plugin: string;
      readonly spec: AgentSpawnSpec;
  };
  export interface TestDiagnostic {
      readonly code: string;
      readonly message: string;
      readonly fix?: string;
      readonly plugin?: string;
  }
  export interface MountedSite<S extends ExtensionSlot = ExtensionSlot> {
      readonly slot: S;
      readonly key: string;
      tree(): RenderTree;
      state(): Readonly<Record<string, Json>>;
      readonly diagnostics: readonly TestDiagnostic[];
      readonly effects: readonly TestEffect[];
      advance(ms: number): Promise<void>;
  }
  export interface NodeQuery {
      readonly type?: ElementName | "host";
      readonly key?: string;
      readonly label?: string;
      readonly text?: string | RegExp;
  }
  export interface FoundNode {
      readonly node: RenderCatalogElement | RenderHostNode;
      readonly path: readonly number[];
  }
  export interface WaitForOptions {
      readonly timeoutMs?: number;
  }
  export interface Matchers {
      toBe(expected: unknown): void;
      toEqual(expected: unknown): void;
      toBeTruthy(): void;
      toBeDefined(): void;
      toContain(expected: unknown): void;
      toMatch(expected: string | RegExp): void;
      readonly not: Omit<Matchers, "not">;
  }
  export type TestFunction = () => void | Promise<void>;
  export interface ExtensionTesting {
      mount<S extends UiRenderSite | "pane">(options: UiRenderMountOptions<S>): Promise<MountedSite<S>>;
      mount<S extends ExtensionSlot>(options: MountOptions<S>): Promise<MountedSite<S>>;
      find(site: MountedSite, query: NodeQuery): FoundNode | undefined;
      findAll(site: MountedSite, query: NodeQuery): FoundNode[];
      press(site: MountedSite, target?: FoundNode | NodeQuery, value?: Json): Promise<void>;
      waitFor<T>(assertion: () => T | Promise<T>, options?: WaitForOptions): Promise<T>;
      completeAgent(site: MountedSite, completion: TestAgentCompletion): Promise<void>;
      unmount(site: MountedSite): Promise<void>;
      test(name: string, fn: TestFunction): void;
      expect(actual: unknown): Matchers;
  }
  export const mount: {
      <S extends UiRenderSite | "pane">(options: UiRenderMountOptions<S>): Promise<MountedSite<S>>;
      <S extends ExtensionSlot>(options: MountOptions<S>): Promise<MountedSite<S>>;
  }, find: (site: MountedSite, query: NodeQuery) => FoundNode | undefined, findAll: (site: MountedSite, query: NodeQuery) => FoundNode[], press: (site: MountedSite, target?: FoundNode | NodeQuery, value?: Json) => Promise<void>, waitFor: <T>(assertion: () => T | Promise<T>, options?: WaitForOptions) => Promise<T>, completeAgent: (site: MountedSite, completion: TestAgentCompletion) => Promise<void>, unmount: (site: MountedSite) => Promise<void>, test: (name: string, fn: TestFunction) => void, expect: (actual: unknown) => Matchers;
  export {};
}
