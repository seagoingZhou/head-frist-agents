import type { 
    Api,
    Message, 
    Tool,
    Model,
    Context,
    StreamOptions,
    ToolResultMessage,
    AssistantMessage,
    AssistantMessageEventStream,
    AssistantMessageEvent,
    SimpleStreamOptions,
    TextContent

} from "pi-ai";
import { streamSimple } from "../../ai/src/stream";

/**
   * 控制单条 assistant 消息内多个工具调用的执行方式。
   *
   * - "sequential"（串行）：每个工具调用先完成「预处理 → 执行 → 收尾」，再开始下一个。
   * - "parallel"（并行）：工具调用先按顺序完成预处理，然后（允许并行的）工具并发执行。
   *   每个工具收尾后，`tool_execution_end` 事件按「完成顺序」发出；
   *   而 toolResult 消息产物则在更靠后按「assistant 原文顺序」发出。
   */
export type ToolExecutionMode = "sequential" | "parallel";

/** A single tool call content block emitted by an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;


/** Stream function - can return sync or Promise for async config lookup */
export type StreamFn = (
    ...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

export interface AgentToolResult {
    content : (TextContent)[];
    details: any;
    terminate?: boolean;      // true = 提示整批结束后终止 loop
}

export type AgentToolUpdateCallback = (partialResult: AgentToolResult) => void;

export interface AgentTool extends Tool {
    label : string;
    prepareArguments?: (args: unknown) => Record<string, unknown>;
    executionMode?: ToolExecutionMode;
    execute : (
        toolCallId : string,
        params : Record<string, unknown>,
        signal ?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback,
    ) => Promise<AgentToolResult>;
} 

/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
	/** System prompt included with the request. */
	systemPrompt: string;
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool[];
}


export interface AgentLoopConfig extends SimpleStreamOptions{

    model: Model<any>;


    /**
	 * Returns queued messages to inject into the conversation.
	 *
	 * Called after each turn to check for user interruptions or injected messages.
	 * If messages are returned, they're added to the context before the next LLM call.
	 */
	getQueuedMessages?: () => Promise<AgentMessage[]>;

    /**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * Contract: must not throw or reject. Return a safe fallback value instead.
	 * Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

    /**
	 * Tool execution mode.
	 * - "sequential": execute tool calls one by one
	 * - "parallel": preflight tool calls sequentially, then execute allowed tools concurrently;
	 *   emit `tool_execution_end` in tool completion order after each tool is finalized,
	 *   then emit tool-result message artifacts later in assistant source order
	 *
	 * Default: "parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * Called before a tool is executed, after arguments have been validated.
	 *
	 * Return `{ block: true }` to prevent execution. The loop emits an error tool result instead.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * Called after a tool finishes executing, before `tool_execution_end` and tool-result message events are emitted.
	 *
	 * Return an `AfterToolCallResult` to override parts of the executed tool result:
	 * - `content` replaces the full content array
	 * - `details` replaces the full details payload
	 * - `isError` replaces the error flag
	 * - `terminate` replaces the early-termination hint
	 *
	 * Any omitted fields keep their original values. No deep merge is performed.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;


}

/**
 * Result returned from `beforeToolCall`.
 *
 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * Partial override returned from `afterToolCall`.
 *
 * Merge semantics are field-by-field:
 * - `content`: if provided, replaces the tool result content array in full
 * - `details`: if provided, replaces the tool result details value in full
 * - `isError`: if provided, replaces the tool result error flag
 * - `terminate`: if provided, replaces the early-termination hint
 *
 * Omitted fields keep the original executed tool result values.
 * There is no deep merge for `content` or `details`.
 */
export interface AfterToolCallResult {
	content?: (TextContent)[];
	details?: unknown;
	isError?: boolean;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** Current agent context at the time the tool call is prepared. */
	context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** The executed tool result before any `afterToolCall` overrides are applied. */
	result: AgentToolResult;
	/** Whether the executed tool result is currently treated as an error. */
	isError: boolean;
	/** Current agent context at the time the tool call is finalized. */
	context: AgentContext;
}




/**
 * Events emitted by the Agent for UI updates.
 * These events provide fine-grained lifecycle information for messages, turns, and tool executions.
 */
export type AgentEvent =
    // Agent lifecycle  
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle - a turn is one assistant response + any tool calls/results
  | { type: "turn_start" }
  | { type: "turn_end";  message: AgentMessage; toolResults: ToolResultMessage[] }
  	// Message lifecycle - emitted for user, assistant, and toolResult messages
  | { type: "message_start"; message: AgentMessage }
  	// Only emitted for assistant messages during streaming
  | { type: "message_update"; message: AssistantMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: Message }
  	// Tool execution lifecycle
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }	
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean  }
  // Session lifecycle - emitted when the agent session is compacted to save memory
  | { type: "compaction"; summary: string; tokensBefore: number; firstKeptEntryId: string };
