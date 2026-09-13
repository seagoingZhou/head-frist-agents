import { describe, expect, it } from "vitest";
import { createAssistantMessage, type Model } from "pi-ai";
import { Agent, type StreamFn } from "pi-agent-core";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { convertToLlm } from "../src/core/messages.ts";
import type { CompactionSettings } from "../src/core/compaction/compaction.ts";

/** 教学/测试专用 mock model */
const mockModel: Model<"mock"> = {
	id: "mock",
	name: "Mock Model",
	api: "mock",
	provider: "mock",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

/** mock streamFn:固定产出一条文本 assistant(stop)。 */
function mockAssistantStream(text: string): StreamFn {
	return async () => {
		const msg = createAssistantMessage([{ type: "text", text }], "stop");
		const stream = await import("pi-ai").then((m) => new m.AssistantMessageEventStream());
		stream.push({ type: "start", partial: msg });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: msg });
		stream.push({ type: "done", reason: "stop", message: msg });
		stream.end(msg);
		return stream;
	};
}

/** 关掉自动压缩,让本测试专注「能跑」(压缩另有 compaction.test.ts 覆盖)。 */
const NO_COMPACTION: CompactionSettings = { enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 };

/** 组装一个最小可跑的 AgentSession(内存会话,不落盘)。 */
function buildSession(assistantText: string) {
	const agent = new Agent({
		initialState: { systemPrompt: "你是教学 Agent。", model: mockModel, messages: [], tools: [] },
		convertToLlm,
		streamFn: mockAssistantStream(assistantText),
	});
	const sessionManager = SessionManager.inMemory("/test");
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: new SettingsManager({ compactionSettings: NO_COMPACTION }),
		cwd: "/test",
		modelRegistry: new ModelRegistry(),
	});
	return { agent, sessionManager, session };
}

describe("Phase 2 —— 每轮闭环「能跑」:sendUserMessage → prompt → agent.prompt → runAgentLoop", () => {
	it("跑完一轮:树长出 user+assistant、listener 收到完整事件序、context 可压扁", async () => {
		const { sessionManager, session } = buildSession("你好呀,我是 mock");
		const events: AgentSessionEvent["type"][] = [];
		session.subscribe((e) => events.push(e.type));

		await session.sendUserMessage("你好");

		// ① 会话树长出 user + assistant(同步点在 AgentSession._handleAgentEvent 的 message_end → appendMessage)
		const entries = sessionManager.getEntries();
		expect(entries.map((e) => e.type)).toEqual(["message", "message"]);
		expect(entries.map((e) => (e.type === "message" ? e.message.role : e.type))).toEqual(["user", "assistant"]);

		// ② listener 收到完整生命周期事件序(只取核心生命周期;message_update/queue_update 等属增量/UI 事件)
		const LIFECYCLE = new Set(["agent_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end"]);
		const lifecycle = events.filter((t) => LIFECYCLE.has(t));
		expect(lifecycle).toEqual([
			"agent_start",
			"turn_start",
			"message_start", // user
			"message_end", // user
			"message_start", // assistant
			"message_end", // assistant
			"turn_end",
			"agent_end",
		]);
		expect(events).toContain("message_update"); // assistant 是流式产出的

		// ③ buildSessionContext 把树压扁成给 LLM 的线性 messages
		const ctx = sessionManager.buildSessionContext();
		expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

		// ④ agent.state.messages 与树同步
		expect(session.state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("convertToLlm 边界:压扁后的 messages 能翻成标准三角色", async () => {
		const { sessionManager, session } = buildSession("收到");
		await session.sendUserMessage("在吗");

		const llm = convertToLlm(sessionManager.buildSessionContext().messages);
		expect(llm.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("setSessionName:写 session_info entry → sessionName 可读回 + 广播 session_info_changed", () => {
		const { sessionManager, session } = buildSession("x");
		const events: AgentSessionEvent["type"][] = [];
		session.subscribe((e) => events.push(e.type));

		expect(session.sessionName).toBeUndefined();
		session.setSessionName("修 bug");

		expect(session.sessionName).toBe("修 bug");
		expect(sessionManager.getEntries().map((e) => e.type)).toEqual(["session_info"]);
		expect(events).toEqual(["session_info_changed"]);
	});
});
