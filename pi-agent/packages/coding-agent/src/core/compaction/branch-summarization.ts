/**
 * 分支摘要:切到会话树另一分支时,给"被放弃的旧分支"生成摘要,避免上下文丢失。
 * (collectEntriesForBranchSummary 找 LCA → prepareBranchEntries 收消息 → generateBranchSummary 出摘要)
 */
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import type { AgentMessage, StreamFn } from "pi-agent-core";
import type { Model, SimpleStreamOptions } from "pi-ai";
import  { completeSimple } from "pi-ai";


import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import { estimateTokens } from "./compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// Types —— 分支摘要的类型定义(结果 / 文件追踪 / 准备产物)
// ============================================================================

export interface BranchSummaryResult {
	summary?: string;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

/** 存进 BranchSummaryEntry.details 的文件追踪信息(读/改过哪些文件,供跨分支累积) */
export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}


/**
 * 分支摘要的准备产物 —— 一次 generateBranchSummary 需要的全部输入。
 * 对应生产 branch-summarization.ts:189 同形(05 Tier-3 步骤 2)。
 */
export interface BranchPreparation {
	/** 挑出来要做摘要的消息(时间序;从最新的往里收,tokenBudget 控制取多少) */
	messages: AgentMessage[];
	/** 从中提取的文件操作(摘要末尾 <read-files>/<modified-files>) */
	fileOps: FileOperations;
	/** messages 的估算 token 总和 */
	totalTokens: number;
}

/**
 * 生成分支摘要的一次调用所需的全部配置 —— 与生产 `generateBranchSummary` 同形。
 * (model/apiKey/headers/env/signal 是完整模型调用四要素;customInstructions 定制摘要焦点;
 * replaceInstructions 决定定制是"替换"还是"追加"默认提示;streamFn 走会话的流函数以保 SDK 行为一致)
 */
export interface GenerateBranchSummaryOptions {
	/** 用来做摘要的模型 */
	model: Model<any>;
	/** 模型的 API key */
	apiKey: string;
	/** 传给模型的 HTTP 请求头 */
	headers?: Record<string, string>;
	/** Provider 作用域的环境变量(如 ANTHROPIC_API_KEY 等) */
	env?: Record<string, string>;
	/** 取消信号:用户中断分支切换 → abort 摘要调用 */
	signal: AbortSignal;
	/** 定制摘要指令:追加到默认 5-section 提示词,聚焦要保留的内容 */
	customInstructions?: string;
	/** true 时 customInstructions 整体替换默认提示词,而不是追加 */
	replaceInstructions?: boolean;
	/** 留给 prompt + LLM 回复的 token 空间(摘要预算 = contextWindow − reserveTokens,默认 16384) */
	reserveTokens?: number;
	/**
	 * 会话的流函数。优先走它调 LLM,让 SDK 的请求行为(超时/重试/归因头)保持一致,
	 * 且不经过 agent 状态与事件管道(摘要是一次性辅助调用,不该污染主对话)。
	 */
	streamFn?: StreamFn;
}

/**
 * 分支摘要:用户切到会话树的另一个分支时,给"被放弃的旧分支"生成摘要。
 *
 * 与生产 `branch-summarization.ts` 同签名/算法。会话视图用 `ReadonlySessionManager`
 * (在本文件只读,不依赖会话层的写方法),真实 SessionManager 直接满足该类型。
 */

/** 收集结果:被放弃分支的 entries(时间序)+ 两条路径的最近公共祖先。 */
export interface CollectEntriesResult {
	/** 要做摘要的 entries(按时间序,公共祖先以下被放弃的分支) */
	entries: SessionEntry[];
	/** 新旧位置之间的公共祖先(LCA);无公共祖先时为 null */
	commonAncestorId: string | null;
}

/**
 * 找旧分支与新位置之间的公共祖先(LCA),并收集被放弃的旧分支 entries。
 * 算法(生产 branch-summarization.ts:102):
 *   1. 旧叶子无 → 无可摘要,返回空;
 *   2. 分别取两条 root-first 路径;目标路径从后往前找"也在旧路径里"的最深节点 = LCA;
 *   3. 从旧叶子沿 parentId 上溯到 LCA(不含 LCA),收集被放弃的分支,再 reverse 成时间序。
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// 没有旧的停留位置 → 没有可摘要的内容
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// 两条路径(均 root-first);旧路径用 Set 便于包含判定
	const oldPath = new Set(session.getBranch(oldLeafId).map((entry) => entry.id));
	const targetPath = session.getBranch(targetId);

	// targetPath root-first,从后往前找"也在旧路径里"的最深节点 = LCA(分叉点)
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// 从旧叶子沿 parentId 爬到公共祖先(不含),收集被放弃的分支
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;
	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	// 上溯是"叶子→根",reverse 成时间序(根→叶子)
	entries.reverse();

	return { entries, commonAncestorId };
}

// ============================================================================
// entry → AgentMessage 转换(prepareBranchEntries / generateBranchSummary 共用)
// ============================================================================

/**
 * 从 entry 取它对应的 AgentMessage(供摘要)。
 * 与 compaction.ts 的 getMessageFromEntry 相似,但额外处理 compaction / branch_summary 等条目。
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			// 跳过 toolResult:它的内容已包含在发起它的 assistant 的 toolCall 里,复用即可
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);

		// 这些条目不产生对话内容:thinking切换/换模型/自定义数据/标签/会话元信息一律不进摘要
		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "session_info":
			return undefined;
	}
}

/**
 * 按 token 预算挑出要做摘要的消息(从新到旧收,预算不够时优先保最近的上下文)。
 * 两遍式准备:
 *   pass 1:先收集全部 entries 的文件操作(含嵌套 branch_summary 的 details,做跨分支累积);
 *   pass 2:再按 tokenBudget 从最新往最旧收消息(预算 0 = 不限)。
 *
 * @param entries 时间序(根→叶)的 entries
 * @param tokenBudget 摘要最多吃多少 token(0 = 不限)
 */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// 第一遍:从全部 entries 收集文件操作——即使某些消息超预算不进摘要也要并。
	// 目的:嵌套 branch_summary 的 details 也并进来,readFiles/modifiedFiles 跨分支累积不丢。
	// 只并 pi 生成的摘要(fromHook !== true);扩展生成的由扩展自行管理。
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				// 改过的文件并进 edited 集:computeFileLists 会把它们从 readFiles 排除,并计入 modified
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	// 第二遍:从最新往最旧收集要摘要的消息(最近的上下文最重要),预算满了就停
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		// 顺带从 assistant 消息的 toolCall 提取文件操作(read→read、write/edit→modified)
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);

		// 加上这条会超预算吗?
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// 摘要类(compaction/branch_summary)是"重要历史":超预算也尽量塞,但留 10% 余量
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			// 预算已满,停止收集(Unshift 维持时间序:最新插到最前)
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };

}

// ============================================================================
// 摘要生成 —— generateBranchSummary 与其配套的两条提示词常量
// ============================================================================

/**
 * 拼在摘要开头的"前导说明":向未来的模型解释这段内容是什么——
 * "用户去过另一个对话分支,现在回来了";避免模型把摘要误当成要接着聊的对话正文。
 * (之所以独立成常量,是因为它和结构化摘要正文要分开存放:前导是装载说明,正文才是内容)
 */
const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

/**
 * 分支摘要的结构化提示词(5-section,无 Critical Context):
 * Goal / Constraints & Preferences / Progress(Done·InProgress·Blocked) / Key Decisions / Next Steps。
 * 与 compaction 方案的 6-section 相比少一段 Critical Context —— 分支是"旁支探索",
 * 回来的主线上已有那份关键上下文,5 段足够;maxTokens 也相应降到 2048(compaction 是 reserve 一半)。
 * 括号里的标答题模板(如 "(none)"/"[Decision]: rationale")是给模型的结构约束,防它自由发挥漏记。
 */
const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * 给"被放弃的旧分支 entries"生成结构化的分支摘要。
 *
 * 流程:prepareBranchEntries 按预算收消息 → convertToLlm + serializeConversation 序列化成纯文本
 * (防止模型把它当对话接着往下写)→ 拼 5-section 提示词 → 调 LLM(streamFn 优先,否则 completeSimple)
 * → 前面拼 preamble、末尾拼 <read-files>/<modified-files> 文件标签 → 返回 BranchSummaryResult。
 *
 * @param entries 要做摘要的 entries(时间序,根→叶;即 collectEntriesForBranchSummary 找到的被放弃分支)
 * @param options 一次调用所需的配置(见 GenerateBranchSummaryOptions)
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const {
		model,
		apiKey,
		headers,
		env,
		signal,
		customInstructions,
		replaceInstructions,
		reserveTokens = 16384,
		streamFn,
	} = options;

	// token 预算 = 模型上下文窗口 − 预留空间(reserveTokens 留给 prompt + LLM 回复),防止摘要把自己撑爆
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	// 先 convertToLlm 翻成 LLM 兼容消息,再 serializeConversation 序列化成纯文本片段。
	// 关键:序列化(而非直接传消息数组)让模型把它当成"待总结的资料"而非"要继续的对话",避免顺着对话往下聊。
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);

	// 拼提示词:replaceInstructions 时用定制指令整体替换默认 prompt;否则定制指令作为 "Additional focus" 追加
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	// 最终输入 = <conversation> 包裹的对话文本 + 指令;conversation 与指令分两段,模型更容易区分"资料"与"要求"
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	// 调 LLM 做摘要:优先走会话的 streamFn,让 SDK 请求行为(超时/重试/归因头)保持一致,
	// 且不经过 agent 状态/事件管道(摘要是一次性辅助调用,不该污染主对话)。
	// 无 streamFn 时退回 completeSimple 直连。
	const context = { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages };
	const requestOptions: SimpleStreamOptions = { apiKey, headers, env, signal, maxTokens: 2048 };

	const response = streamFn
		? await (await streamFn(model, context, requestOptions)).result()
		: await completeSimple(model, context, requestOptions);

	// 用户中断 → 不产出摘要(调用方拿到 aborted 决定要不要写空摘要);模型报错 → 返回错误信息
	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	if (response.stopReason === "error") {
		return { error: response.errorMessage || "Summarization failed" };
	}

	let summary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	// 开头拼 preamble:向未来模型说明"这段是分支探索的摘要",避免被误读为对话正文
	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	// 末尾追加文件标签:<read-files>/<modified-files> —— "改过哪些文件"比"聊过什么"更可验证,留作主线的落点
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary: summary || "No summary generated",
		readFiles,
		modifiedFiles,
	};

}

