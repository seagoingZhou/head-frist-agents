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
    details: any
}

export interface AgentTool extends Tool {
    label : string;
    execute : (
        toolCallId : string,
        params : Record<string, unknown>,
        signal ?: AbortSignal,
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
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; partialResult: any }
  // Session lifecycle - emitted when the agent session is compacted to save memory
  | { type: "compaction"; summary: string; tokensBefore: number; firstKeptEntryId: string };
