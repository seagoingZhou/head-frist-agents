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

/** assistant 消息发布的一个工具调用内容块。 */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;


/** 流函数——可返回同步或 Promise（用于异步解析配置）。 */
export type StreamFn = (
    ...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * 可扩展的自定义应用消息接口。
 * 应用可通过声明合并扩展：
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// 默认为空——应用通过声明合并扩展
}

/**
 * AgentMessage：LLM 标准消息 + 自定义消息的联合。
 * 该抽象让应用可以加入自定义消息类型，同时保持与基础 LLM 消息的类型安全与兼容。
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

/** 传给低层 agent loop 的上下文快照。 */
export interface AgentContext {
	/** 随请求携带的系统提示词。 */
	systemPrompt: string;
	/** 模型可见的对话记录。 */
	messages: AgentMessage[];
	/** 本次运行可用的工具。 */
	tools?: AgentTool[];
}


export interface AgentLoopConfig extends SimpleStreamOptions{

    model: Model<any>;


    /**
	 * 返回要注入对话的排队消息。
	 *
	 * 每轮结束后调用，检查用户打断或注入的消息。
	 * 若有返回，则在下一次 LLM 调用前加入上下文。
	 */
	getQueuedMessages?: () => Promise<AgentMessage[]>;

    /**
	 * 每次 LLM 调用前，把 AgentMessage[] 转成 LLM 兼容的 Message[]。
	 *
	 * 每个 AgentMessage 必须转成 LLM 能理解的 UserMessage / AssistantMessage / ToolResultMessage。
	 * 无法转换的 AgentMessage（如仅 UI 的通知、状态消息）应被过滤掉。
	 *
	 * 契约：不得 throw 或 reject，应返回安全的回退值。
	 * 抛错会中断低层 agent loop，产生不正常的事件序列。
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // 把自定义消息转成 user 消息
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // 过滤掉仅 UI 的消息
	 *     return [];
	 *   }
	 *   // 标准 LLM 消息直接透传
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

    /**
	 * 在 `convertToLlm` 之前对上下文做的可选变换。
	 *
	 * 用于在 AgentMessage 层面进行的操作：
	 * - 上下文窗口管理（裁掉旧消息）
	 * - 注入外部来源的上下文
	 *
	 * 契约：不得 throw 或 reject，应返回原消息或其他安全回退值。
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

    /**
	 * 工具执行模式。
	 * - "sequential"（串行）：每个工具调用先完成「预处理 → 执行 → 收尾」，再开始下一个
	 * - "parallel"（并行）：工具调用先按顺序完成预处理，然后（允许并行的）工具并发执行；
	 *   每个工具收尾后，`tool_execution_end` 按完成顺序发出；
	 *   而 toolResult 消息产物则在更靠后按「assistant 原文顺序」发出
	 *
	 * 缺省："parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * 在工具执行前、参数校验后调用。
	 *
	 * 返回 `{ block: true }` 可阻止执行，loop 改为发出错误工具结果。
	 * 钩子会收到 agent 的 abort 信号，并负责遵守它。
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * 在工具执行完成后、`tool_execution_end` 与 toolResult 消息事件发出前调用。
	 *
	 * 返回 `AfterToolCallResult` 可覆盖已执行工具结果的某些部分：
	 * - `content` 整块替换 content 数组
	 * - `details` 整块替换 details 载荷
	 * - `isError` 替换错误标记
	 * - `terminate` 替换提前终止提示
	 *
	 * 未提供的字段保留原值，不做深合并。
	 * 钩子会收到 agent 的 abort 信号，并负责遵守它。
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;


}

/**
 * `beforeToolCall` 的返回结果。
 *
 * 返回 `{ block: true }` 会阻止工具执行，loop 改为发出错误工具结果。
 * `reason` 成为该错误结果中显示的文本；缺省则用默认的被阻止提示。
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * `afterToolCall` 返回的部分覆盖。
 *
 * 按字段合并：
 * - `content`：若提供，整块替换工具结果的 content 数组
 * - `details`：若提供，整块替换工具结果的 details 值
 * - `isError`：若提供，替换错误标记
 * - `terminate`：若提供，替换提前终止提示
 *
 * 未提供的字段保留已执行工具结果的原值。
 * `content` 与 `details` 不做深合并。
 */
export interface AfterToolCallResult {
	content?: (TextContent)[];
	details?: unknown;
	isError?: boolean;
	/**
	 * 提示 agent 在当前工具批处理结束后停止。
	 * 只有当批内每个收尾的工具结果都把此项设为 true 时，才会提前终止。
	 */
	terminate?: boolean;
}

/** 传给 `beforeToolCall` 的上下文。 */
export interface BeforeToolCallContext {
	/** 发起该工具调用的 assistant 消息。 */
	assistantMessage: AssistantMessage;
	/** `assistantMessage.content` 里的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 针对目标工具 schema 校验后的参数。 */
	args: unknown;
	/** 预处理工具调用时的当前 agent 上下文。 */
	context: AgentContext;
}

/** 传给 `afterToolCall` 的上下文。 */
export interface AfterToolCallContext {
	/** 发起该工具调用的 assistant 消息。 */
	assistantMessage: AssistantMessage;
	/** `assistantMessage.content` 里的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 针对目标工具 schema 校验后的参数。 */
	args: unknown;
	/** 应用任何 `afterToolCall` 覆盖之前的已执行工具结果。 */
	result: AgentToolResult;
	/** 已执行工具结果当前是否被当作错误。 */
	isError: boolean;
	/** 收尾工具调用时的当前 agent 上下文。 */
	context: AgentContext;
}




/**
 * agent 为 UI 更新发出的事件。
 * 这些事件提供消息、回合、工具执行的细粒度生命周期信息。
 */
export type AgentEvent =
    // Agent 生命周期
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // 回合生命周期 —— 一个回合 = 一次 assistant 回复 + 相关工具调用/结果
  | { type: "turn_start" }
  | { type: "turn_end";  message: AgentMessage; toolResults: ToolResultMessage[] }
  	// 消息生命周期 —— user / assistant / toolResult 消息都会发
  | { type: "message_start"; message: AgentMessage }
  	// 仅 assistant 消息在流式过程中发出
  | { type: "message_update"; message: AssistantMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  	// 工具执行生命周期
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean  }
  // 会话生命周期 —— agent 会话被压缩以省内存时发出
  | { type: "compaction"; summary: string; tokensBefore: number; firstKeptEntryId: string };
