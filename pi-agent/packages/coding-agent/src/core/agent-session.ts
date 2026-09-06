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
 * ⚠️ Phase-0 协作者同名最小版尚未落地(见 06 §九 Tier-4 4.2)——本文件顶部用"占位类型"
 * 先顶住编译;对应模块建好后删除占位声明、改为 import 同名真实模块:
 *   · class Agent          → packages/agent 的 class Agent(薄包 runAgentLoop)
 *   · SettingsManager     → settings-manager.ts(最小: getCompactionSettings/getRetrySettings)
 *   · ModelRegistry       → model-registry.ts(最小: getApiKeyAndHeaders/isUsingOAuth)
 *   · BashResult / ContextUsage / SessionStats / ReplacedSessionContext → 各子系统落地后
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
import type { AssistantMessage, Message, Model, TextContent } from "pi-ai";
import { resolvePath } from "../utils/paths.ts";
import { ModelRegistry } from "./model-registry.ts";
import { SettingsManager } from "./settings-manager.ts";
import {
	type CompactionResult,
	type ReadonlySessionManager,
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
import type { BranchSummaryEntry, SessionManager } from "./session-manager.ts";
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

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"]; // 生产 :259

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

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		return this.agent.hasQueuedMessages();
	}

	/** :997 —— 入口:文本 + PromptOptions → _runAgentPrompt */
	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {

		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			// 后续实现，仅做注释占位
			if (expandPromptTemplates && text.startsWith("!")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			// Emit input event for extension interception (before skill/template expansion)
			// 后续实现，仅做注释占位

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			// 后续实现，仅做注释占位

			// If streaming, queue via steer() or followUp() based on option
			// 后续实现，仅做注释占位

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			// 校验 OAuth Configure
			// 后续实现，仅做注释占位

			// Check if we need to compact before sending (catches aborted responses)
			// 后续实现，仅做注释占位


			// Build messages array (custom message if any, then user message)
			messages = [];
			// Add user message
			// Inject any pending "nextTurn" messages as context alongside the user message
			// Emit before_agent_start extension event
			// Add all custom messages from extensions




			// Apply extension-modified system prompt, or reset to base
			// Ensure we're using the base prompt (in case previous turn had modifications)
			

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

	/** :1354 —— 最常用入口:归一化 content → prompt(expandPromptTemplates:false)。教学纯文本,生产另含 ImageContent。 */
	async sendUserMessage(content: string | TextContent[], options?: { deliverAs?: "steer" | "followUp" }): Promise<void> {
		const text = typeof content === "string" ? content : content.filter((c) => c.type === "text").map((c) => (c as TextContent).text).join("\n");
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			source: "extension",
		});
	}

	/** :1218 —— 流式中打断插话(教学 Phase 2 接入 agent.steer;生产另有 images?: ImageContent[]) */
	async steer(text: string): Promise<void> {
		void text;
		// TODO(Phase 2): this.agent.steer(...)
	}
	/** :1238 —— 流式中排队等下一轮 */
	async followUp(text: string): Promise<void> {
		void text;
		// TODO(Phase 2): this.agent.followUp(...)
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

		const model = this.agent.model!;
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
	 * :1816 —— agent_end 后判定。教学首版只走 threshold 路径:
	 *   settings.enabled? / skipAborted / 早于压缩边界则跳过(getLatestCompactionEntry,生产 :1835,
	 *   该辅助函数待补进 session-manager) / estimateContextTokens → shouldCompact。
	 * overflow 路径(Case 1,:1842-1874)依赖 isContextOverflow(pi-ai 未移植),后补。
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.agent.model?.contextWindow ?? 0;

		// TODO(压缩边界,生产 :1835): getLatestCompactionEntry(sessionManager.getBranch()) 判定
		//   assistantMessage.timestamp <= compactionEntry.timestamp → return false(防刚压完被旧 usage 再顶)
		const compactionEntry = null;

		if (compactionEntry && assistantMessage.timestamp <= new Date((compactionEntry as { timestamp: string }).timestamp).getTime()) {
			return false;
		}

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

		const model = this.agent.model!;
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
	getAvailableThinkingLevels(): ThinkingLevel[] {
		return THINKING_LEVELS; // 生产 :1590 按 model 过滤(getSupportedThinkingLevels,pi-ai 未移植)
	}
	supportsThinking(): boolean {
		return false; // TODO(Phase 5): :1598
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

		// 只读会话视图垫片:教学 SessionManager.getBranch 是 `fromId?: string`,
		// ReadonlySessionManager.getBranch 要求 `id: string | null`——生产 SessionManager 直接满足
		// 该接口,getBranch 签名对齐(to null)后此垫片即可删除。
		const view: ReadonlySessionManager = {
			getBranch: (id) => this.sessionManager.getBranch(id ?? undefined),
			getEntry: (id) => this.sessionManager.getEntry(id),
		};
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(view, oldLeafId, targetId);
		void commonAncestorId;

		if (options.summarize && entriesToSummarize.length > 0 && this.agent.model) {
			const g = await generateBranchSummary(entriesToSummarize, {
				model: this.agent.model,
				apiKey: (await this._getCompactionRequestAuth(this.agent.model)).apiKey ?? "",
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
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	setSessionName(name: string): void {
		// TODO(Phase 5): 生产 :2704 —— sessionManager.appendSessionInfo(name) + _emit(session_info_changed)
		void name;
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
		return this.agent.model;
	}
	get thinkingLevel(): ThinkingLevel {
		return "off"; // TODO(Phase 5): :762
	}
	get isStreaming(): boolean {
		return this.agent.isStreaming ?? false; // :767
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
		return undefined; // TODO(Phase 5): :864 —— sessionManager 无 getSessionName?生产用它
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
	 * Try to execute an extension command. Returns true if command was found and executed.
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


	