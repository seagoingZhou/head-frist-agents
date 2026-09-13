/**
 * AgentSession —— agent 生命周期与会话管理的核心抽象。
 *
 * 严格对齐生产 `packages/coding-agent/src/core/agent-session.ts`(3159 行):
 * 所有 public / private 方法名、签名、字段逐一照生产抄,不发明名字。
 * 教学版目标闭环三件事,全由生产方法名串联:
 *   能跑      sendUserMessage → prompt → _runAgentPrompt → _handlePostAgentRun
 *   能压缩    _handlePostAgentRun → _checkCompaction → _runAutoCompaction
 *   能恢复    _handleAgentEvent(持久化) + retry 家族 + reload + 防重复压缩
 *
 * 依赖(均已落地并 import):`Agent`(pi-agent-core)、`SettingsManager`(settings-manager.ts)、
 * `ModelRegistry`(model-registry.ts)。顶部仅剩 `ContextUsage`/`SessionStats`/`ReplacedSessionContext`/
 * `BashResult` 四个**外围子系统占位类型**(Phase 6 子系统落地后删除、改 import)。
 * 扩展子系统(ExtensionRunner / ResourceLoader)缺席 → 对应钩子留空,注释注明。
 */

// ============================================================================
// 外围子系统占位类型(Phase 6 子系统落地后删除并改 import;Agent/SettingsManager/ModelRegistry
// 已在下方改 import 同名真实骨架模块,见 settings-manager.ts / model-registry.ts / pi-agent-core Agent)
// ============================================================================

// 生产 ContextUsage(extensions ContextUsage) 最小形
type ContextUsage = { tokens: number; lastUsageIndex: number | null };
// 生产 SessionStats(:222) 最小形
interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	totalMessages: number;
}
// 生产 ReplacedSessionContext 最小形
interface ReplacedSessionContext {
	messages: AgentMessage[];
	systemPrompt: string;
}
// 生产 bash-executor.ts BashResult 最小形
interface BashResult {
	output: string;
	exitCode: number | undefined;
}

// ============================================================================
// 依赖(已存在的教学仓模块)
// ============================================================================

import type { Agent, AgentEvent, AgentMessage, ThinkingLevel } from "pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Model, TextContent } from "pi-ai";
import { getSupportedThinkingLevels, isContextOverflow } from "pi-ai";
import { resolvePath } from "../utils/paths.ts";
import { ModelRegistry } from "./model-registry.ts";
import { SettingsManager } from "./settings-manager.ts";
import {
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { BuildSystemPromptOptions } from "./system-prompt.ts";
import type { BranchSummaryEntry, ReadonlySessionManager, SessionManager } from "./session-manager.ts";
import { getLatestCompactionEntry } from "./session-manager.ts";
import type { BashOperations } from "./tools/bash.ts";
import { formatNoModelSelectedMessage } from "./auth-guidance.ts";

// ============================================================================
// 类型(对齐生产 :101-252,教学裁剪版)
// ============================================================================

/** 生产 :125 的裁剪版:砍掉 extensions 相关字段 */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean; // 生产 :130
	  }
	| { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] } // :133
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" } // :137
	| { type: "session_info_changed"; name: string | undefined } // :138
	| { type: "thinking_level_changed"; level: ThinkingLevel } // :139
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string; // :141-147
	  } // :145

export type AgentSessionEventListener = (event: AgentSessionEvent) => void; // :152

/** 教学子集:砍掉 extensions/baseToolsOverride/sessionStartEvent(需要时按生产 :158 补) */
export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	modelRegistry: ModelRegistry;
}

/** 对齐生产 :200(教学纯文本消息模型,砍掉 images?: ImageContent[]) */
export interface PromptOptions {
	expandPromptTemplates?: boolean;
	streamingBehavior?: "steer" | "followUp";
	source?: string;
	preflightResult?: (success: boolean) => void;
}

/** 对齐生产 :214(cycleModel 返回) */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	isScoped: boolean;
}

/** 标准思考级别(生产 :259;**不含 "xhigh"**——那是需要模型显式声明才支持的扩展档)。 */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

// ============================================================================
// AgentSession 类(:265)
// ============================================================================
export class AgentSession {
	// --- 协作者(生产 readonly,:266-268) ---
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// --- 事件订阅状态(:272-281) ---
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];

	// --- 压缩/重试/分支状态(:283-293) ---
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	private _branchSummaryAbortController: AbortController | undefined = undefined;
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// --- 首版不做的子系统字段(占位,注释注明) ---
	private _pendingBashMessages: BashExecutionMessage[] = [];
	private _turnIndex = 0;

	private _cwd: string;
	private _modelRegistry: ModelRegistry;
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;

	/** 生产 :484 —— 压缩/重试判定依据 */
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._cwd = config.cwd;
		this._modelRegistry = config.modelRegistry;

		// 生产 :352 —— 内部订阅 agent 事件(持久化/压缩/重试都靠它)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	// ============================================================================
	// 事件与持久化(:464-722)
	// ============================================================================

	/** :469 —— 广播给全部 listener(管道 A:session.subscribe) */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) l(event);
	}

	/** :475 */
	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	/**
	 * :487 —— agent 事件总闸。教学首版做四件事:
	 *   ① user message_start → 从 steer/followUp 队列剔除(:490-508);
	 *   ③ 广播(agent_end 附 willRetry,:514);
	 *   ④ 持久化:message_end 按类型 appendMessage / appendCustomMessageEntry(:517-534)——这是树与 loop 的唯一同步点;
	 *   ⑤ 跟踪 _lastAssistantMessage 并复位 overflow(:537-556)。(②扩展转发首版省略)
	 */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const t = this._getUserMessageText(event.message);
			if (t) {
				const si = this._steeringMessages.indexOf(t);
				if (si !== -1) this._steeringMessages.splice(si, 1);
				else {
					const fi = this._followUpMessages.indexOf(t);
					if (fi !== -1) this._followUpMessages.splice(fi, 1);
				}
				this._emitQueueUpdate();
			}
		}

		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		if (event.type === "message_end") {
			const msg = event.message;
			if (msg.role === "custom") {
				const cmsg = msg as CustomMessage;
				this.sessionManager.appendCustomMessageEntry(cmsg.customType, cmsg.content, cmsg.display, cmsg.details);
			} else if (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult") {
				this.sessionManager.appendMessage(msg); // 树 += 本轮消息
			}
			if (msg.role === "assistant") {
				this._lastAssistantMessage = msg as AssistantMessage;
				if ((msg as AssistantMessage).stopReason !== "error") this._overflowRecoveryAttempted = false;
			}
		}
	};

	/** :691 —— 注册 listener,返回解绑 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);
		return () => {
			const i = this._eventListeners.indexOf(listener);
			if (i !== -1) this._eventListeners.splice(i, 1);
		};
	}

	/** :728 */
	dispose(): void {
		this._disconnectFromAgent();
		this._eventListeners = [];
	}

	private _disconnectFromAgent(): void {
		this._unsubscribeAgent?.();
		this._unsubscribeAgent = undefined;
	}
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return;
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/** :560 —— agent_end 后判断是否 auto-retry(教学 Phase 4 再实装) */
	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		void event;
		// TODO(Phase 4): settingsManager.getRetrySettings() + 最后一条 assistant 判定(_isRetryableError)
		return false;
	}

	private _getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		return content.filter((c) => c.type === "text").map((c) => (c as TextContent).text).join("");
	}

	// ============================================================================
	// 发消息(prompt 族,:943-1350)
	// ============================================================================

	/** :947 —— 增收人:agent.prompt → 循环 _handlePostAgentRun + continue,直到没后续 */
	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		try {
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			this._flushPendingBashMessages();
		}
		
		
	}

	/**
	 * :958 —— agent_end 后收尾:先查重试(可重试→_prepareRetry 返回 true 续跑),
	 * 再 _checkCompaction(压了就结束本回合),最后看有没有 queued 消息要续。
	 */
	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;

		if (!msg) {
			return false;
		}
		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true; // Phase 4
		}
		if (await this._checkCompaction(msg)) {
			return true; // Phase 3
		}

		// agent loop 在发 agent_end 之前会把两条队列都 drain 干净;
		// 这里若还有排队消息,是 agent_end 扩展处理器新塞的,需要再续跑一轮
		return this.agent.hasQueuedMessages();
	}

	/**
	 * :997 —— 发送一条 prompt(入口:文本 + PromptOptions → _runAgentPrompt)。
	 * - 扩展命令(经 pi.registerCommand 注册)立即执行,流式中也照执行;
	 * - 默认展开"基于文件的 prompt 模板";
	 * - 流式中按 streamingBehavior 选项排队到 steer() 或 followUp();
	 * - 非流式发送前校验 model 与 API key。
	 * @throws 流式中未指定 streamingBehavior 时报错
	 * @throws 非流式且未选模型 / 无可用 API key 时报错
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {

		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			// 扩展命令优先处理(立即执行,流式中也照执行);扩展命令自己经 pi.sendMessage() 管理 LLM 交互
			// 后续实现,仅做注释占位
			if (expandPromptTemplates && text.startsWith("!")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// 扩展命令已执行,没有要发的 prompt
					preflightResult?.(true);
					return;
				}
			}

			// 发 input 事件给扩展做拦截(在 skill/模板展开之前)
			// 后续实现,仅做注释占位

			// 展开 skill 命令(/skill:name args)与 prompt 模板(/template args)
			// 后续实现,仅做注释占位

			// 流式中:按选项排队到 steer() 或 followUp()
			// 后续实现,仅做注释占位

			// 新 prompt 之前,先把待发的 bash 消息刷出去
			this._flushPendingBashMessages();

			// 校验 model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			// 校验 OAuth 配置
			// 后续实现,仅做注释占位

			// 发送前检查是否需要压缩(能兜住被中止的响应)
			// 后续实现,仅做注释占位


			// 组装 messages 数组(自定义消息在前,user 消息在后)
			messages = [];
			// 追加 user 消息
			// 把待处理的 "nextTurn" 消息作为上下文,与 user 消息一并注入
			// 发 before_agent_start 扩展事件
			// 追加来自扩展的全部自定义消息




			// 应用扩展改后的系统提示,或重置回 base
			// 确保用的是 base prompt(上一回合可能被扩展改过)
			

		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}
		preflightResult?.(true);

		messages.push(
			{
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			} as unknown as AgentMessage,
		)
		
		// TODO(Phase 2 丰满):skill 块解析 / 模板展开 → 组 user message → _runAgentPrompt
		await this._runAgentPrompt(messages);
	}

	/**
	 * 展开 skill 命令(/skill:name args)为完整内容。
	 * 若不是 skill 命令、或找不到该 skill,则原样返回;
	 * 读文件失败时经扩展 runner 报错。
	 */
	private _expandSkillCommand(text: string): string {
		// if (!text.startsWith("/skill:"))
			return text;

		// const spaceIndex = text.indexOf(" ");
		// const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		// const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		// const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		// if (!skill) return text; // 未知 skill → 原样透传

		// try {
		// 	const content = readFileSync(skill.filePath, "utf-8");
		// 	const body = stripFrontmatter(content).trim();
		// 	const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
		// 	return args ? `${skillBlock}\n\n${args}` : skillBlock;
		// } catch (err) {
		// 	// 像扩展命令那样报错
		// 	this._extensionRunner.emitError({
		// 		extensionPath: skill.filePath,
		// 		event: "skill_expansion",
		// 		error: err instanceof Error ? err.message : String(err),
		// 	});
		// 	return text; // 出错时返回原文
		// }
	}

	/** :1218 —— 流式中打断插话(教学 Phase 2 接入 agent.steer;生产另有 images?: ImageContent[]) */
	async steer(text: string,images?: ImageContent[]): Promise<void> {
		// 扩展命令不能被排队,先检查(是则抛错)
		// if (text.startsWith("/")) {
		// 	this._throwIfExtensionCommand(text);
		// }

		// 展开 skill 命令与 prompt 模板
		// let expandedText = this._expandSkillCommand(text);
		// expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
		const expandedText = text; // 教学首版不做 skill/template 展开,直接用原文本
		await this._queueSteer(expandedText, images);
	}
	/** :1238 —— 流式中排队等下一轮 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// 扩展命令不能被排队,先检查(是则抛错)
		// if (text.startsWith("/")) {
		// 	this._throwIfExtensionCommand(text);
		// }

		// 展开 skill 命令与 prompt 模板
		// let expandedText = this._expandSkillCommand(text);
		// expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
		const expandedText = text; // 教学首版不做 skill/template 展开,直接用原文本
		void expandedText;
		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * 内部:排队一条 steering 消息(文本已展开,无需再做扩展命令检查)。
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent)[] = [{ type: "text", text }];
		// if (images) {
		// 	content.push(...images);
		// }
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * 内部:排队一条 follow-up 消息(文本已展开,无需再做扩展命令检查)。
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent )[] = [{ type: "text", text }];
		// if (images) {
		// 	content.push(...images);
		// }
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * 若文本是扩展命令,则抛错(扩展命令不能被排队)。
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		// const command = this._extensionRunner.getCommand(commandName);

		// if (command) {
		// 	throw new Error(
		// 		`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
		// 	);
		// }
	}

	/** :1354 —— 最常用入口:归一化 content → prompt(expandPromptTemplates:false)。教学纯文本,生产另含 ImageContent。 */
	async sendUserMessage(content: string | TextContent[], options?: { deliverAs?: "steer" | "followUp" }): Promise<void> {
		const text = typeof content === "string" ? content : content.filter((c) => c.type === "text").map((c) => (c as TextContent).text).join("\n");
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			source: "extension",
		});
	}

	// ============================================================================
	// 压缩(:1652-2045)
	// ============================================================================

	/** :1652 —— 手动压缩:独立流程(生产即如此,不调 _runAutoCompaction)→ 返回 CompactionResult。 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		this._emit({ type: "compaction_start", reason: "manual" });
		this._compactionAbortController = new AbortController();

		const preparation = prepareCompaction(this.sessionManager.getBranch(), this.settingsManager.getCompactionSettings());
		if (!preparation) throw new Error("Nothing to compact");

		const model = this.agent.state.model!;
		const auth = await this._getCompactionRequestAuth(model);
		const result = await compact(
			preparation,
			model,
			auth.apiKey ?? "",
			auth.headers,
			customInstructions,
			this._compactionAbortController.signal,
			this.thinkingLevel,
			this.agent.streamFn,
			auth.env,
		);

		// 压缩生效三行(:1736-1739)
		this.sessionManager.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details);
		const ctx = this.sessionManager.buildSessionContext();
		this.agent.state.messages = ctx.messages;

		this._emit({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
		return result;
	}

	/**
	 * :1816 —— agent_end 后压缩判定,两条路径:
	 *   Case 1 **overflow**(:1823-1874):上一轮被上下文顶爆 → 压缩后**重试**本回合;
	 *   Case 2 **threshold**(:1876+):上下文渐涨过阈值 → 压缩,本回合正常结束。
	 * 前置:settings.enabled? / 消息非 aborted / 不是"压缩前旧消息"(getLatestCompactionEntry,生产 :1835)。
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.agent.state.model?.contextWindow ?? 0;

		// 只对"当前模型产出的消息"做 overflow 判定:用户从小窗模型(如 opus)切到大窗模型(如 codex)后,
		// 旧模型留下的 overflow 错误不该拿来压缩新模型的上下文——生产 :1829
		const sameModel =
			!!this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// 压缩边界:若当前 assistant 消息早于最近一次压缩点,说明它挂在压缩前的旧 usage 上,
		// 不能再据此触发压缩(否则刚压完就被旧 token 数顶爆)——生产 :1835
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());

		if (compactionEntry && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime()) {
			return false;
		}

		// Case 1:溢出的两种情形——报错型(LLM 直接报超窗)与静默型(成功但 usage 超配置窗口)。
		// 成功返回的那种("stop")该压但**不能重试**:回答已经完成了,agent.continue() 也无法从 assistant 消息续跑。
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			const willRetry = assistantMessage.stopReason !== "stop";

			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			// 只给一次"压缩 + 重试"机会;再来一次就认输并报错(生产 :1855)
			if (this._overflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}

			this._overflowRecoveryAttempted = true;
			// 把这条错误 assistant 消息从 agent 状态里摘掉:它仍留在会话里作为历史,但不该进重试的上下文
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", willRetry);
		}

		// Case 2:阈值——上下文渐涨,压掉旧段。
		// 错误消息 / usage 全零的消息:用最近一次有效响应估算,免得"持续报错(如 529)"的会话压不动、上下文账目也归不了零。
		let contextTokens: number;
		const direct = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (assistantMessage.stopReason === "error" || direct === 0) {
			const estimate = estimateContextTokens(this.agent.state.messages);
			if (estimate.lastUsageIndex === null) return false;
			contextTokens = estimate.tokens;
		} else {
			contextTokens = direct;
		}

		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * :1910 —— 自动压缩执行体(生产签名:reason 只取 "threshold" | "overflow",返回 **boolean**):
	 * 发 compaction_start(:1941)→ prepareCompaction 守卫 → 认证 → compact(:1987)→
	 * appendCompaction(:1736)→ buildSessionContext(:1738)→ 写回 agent.state.messages(:1739)→ 发 compaction_end(:1764)。
	 */
	private async _runAutoCompaction(reason: "threshold" | "overflow", willRetry: boolean): Promise<boolean> {
		// 生产 :1941 —— 开始事件(管道 A)
		this._emit({ type: "compaction_start", reason });
		this._autoCompactionAbortController = new AbortController();
		const signal = this._autoCompactionAbortController.signal;

		const pathEntries = this.sessionManager.getBranch();
		const preparation = prepareCompaction(pathEntries, this.settingsManager.getCompactionSettings());
		if (!preparation) {
			this._emit({ type: "compaction_end", reason, result: undefined, aborted: true, willRetry: false });
			return false;
		}

		const model = this.agent.state.model!;
		const auth = await this._getCompactionRequestAuth(model);

		const result = await compact(
			preparation,
			model,
			auth.apiKey ?? "",
			auth.headers,
			undefined,
			signal,
			this.thinkingLevel,
			this.agent.streamFn,
			auth.env,
		);

		// 压缩在两轮之间生效的三行(:1736-1739)
		this.sessionManager.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details);
		const ctx = this.sessionManager.buildSessionContext();
		this.agent.state.messages = ctx.messages;

		this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });
		return true;
	}

	/** :393 —— 压缩请求认证(教学:走 modelRegistry 最小版) */
	private async _getCompactionRequestAuth(model: Model<any>): Promise<{ apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }> {
		const r = await this._modelRegistry.getApiKeyAndHeaders(model);
		return r.ok ? { apiKey: r.apiKey, headers: r.headers, env: r.env } : {};
	}

	get isCompacting(): boolean {
		return this._autoCompactionAbortController !== undefined; // production 更严:正在压缩中
	}
	abortCompaction(): void {
		this._autoCompactionAbortController?.abort();
	}
	getContextUsage(): ContextUsage | undefined {
		// TODO(Phase 3): 生产 :2991 —— 基于 agent.state.messages 的 estimateContextTokens
		return undefined;
	}

	// ============================================================================
	// 模型 / 思考水平(Phase 5 可先只 setModel / setThinkingLevel)
	// ============================================================================
	async setModel(model: Model<any>): Promise<void> {
		void model;
		// TODO(Phase 5): 生产 :1453 —— sessionManager.appendModelChange + 重建系统提示 + thinking 适配
	}
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		void direction;
		return undefined; // TODO(Phase 5): :1476
	}
	setThinkingLevel(level: ThinkingLevel): void {
		void level;
		// TODO(Phase 5): :1546 —— sessionManager.appendThinkingLevelChange + _emit(session_info/thinking 变更)
	}
	cycleThinkingLevel(): ThinkingLevel | undefined {
		return undefined; // TODO(Phase 5): :1574
	}
	/**
	 * 当前模型可用的思考级别(生产 :1590)。
	 * 具体支持哪些由 provider 收敛:模型自身能力 + `thinkingLevelMap` 决定(见 pi-ai models.ts)。
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	// ============================================================================
	// 分支导航 / 队列 / 会话(:2690-2991)
	// ============================================================================

	/**
	 * :2724 —— 切分支:getLeafId → collectEntriesForBranchSummary → summarize 时
	 * generateBranchSummary → sessionManager.branchWithSummary / branch → buildSessionContext。
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();
		if (targetId === oldLeafId) return { cancelled: false };

		// 真实 SessionManager 直接满足 ReadonlySessionManager(生产类型即从它 Pick)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);
		void commonAncestorId;

		if (options.summarize && entriesToSummarize.length > 0 && this.agent.state.model) {
			const g = await generateBranchSummary(entriesToSummarize, {
				model: this.agent.state.model,
				apiKey: (await this._getCompactionRequestAuth(this.agent.state.model)).apiKey ?? "",
				signal: new AbortController().signal,
				streamFn: this.agent.streamFn,
			});
			const summaryEntry = this.sessionManager.branchWithSummary(
				entriesToSummarize[0].parentId,
				g.summary ?? "",
				{ readFiles: g.readFiles, modifiedFiles: g.modifiedFiles },
			);
			// 拿去 branchWithSummary 返回 id? 生产返回 BranchSummaryEntry;教学先回 cancelled:false
			void summaryEntry;
		} else {
			this.sessionManager.branch(targetId);
		}
		return { cancelled: false };
	}
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort(); // :1801
	}
	createReplacedSessionContext(): ReplacedSessionContext {
		// TODO(Phase 5): :3136 —— 换模型时重投影上下文
		return { messages: [], systemPrompt: "" };
	}

	clearQueue(): void {
		this._steeringMessages = [];
		this._followUpMessages = [];
		this._emitQueueUpdate();
	}
	getSteeringMessages(): string[] {
		return [...this._steeringMessages];
	}
	getFollowUpMessages(): string[] {
		return [...this._followUpMessages];
	}
	setSteeringMode(_mode: "all" | "one-at-a-time"): void {
		/* 生产 :1629 需 agent 支持;教学首版可空 */
	}
	setFollowUpMode(_mode: "all" | "one-at-a-time"): void {
		/* 生产 :1638 */
	}
	abort(): Promise<void> {
		// TODO(Phase 4): 生产 :1424 —— 中断当前运行(agent 与各 abort 控制器)
		return Promise.resolve();
	}
	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		void options;
		// TODO(Phase 4 恢复): 生产 :2456 —— sessionManager.setSessionFile → _buildIndex → buildSessionContext
	}

	/**
	 * 把待发的 bash 消息刷进 agent 状态与会话。
	 * 在 agent 回合结束后调用,以维持正确的消息顺序。
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// 进 agent 状态
			this.agent.state.messages.push(bashMessage);

			// 落会话
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// 会话管理(Session Management)
	// =========================================================================

	setSessionName(name: string): void {
		// 生产 :2704 —— 写一条 session_info entry,再把解析后的名字广播出去
		this.sessionManager.appendSessionInfo(name);
		this._emit({ type: "session_info_changed", name: this.sessionManager.getSessionName() });
	}
	getSessionStats(): SessionStats {
		// TODO(Phase 5): 生产 :2946
		return { sessionFile: this.sessionFile, sessionId: this.sessionId, userMessages: 0, assistantMessages: 0, totalMessages: 0 };
	}
	getLastAssistantText(): string | undefined {
		// TODO(Phase 5): 生产 :3108
		return undefined;
	}

	// --- getters(生产 :752-864) ---
	get state(): { messages: AgentMessage[] } {
		return this.agent.state;
	}
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}
	get thinkingLevel(): ThinkingLevel {
		return "off"; // TODO(Phase 5): :762
	}
	get isStreaming(): boolean {
		return this.agent.state.isStreaming ?? false; // :767
	}
	get retryAttempt(): number {
		return this._retryAttempt;
	}
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}
	get steeringMode(): "all" | "one-at-a-time" {
		return "all"; // TODO(Phase 5): :844
	}
	get followUpMode(): "all" | "one-at-a-time" {
		return "all"; // TODO(Phase 5): :849
	}
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName(); // :864
	}

	// ============================================================================
	// 重试(Phase 4)与外围子系统桩(Phase 6)
	// ============================================================================

	private async _prepareRetry(_message: AssistantMessage): Promise<boolean> {
		// TODO(Phase 4): 生产同区 —— 延迟 + agent 继续
		return false;
	}
	private _isRetryableError(_message: AssistantMessage): boolean {
		// TODO(Phase 4): 生产 _isRetryableError/_isNonRetryableProviderLimitError
		return false;
	}
	abortRetry(): void {
		this._retryAbortController?.abort(); // :2569
	}
	setAutoRetryEnabled(_enabled: boolean): void {
		/* Phase 4 */
	}
	setAutoCompactionEnabled(_enabled: boolean): void {
		/* Phase 3 走 settingsManager */
	}

	// —— 子系统未移植,占位同名方法(生产行号在注释)——
	async executeBash(
		_command: string,
		_onChunk?: (c: string) => void,
		_options?: { excludeFromContext?: boolean; operations?: BashOperations },
	): Promise<void> {
		/* 未移植: bash-executor(:2602) */
	}
	recordBashResult(_command: string, _result: BashResult, _options?: { excludeFromContext?: boolean }): void {
		/* 未移植: :2636 */
	}
	abortBash(): void {
		/* 未移植: :2665 */
	}
	exportToHtml(_path?: string): Promise<void> {
		return Promise.resolve(); // 未移植: export-html
	}
	exportToJsonl(): Promise<void> {
		return Promise.resolve(); // 未移植
	}
	bindExtensions(_bindings: unknown): void {
		/* 未移植: extensions 子系统 */
	}

	/**
	 * 尝试执行一条扩展命令。找到并执行成功则返回 true。
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {

		return false; // TODO
	}
}

// ============================================================================
// 关键实现提示(承上启下)
// ============================================================================
// 1. 阶段顺序:Phase 0(协作者)→ P1(生命周期)→ P2(能跑)→ P3(能压)→ P4(能恢复)→ P5(分支/模型)→ P6(外围)。
// 2. 三根主线由生产行号钉住:
//    · 持久化  _handleAgentEvent(:487) 的 message_end 分支 = 树与 loop 唯一同步点;
//    · 压缩时  appendCompaction(:1736)→buildSessionContext(:1738)→agent.state.messages=ctx(:1739) = “两轮之间生效”;
//    · 压缩判定 _checkCompaction(:1816) 必须先过“早于压缩边界则跳过”(:1835,getLatestCompactionEntry 待补进 session-manager)。
// 3. 命名纪律:此文件所有名字都能在生产 :NNN 找到;不发明。占位类型在对应模块落地后删除并改 import。


	