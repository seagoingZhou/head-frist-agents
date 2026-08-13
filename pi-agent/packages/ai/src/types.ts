import { OpenAICompletionsOptions } from "./providers/openai-completions";
import { AssistantMessageEventStream } from "./utils/event-stream";



export type Api =
	| "openai-completions"
	;


export interface ApiOptionsMap {
	"openai-completions": OpenAICompletionsOptions;
}


// Compile-time exhaustiveness check - this will fail if ApiOptionsMap doesn't have all KnownApi keys
type _CheckExhaustive = ApiOptionsMap extends Record<Api, StreamOptions>
	? Record<Api, StreamOptions> extends ApiOptionsMap
		? true
		: ["ApiOptionsMap is missing some KnownApi values", Exclude<Api, keyof ApiOptionsMap>]
	: ["ApiOptionsMap doesn't extend Record<KnownApi, StreamOptions>"];
const _exhaustive: _CheckExhaustive = true;

// Helper type to get options for a specific API
export type OptionsForApi<TApi extends Api> = ApiOptionsMap[TApi];

export type KnownProvider =
	| "anthropic"
	| "google"
	| "google-gemini-cli"
	| "google-antigravity"
	| "openai"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "zai"
	| "mistral";
export type Provider = KnownProvider | string;

export type TextContent = { type: "text"; text: string };

export type ToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type Usage = {
  input: number;
  output: number;
  totalTokens: number;
};

export type UserMessage = {
  role: "user";
  content: TextContent[];
  timestamp: number;
};

export type AssistantMessage = {
  role: "assistant";
  content: Array<TextContent | ToolCall>;
  stopReason: "stop" | "toolUse" | "error" | "aborted";
  usage: Usage;
  timestamp: number;
  errorMessage?: string;
};

export type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: TextContent[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
};

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolResult = {
  content: TextContent[];
  details?: unknown;
  terminate?: boolean;
};

export type StreamFunction<TApi extends Api> = (
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
) => AssistantMessageEventStream;
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apikey?: string;
}

export interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ReasoningEffort;
}



export type SessionEntry =
  | { type: "session"; version: 1; id: string; timestamp: string; cwd: string }
  | { type: "message"; id: string; parentId: string | null; timestamp: string; message: Message }
  | {
      type: "compaction";
      id: string;
      parentId: string | null;
      timestamp: string;
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
    };

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";



/**
 * Event protocol for AssistantMessageEventStream.
 *
 * Streams should emit `start` before partial updates, then terminate with either:
 * - `done` carrying the final successful AssistantMessage, or
 * - `error` carrying the final AssistantMessage with stopReason "error" or "aborted"
 *   and errorMessage.
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };
	

export type SessionResponse = {
  sessionId: string;
  messages: Message[];
  tools: Tool[];
  entries: SessionEntry[];
};

export interface OpenAICompat {
	/** Whether the provider supports the `store` field. Default: auto-detected from URL. */
	supportsStore?: boolean;
	/** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
	supportsDeveloperRole?: boolean;
	/** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
	supportsReasoningEffort?: boolean;
	/** Which field to use for max tokens. Default: auto-detected from URL. */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** Whether tool results require the `name` field. Default: auto-detected from URL. */
	requiresToolResultName?: boolean;
	/** Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. */
	requiresAssistantAfterToolResult?: boolean;
	/** Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL. */
	requiresThinkingAsText?: boolean;
	/** Whether tool call IDs must be normalized to Mistral format (exactly 9 alphanumeric chars). Default: auto-detected from URL. */
	requiresMistralToolIds?: boolean;
}

export interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl?: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost:{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compact?: TApi extends "openai-completions" ? OpenAICompat : never;
}
