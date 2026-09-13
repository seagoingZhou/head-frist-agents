import { OpenAICompletionsOptions } from "./providers/openai-completions";
import { AssistantMessageEventStream } from "./utils/event-stream";



export type Api =
  | "openai-completions"
  | "mock"
  ;


export interface ApiOptionsMap {
  "openai-completions": OpenAICompletionsOptions;
  "mock": StreamOptions;
}


// 编译期穷尽性校验:若 ApiOptionsMap 没覆盖全部 Api 键,这里会编译报错
type _CheckExhaustive = ApiOptionsMap extends Record<Api, StreamOptions>
  ? Record<Api, StreamOptions> extends ApiOptionsMap
  ? true
  : ["ApiOptionsMap is missing some KnownApi values", Exclude<Api, keyof ApiOptionsMap>]
  : ["ApiOptionsMap doesn't extend Record<KnownApi, StreamOptions>"];
const _exhaustive: _CheckExhaustive = true;

// 取某个具体 API 的 options 类型的辅助类型
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
export type ProviderId = KnownProvider | string;

/**
 * pi 的思考级别 —— 注意**不含 "off"**(生产 ai/src/types.ts:74):
 * "off" 是"模型级开关"的取值,归 ModelThinkingLevel 管,别混用。
 */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
/** 模型可接受的思考级别 = "off" 关掉 + 全部 ThinkingLevel(生产 :75)。 */
export type ModelThinkingLevel = "off" | ThinkingLevel;
/**
 * 把 pi 思考级别映射到"某 provider/模型专有的取值"(生产 :76)。
 * 缺键 = 用 provider 默认;显式 `null` = 该级别**不受支持**。
 */
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;


export type TextContent = { type: "text"; text: string };

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /** 思考块的签名,如 OpenAI responses 的 reasoning item ID */
  thinkingSignature?: string;
  /** 为 true 时,思考内容被安全过滤器脱敏(redacted)。不透明的加密载荷存在
   *  `thinkingSignature` 里,以便回传给 API、维持多轮对话的连续性。 */
  redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	/** base64 编码的图片数据 */
	data: string;
	/** MIME 类型,如 "image/jpeg"、"image/png" */
	mimeType: string;
}

export type ToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** `cacheWrite` 中按 1 小时保留期写入的子集。只有 Anthropic 会报告这一拆分。 */
  cacheWrite1h?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export type UserMessage = {
  role: "user";
  content: TextContent[];
  timestamp: number;
};

export type AssistantMessage = {
  role: "assistant";
  content: Array<TextContent | ToolCall | ThinkingContent>;
  api: Api;
  provider: ProviderId;
  model: string;
  stopReason: StopReason;
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

/** 各思考级别对应的 token 预算(仅按 token 计费的 provider 支持) */
export interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

/** Provider 作用域的环境变量覆盖:取值优先于 process.env。 */
export type ProviderEnv = Record<string, string>;
export type ProviderHeaders = Record<string, string | null>;

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  /**
	 * 优先使用的传输方式(仅对支持多传输的 provider 有效)。
	 * 不支持该选项的 provider 会忽略它。
	 */
	transport?: Transport;

  /**
	 * 可选的会话标识,供支持"按会话缓存"的 provider 使用。
	 * 可用于开启 prompt 缓存、请求路由等会话感知能力;不支持的 provider 忽略。
	 */
	sessionId?: string;

  /**
	 * 可选的请求头,随 API 请求发送。
	 * 会与 provider 默认头合并,调用方给出的值覆盖默认值。
	 * 在 AWS Bedrock 上,这些头经 Smithy `build` 中间件注入,因而纳入 SigV4 签名范围;
	 * 保留头(`x-amz-*`、`authorization`、`host`)会被静默忽略,以保 SigV4 / bearer 认证。
	 * 值为 null 表示抑制同名 provider/API 默认头。
	 */
	headers?: ProviderHeaders;

  /**
	 * HTTP 请求超时(毫秒),仅对支持它的 provider/SDK 有效。
	 * 例如 OpenAI、Anthropic 的 SDK 客户端默认 10 分钟。
	 */
	timeoutMs?: number;
	/**
	 * WebSocket 连接超时(毫秒),仅对支持 WebSocket 传输的 provider 有效。
	 * 只管连接/握手阶段;连接建立后的流空闲由 timeoutMs 控制。
	 */
	websocketConnectTimeoutMs?: number;
	/**
	 * 客户端重试的最大次数,仅对支持客户端重试的 provider/SDK 有效。
	 * 例如 OpenAI、Anthropic 的 SDK 客户端默认 2 次。
	 */
	maxRetries?: number;
	/**
	 * 服务端要求长时间重试等待时,可接受的最大延迟(毫秒)。
	 * 若服务端请求的延迟超过此值,请求立即失败,错误信息里带上被要求的延迟,
	 * 交由上层重试逻辑带用户可见性地处理。
	 * 默认 60000(60 秒);设为 0 取消上限。
	 */
	maxRetryDelayMs?: number;
	/**
	 * 可选的请求元数据,随 API 请求发送。
	 * provider 只提取它认识的字段、其余忽略。
	 * 例如 Anthropic 用 `user_id` 做滥用追踪与限流。
	 */
	metadata?: Record<string, unknown>;

  /**
	 * Provider 作用域的环境变量。对 provider 配置(区域设置、endpoint 占位符、代理变量等)
	 * 而言,这些值优先于 process.env。
	 */
	env?: ProviderEnv;
}

export interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ReasoningEffort;
  /** 各思考级别的自定义 token 预算(仅按 token 计费的 provider 支持) */
  thinkingBudgets?: ThinkingBudgets;
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




/**
 * AssistantMessageEventStream 的事件协议。
 *
 * 流应先发 `start`,随后是若干部分更新,最后以二者之一终结:
 * - `done`:携带最终成功的 AssistantMessage;
 * - `error`:携带最终 AssistantMessage,其 stopReason 为 "error" 或 "aborted",并带 errorMessage。
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
  /** provider 是否支持 `store` 字段。默认:按 URL 自动探测。 */
  supportsStore?: boolean;
  /** provider 是否支持 `developer` 角色(相对于 `system`)。默认:按 URL 自动探测。 */
  supportsDeveloperRole?: boolean;
  /** provider 是否支持 `reasoning_effort`。默认:按 URL 自动探测。 */
  supportsReasoningEffort?: boolean;
  /** max tokens 用哪个字段名。默认:按 URL 自动探测。 */
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  /** 工具结果是否必须带 `name` 字段。默认:按 URL 自动探测。 */
  requiresToolResultName?: boolean;
  /** 工具结果之后的 user 消息是否必须中间夹一条 assistant 消息。默认:按 URL 自动探测。 */
  requiresAssistantAfterToolResult?: boolean;
  /** thinking 块是否必须转成用 <thinking> 包裹的文本块。默认:按 URL 自动探测。 */
  requiresThinkingAsText?: boolean;
  /** 工具调用 id 是否必须规整为 Mistral 格式(恰好 9 位字母数字)。默认:按 URL 自动探测。 */
  requiresMistralToolIds?: boolean;
}

export interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl?: string;
  reasoning: boolean;
  /**
   * 把 pi 思考级别映射到 provider/模型专有取值。
   * 缺键用 provider 默认;`null` 标记该级别不受支持(生产 ai/src/types.ts:671)。
   */
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: {
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

/** 各思考级别对应的 token 预算(仅按 token 计费的 provider 支持) */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

