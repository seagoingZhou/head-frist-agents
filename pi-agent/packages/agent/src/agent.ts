/**
 * Agent —— 教学仓 agent 引擎骨架(Phase-0 同名最小版)。
 *
 * 对齐 AgentSession 需要用的生产 `Agent`(pi-agent-core)接口面:
 *   subscribe / prompt / continue / hasQueuedMessages / state.messages / model / streamFn / isStreaming
 *   + beforeToolCall / afterToolCall(生产 AgentSession._installAgentToolHooks(:414)会挂这两个钩子)。
 *
 * ⚠️ 骨架:方法体均为 TODO 占位(不真跑)。后续实现要点(见 06 §九 Tier-4 Phase 2):
 *   · prompt / continue 内部"薄包 runAgentLoop"——把 emit 摊给 `_listeners`、
 *     新消息并入 `this.state.messages`、steer/followUp 队列经 getQueuedMessages 注入;
 *   · beforeToolCall / afterToolCall 透传给 AgentLoopConfig 对应字段;
 *   · 生产 agent.ts(:166-557)还有 steeringQueue/followUpQueue、runPromptMessages/runContinuation、
 *     runWithLifecycle/handleRunFailure/finishRun、signal/abort/waitForIdle/reset——Phase 2 逐一对齐加桩。
 */
import type { Model } from "pi-ai";
import type { AgentEvent, AgentMessage, AgentTool, AgentLoopConfig, StreamFn } from "./types.ts";

export interface AgentOptions {
	model: Model<any>;
	systemPrompt: string;
	tools?: AgentTool[];
	messages?: AgentMessage[];
	streamFn?: StreamFn;
	/** 每轮结束后取"要注入的排队消息"(用户打断/steer/followUp) */
	getQueuedMessages?: () => Promise<AgentMessage[]>;
	convertToLlm?: AgentLoopConfig["convertToLlm"];
	beforeToolCall?: AgentLoopConfig["beforeToolCall"];
	afterToolCall?: AgentLoopConfig["afterToolCall"];
}

export class Agent {
	/** 当前累积消息(AgentSession `agent.state.messages` 读的就是它;压缩后会被整体替换) */
	state: { messages: AgentMessage[] };
	model?: Model<any>;
	streamFn?: StreamFn;
	isStreaming = false;

	beforeToolCall?: AgentLoopConfig["beforeToolCall"];
	afterToolCall?: AgentLoopConfig["afterToolCall"];

	private _listeners = new Set<(event: AgentEvent) => void>();
	private _options: AgentOptions;

	constructor(options: AgentOptions) {
		this._options = options;
		this.model = options.model;
		this.streamFn = options.streamFn;
		this.state = { messages: [...(options.messages ?? [])] };
		this.beforeToolCall = options.beforeToolCall;
		this.afterToolCall = options.afterToolCall;
	}

	/** 注册事件监听,返回解绑函数(AgentSession 内部订阅用它做持久化/压缩钩子) */
	subscribe(listener: (event: AgentEvent) => void): () => void {
		// TODO(Phase 2): 真跑时由 emit 广播到这些监听者(并 await,纳入 run settlement)
		this._listeners.add(listener);
		return () => {
			this._listeners.delete(listener);
		};
	}

	/** 发一轮 prompt:把消息送进运行循环并推进 state.messages */
	async prompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		// TODO(Phase 2): 调 runAgentLoop(..., this._options),把 newMessages 并入 state.messages,并逐条 emit
		const arr = Array.isArray(messages) ? messages : [messages];
		this.state.messages.push(...arr); // 占位:仅入内存,不真跑
	}

	/** 有排队消息时再续跑一轮(生产 agent_end 后 queued 续跑用)。返回是否继续了 */
	async continue(): Promise<boolean> {
		// TODO(Phase 2): 有排队消息 → 以空 prompts + queued 注入再跑一轮 runAgentLoop
		return this.hasQueuedMessages();
	}

	/** 是否还有排队消息(steer/followUp/agent_end 扩展写入) */
	hasQueuedMessages(): boolean {
		// TODO(Phase 2): await this._options.getQueuedMessages?.() 是否非空
		return false;
	}
}