/**
 * 上下文溢出检测 —— 对齐生产 `ai/src/utils/overflow.ts`。
 *
 * 为什么需要它:不同 provider 对"输入超窗"的反应五花八门——多数返回错误(各家文案不同),
 * 少数**静默接受**甚至**静默截断**。压缩要靠它判断"上一轮是不是被上下文顶爆了",
 * 才能决定走 overflow 压缩 + 重试。
 */
import type { AssistantMessage } from "../types.ts";

/**
 * 各家 provider 超窗报错的文案特征(逐条照抄生产,勿改——正则都经过实测)。
 *
 * 已知形态举例:
 * - Anthropic:`prompt is too long: 213462 tokens > 200000 maximum`
 * - Anthropic:`413 {"error":{"type":"request_too_large",...}}`
 * - OpenAI:`Your input exceeds the context window of this model`
 * - Google:`The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)`
 * - xAI:`This model's maximum prompt length is 131072 but the request contains 537812 tokens`
 * - Groq:`Please reduce the length of the messages or completion`
 * - OpenRouter:`This endpoint's maximum context length is X tokens. However, you requested about Y tokens`
 * - Together AI:`The input (X tokens) is longer than the model's context length (Y tokens).`
 * - llama.cpp:`the request exceeds the available context size, try increasing it`
 * - LM Studio:`tokens to keep from the initial prompt is greater than the context length`
 * - GitHub Copilot:`prompt token count of X exceeds the limit of Y`
 * - MiniMax:`invalid params, context window exceeds limit`
 * - Kimi For Coding:`Your request exceeded model token limit: X (requested: Y)`
 * - Cerebras:`400/413 status code (no body)`
 * - Mistral:`Prompt contains X tokens ... too large for model with Y maximum context length`
 * - Ollama:`prompt too long; exceeded max context length by X tokens`
 * - z.ai:**不报错**,静默接受 → 靠 usage.input > contextWindow 兜(Case 2)
 * - Xiaomi MiMo:把输入截到刚好填满窗口,然后返回 stopReason "length" + output=0(Case 3)
 */
const OVERFLOW_PATTERNS = [
	/prompt is too long/i, // Anthropic 超 token
	/request_too_large/i, // Anthropic 请求体字节超限(HTTP 413)
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI(Completions 与 Responses API)
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI 兼容代理(LiteLLM)
	/input token count.*exceeds the maximum/i, // Google(Gemini)
	/maximum prompt length is \d+/i, // xAI(Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter(多数后端)
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp server
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/too large for model with \d+ maximum context length/i, // Mistral
	/model_context_window_exceeded/i, // z.ai 非标准 finish_reason,以错误文本形式出现
	/prompt too long; exceeded (?:max )?context length/i, // Ollama 显式超窗
	/context[_ ]length[_ ]exceeded/i, // 通用兜底
	/too many tokens/i, // 通用兜底
	/token limit exceeded/i, // 通用兜底
	/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i, // Cerebras:400/413 且无响应体
];

/**
 * 这些文案**不是**超窗(限流 / 服务不可用等),即便同时命中上面的超窗正则也要排除。
 *
 * 例子:Bedrock 把限流包成 `ThrottlingException: Too many tokens, please wait...`,
 * 会误命中 /too many tokens/i,必须靠本表挡掉。
 */
const NON_OVERFLOW_PATTERNS = [
	/^(Throttling error|Service unavailable):/i, // AWS Bedrock 的非超窗错误(formatBedrockError 加的易读前缀)
	/rate limit/i, // 通用限流
	/too many requests/i, // 通用 HTTP 429 文案
];

/**
 * 判断一条 assistant 消息是否表示"上下文溢出"(生产 ai/utils/overflow.ts:126)。
 *
 * 三种情形:
 * 1. **报错型**:多数 provider → `stopReason === "error"` 且 errorMessage 命中 OVERFLOW_PATTERNS(先过 NON_OVERFLOW_PATTERNS 排除);
 * 2. **静默型**(z.ai):请求成功,但 `usage.input + cacheRead > contextWindow`;
 * 3. **截断型**(Xiaomi MiMo):输入被截到刚好填满窗口 → `stopReason === "length"` 且 `output === 0`
 *    且输入 ≥ 99% 窗口。
 *
 * ⚠️ 情形 2/3 需要传 `contextWindow` 才生效——**不传就只能识别报错型**(情形 1)。
 *
 * @param message 要检查的 assistant 消息
 * @param contextWindow 可选:模型上下文窗口,用于识别静默/截断型溢出
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	// 情形 1:错误文案匹配(先排除限流这类"看着像其实不是"的)
	if (message.stopReason === "error" && message.errorMessage) {
		const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!));
		if (!isNonOverflow && OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) {
			return true;
		}
	}

	// 情形 2:静默溢出(z.ai 风格)——成功返回,但输入已超窗
	if (contextWindow && message.stopReason === "stop") {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens > contextWindow) {
			return true;
		}
	}

	// 情形 3:截断型溢出(Xiaomi MiMo 风格)——服务端把超长输入截到刚好填满窗口,没给输出留空间
	if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens >= contextWindow * 0.99) {
			return true;
		}
	}

	return false;
}

/** 取出超窗正则表(给测试用;生产同名)。 */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}
