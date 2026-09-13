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
    TextContent,
	streamSimple

} from "pi-ai";

/**
 * 控制 agent loop 到达"队列排放点"时,一次注入多少条排队的用户消息。
 *
 * - "all":到点就把队列里所有排队消息全部取走注入。
 * - "one-at-a-time":只取走最旧的一条,其余留到后续排放点再注入。
 */
export type QueueMode = "all" | "one-at-a-time";

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

/**
 * Agent 的公开状态(生产 agent/types.ts:322)。Agent 类把这些字段暴露给外部读/改:
 * 系统提示、模型、思考级别、工具与对话转录,以及运行期只读标志(是否流式中等)。
 *
 * `tools` / `messages` 用访问器属性(getter + setter):赋值时实现会**复制顶层数组**再存储,
 * 避免外部持有并继续改动的同一数组直接穿透进内部状态。
 */
export interface AgentState {
	/** 每次模型请求随带的系统提示词。 */
	systemPrompt: string;
	/** 后续轮次使用的当前模型。 */
	model: Model<any>;
	/** 后续轮次请求的思考/推理级别。 */
	thinkingLevel: ThinkingLevel;
	/** 可用工具。赋值时复制顶层数组。 */
	set tools(tools: AgentTool[]);
	get tools(): AgentTool[];
	/** 对话转录。赋值时复制顶层数组。 */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * agent 正在处理一个 prompt / continuation 期间为 true。
	 * 会一直保持 true,直到被 await 的 `agent_end` 监听器全部 settle。
	 */
	readonly isStreaming: boolean;
	/** 当前流式响应的部分 assistant 消息(若有)。 */
	readonly streamingMessage?: AgentMessage;
	/** 当前正在执行的工具调用 id 集合。 */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** 最近一次失败或被中止的 assistant 回合的错误信息(若有)。 */
	readonly errorMessage?: string;
}

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

/** 传给 `shouldStopAfterTurn` 的上下文。 */
export interface ShouldStopAfterTurnContext {
	/** 完成本回合的那条 assistant 消息。 */
	message: AssistantMessage;
	/** 传给前面 `turn_end` 事件的工具结果消息。 */
	toolResults: ToolResultMessage[];
	/** 本回合的 assistant 消息与工具结果都已追加后的当前 agent 上下文。 */
	context: AgentContext;
	/** 本次 loop 调用此刻退出时将返回的消息。prompt 运行含最初的 prompt 消息;continuation 运行不含已有上下文消息。 */
	newMessages: AgentMessage[];
}

/** agent loop 在发起下一次 provider 请求前使用的替换运行时状态。 */
export interface AgentLoopTurnUpdate {
	/** 下一次 provider 请求的上下文。 */
	context?: AgentContext;
	/** 下一次 provider 请求的模型。 */
	model?: Model<any>;
	/** 下一次 provider 请求的思考级别。 */
	thinkingLevel?: ThinkingLevel;
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

export interface AgentLoopConfig extends SimpleStreamOptions{

    model: Model<any>;


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
	 * 每次 LLM 调用时动态解析 API key。
	 *
	 * 适用于短时效的 OAuth token(如 GitHub Copilot)——它们可能在长时间工具执行阶段里过期。
	 *
	 * 契约:不得 throw 或 reject;取不到 key 时返回 undefined。
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Called after each turn fully completes and `turn_end` has been emitted.
	 *
	 * If it returns true, the loop emits `agent_end` and exits before polling steering or follow-up queues,
	 * without starting another LLM call. The current assistant response and any tool executions finish normally.
	 *
	 * Use this to request a graceful stop after the current turn, e.g. before context gets too full.
	 *
	 * Contract: must not throw or reject. Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	/**
	 * 在 `turn_end` 之后、loop 决定是否再发起一次 provider 请求之前调用。
	 * 返回替换用的 context/model/thinking 状态,以影响本次运行的下一个回合。
	 * 返回 undefined 表示继续沿用当前 context/config。
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * 返回要在运行中间注入对话的 steering(打断引导)消息。
	 *
	 * 在当前 assistant 回合执行完其工具调用后调用(除非 `shouldStopAfterTurn` 先退出)。
	 * 若返回了消息,会在下一次 LLM 调用前加入上下文;
	 * 当前 assistant 消息里的工具调用不会被跳过。
	 *
	 * 用于在 agent 干活过程中"引导"它。
	 *
	 * 契约:不得 throw 或 reject;没有 steering 消息时返回 []。
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 返回在 agent 本将停止之后要处理的 follow-up(后续)消息。
	 *
	 * 当 agent 已无更多工具调用、也无 steering 消息时调用。
	 * 若返回了消息,会加入上下文,agent 继续下一个回合。
	 *
	 * 用于"等 agent 干完再处理"的后续消息。
	 *
	 * 契约:不得 throw 或 reject;没有 follow-up 消息时返回 []。
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

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
 * 思考/推理级别(适用于支持该能力的模型)。
 * 注意:"xhigh" 只有部分模型家族支持——要判断某个具体模型是否支持,需读
 * `@earendil-works/pi-ai` 里的 model thinking-level 元数据。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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
