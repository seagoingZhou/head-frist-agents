import { buildSessionContext, type CompactionEntry, type SessionEntry } from "../session-manager.ts";

import type { AgentMessage, StreamFn, ThinkingLevel } from "pi-agent-core";
import { streamSimple, type AssistantMessage, type Context, type Model, type SimpleStreamOptions, type Usage } from "pi-ai";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import {
	SUMMARIZATION_SYSTEM_PROMPT,
	createFileOps,
	extractFileOpsFromMessage,
	serializeConversation,
	type FileOperations,
} from "./utils.ts";

// ============================================================================
// 文件操作追踪:压缩段被摘要时记录 read/written/edited,摘要末尾带 <read-files>/<modified-files>
// ============================================================================

/** 存进 CompactionEntry.details 的文件追踪信息(供「上一次压缩」增量续接) */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * 从「本次要压缩的消息」+「上一次压缩的记录」合并出文件操作集合。
 * 上一轮的 read/written 先并进来(增量续接),再叠加本轮 toolCall 里的文件操作。
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// 先从上一轮压缩的 details 里收集(若是 pi 生成的;fromHook 仅供 session 文件兼容)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// 再叠加本轮消息工具调用里的文件操作
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}



// ============================================================================
// 类型
// ============================================================================

export interface CompactionSettings {
	/** 是否启用自动压缩 */
	enabled: boolean;
	/** 给 LLM 回复预留的 token 余量(上下文达到 window - reserve 就该压缩) */
	reserveTokens: number;
	/** 切割时「最近保留」的 token 预算(= findCutPoint 的 keepRecentTokens) */
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

// ============================================================================
// token 计算
// ============================================================================

/**
 * 从 usage 算总上下文 token:优先用原生 totalTokens 字段,否则由 input/output/cache 各分量补齐。
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * 取一条 assistant 消息的有效 usage(若有)。
 * aborted / error / 全零 的 usage 都跳过——它们没有可用的 token 数据。
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * 从会话 entries 里找最后一个有效的 assistant usage(作为当前上下文占用的基线)。
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * 估算消息列表的上下文 token:优先用「最后一个 assistant 的 usage」作为基线,
 * usage 之后的新消息再用 estimateTokens 逐条估算补齐。
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}


/**
 * 是否触发压缩:当 contextTokens 超过「窗口 - reserveTokens」时。
 * reserveTokens 是给下一轮 LLM 回复预留的余量——到阈值就该压缩,避免下一轮超窗。
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// 切割点检测(findCutPoint 及其辅助函数)
// ============================================================================

// 图片消息的估算字符数(教学代理:一张图 ≈ 4800 字符)
const ESTIMATED_IMAGE_CHARS = 4800;

/** 估算一条消息里文本/图片内容块的总字符数——token 估算代理的第一步(先数字符再除 4)。 */
function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * 用 chars/4 启发式估算一条消息的 token 数(教学代理;真实生产用 tokenizer)。
 * 保守起见会略微高估——宁可多留余量也不该超窗。
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

// ============================================================================
// 消息提取(entry → AgentMessage,供压缩/摘要用)
// ============================================================================

/**
 * 从 entry 里取出它对应的 AgentMessage;不产生 LLM 上下文消息的 entry 返回 undefined。
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/**
 * 找出所有「合法切割点」的索引:可切在 user / assistant / custom / bashExecution / 摘要类消息上。
 *
 * 三条规则:
 *  1. 绝不切在 toolResult——它必须紧跟发起它的 toolCall 一起保留;
 *  2. 切在带 toolCall 的 assistant 消息上时,它后面的 toolResult 会落在保留段、跟着保留;
 *  3. bashExecution 视作 user 消息(用户主动发起的上下文,是自然边界)。
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
				break;
		}

		// branch_summary / custom_message 本质是 user 角色消息,也是合法切割点
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * 找到包含 entryIndex 的那一轮的起点(user / bashExecution 消息),返回其索引。
 * 前面没有回合起点 → 返回 -1。
 * bashExecution 视作 user(回合边界之一)。
 * 供 findCutPoint 在「切进轮中」时定位被切回合的起点,好为切了一半的回合生成 turnPrefix 摘要。
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		// 分支摘要/自定义消息是 user 角色,可作回合起点
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

/**
 * 切割点结果。
 *  - firstKeptEntryIndex:保留段的第一条 entry 索引(从它开始保留);
 *  - turnStartIndex:若切进了一轮中间,该轮的 user 起点索引;非切轮中为 -1;
 *  - isSplitTurn:是否切在轮中(切割点不是 user 消息,需要给被切回合做 turnPrefix 摘要)。
 */
export interface CutPointResult {
	/** 从该索引开始保留(第一条被保留的 entry) */
	firstKeptEntryIndex: number;
	/** 被切那一轮的 user 起点索引;非切轮中为 -1 */
	turnStartIndex: number;
	/** 是否切在轮中(切割点不是 user 消息) */
	isSplitTurn: boolean;
}

/**
 * 在会话 entries 里找切割点,使得保留段大约等于 `keepRecentTokens`(语义同生产 compaction.ts:392)。
 *
 * 算法:从最新往最旧回走,累积估算 token;累积 >= keepRecentTokens 就在那附近切。
 *   只考虑 [startIndex, endIndex) 区间(不含 endIndex)。
 *
 * 能切在 user 或 assistant 上(绝不切 toolResult);切在带 toolCall 的 assistant 上时,
 * 它后面的 toolResult 会落在保留段、不会丢。
 *
 * 返回 CutPointResult(见类型注解):从哪保留、是否切中轮(给出该轮 user 起点)、是否切在轮中。
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {

	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// 从最新往最旧回走,累积估算 token(保留的是「最近的 keepRecentTokens」)
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // 兜底:从第一条合法切割点开始保留(优先留消息而非头部)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		// 累积该消息的估算 token
		const messageTokens = estimateTokens(entry.message);
		accumulatedTokens += messageTokens;

		// 超过预算 → 在这附近切
		if (accumulatedTokens >= keepRecentTokens) {
			// 选 ≥ i 的最近合法切割点(不落在非法位置,比如 toolResult 之间)
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}

	// 从 cutIndex 往前回扫,把「非消息」entry(bash/设置等)也带进保留段——它们不该被丢
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// 遇到会话头部 / 上次压缩边界就停(不能跨压缩段回扫)
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			// 遇到消息就停(消息是保留段起点,前面不再带)
			break;
		}
		// 把这个非消息 entry 纳入保留段
		cutIndex--;
	}

	// 判定是否切在轮中:切割点不是 user 消息,则在它前面找该轮的 user 起点
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};

}

// ============================================================================
// Compaction 准备(prepareCompaction,供扩展 / 后续 compact 使用)
// ============================================================================

/**
 * 压缩准备结果——一次压缩要用的全部信息(交给 compact() 去生成摘要并装配)。
 */
export interface CompactionPreparation {
	/** 保留段第一条 entry 的 UUID */
	firstKeptEntryId: string;
	/** 会被压缩成摘要并丢弃的旧消息 */
	messagesToSummarize: AgentMessage[];
	/** 若切在轮中,被切回合的消息(生成 turnPrefix 摘要) */
	turnPrefixMessages: AgentMessage[];
	/** 是否切在轮中(切割点不是 user 消息) */
	isSplitTurn: boolean;
	/** 被压缩段落的 token 数 */
	tokensBefore: number;
	/** 上一次压缩的摘要,用于增量更新(迭代压缩) */
	previousSummary?: string;
	/** 从 messagesToSummarize 提取的文件操作(摘要末尾的 <read-files>/<modified-files>) */
	fileOps: FileOperations;
	/** 本次压缩的配置(来自 settings.jsonl) */
	settings: CompactionSettings;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {

	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	// 取保留段第一条 entry 的 UUID
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // 会话需要迁移(旧会话的无 id entry)
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// 被压缩并丢弃的旧消息(→ messagesToSummarize)
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// 切在轮中时,被切回合的消息 → turnPrefix 摘要
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}

	// 从被压缩消息 + 上一次压缩 提取文件操作
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// 切在轮中时,turnPrefix 里也叠加文件操作
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// 初始压缩提示词:让模型把对话结构化摘要成 6-section(含 Critical Context)
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// 增量更新提示词(有上一次摘要时):保留既有信息 + 并入新消息,把 In Progress → Done 等
const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** 组一次摘要 LLM 调用的选项(maxTokens + signal + apikey;模型支持思考且开了就带上 reasoning)。 */
function createSummarizationOptions(
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	env: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
	// 注:教学版 SimpleStreamOptions 只有 temperature/maxTokens/signal/apikey/reasoning,
	// 没有生产的 headers/env/apiKey 字段,故此处不传它们(生产 createSummarizationOptions 有)。
	const options: SimpleStreamOptions = { maxTokens, signal, apikey: apiKey };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

/** 完成一次摘要调用:优先自定义 streamFn,否则走 streamSimple(流 → result)。 */
async function completeSummarization(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	const stream = await (streamFn ?? streamSimple)(model, context, options);
	return stream.result();
}

/**
 * 用 LLM 生成对话摘要(体走 streamFn;教学版用 mock)。
 * 若给了 previousSummary,走「更新摘要」提示词把旧摘要合并进来(迭代压缩)。
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
): Promise<string> {
	// 摘要的输出预算:min(0.8 × reserveTokens, 模型 maxTokens)
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	// 有上一次摘要 → 用「更新摘要」提示词增量;否则用初始提示词;可再附 customInstructions
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// 先转 LLM 标准消息(处理 bashExecution/custom 等自定义类型),再序列化成对话文本——
	// 让模型"读一段文本",避免它误以为要接着对话继续回复。
	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);

	// 对话文本用 <conversation> 包裹;有旧摘要再包 <previous-summary>
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions = createSummarizationOptions(
		model,
		maxTokens,
		apiKey,
		headers,
		env,
		signal,
		thinkingLevel,
	);

	const response = await completeSummarization(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		completionOptions,
		streamFn,
	);

	if (response.stopReason === "error") {
		throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	const textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	return textContent;
}