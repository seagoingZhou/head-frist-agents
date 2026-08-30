import { describe, expect, it } from "vitest";
import { createAssistantMessage, createUserMessage, type Model, type UserMessage } from "pi-ai";
import type { AgentMessage, AgentEventSink, StreamFn } from "pi-agent-core";
import {
	compact,
	estimateTokens,
	findCutPoint,
	generateSummary,
	prepareCompaction,
	shouldCompact,
	type CompactionPreparation,
} from "../src/core/compaction/compaction.ts";
import { DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from "../src/core/compaction/compaction.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { convertToLlm, createCompactionSummaryMessage } from "../src/core/messages.ts";

/** 教学/测试专用 mock model */
const mockModel: Model<"mock"> = {
	id: "mock", name: "Mock Model", api: "mock", provider: "mock", reasoning: false,
	input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
};

/** 返回一段固定摘要文本的 mock streamFn(供 generateSummary/compact)。 */
function mockSummaryStream(summaryText: string): StreamFn {
	return async (_model, _ctx, _opts) => {
		const msg = createAssistantMessage([{ type: "text", text: summaryText }], "stop");
		const head = msg;
		// 构造完整事件的 EventStream:start → text → done(与 mock provider 同款)
		const stream = await import("pi-ai").then((m) => new m.AssistantMessageEventStream());
		stream.push({ type: "start", partial: head });
		stream.push({ type: "text_delta", contentIndex: 0, delta: summaryText, partial: head });
		stream.push({ type: "done", reason: "stop", message: head });
		stream.end(head);
		return stream;
	};
}

/** 造一条线性历史链(每条 parentId 指向前一条),返回 SessionEntry[]。 */
function buildChain(specs: Array<{ role: "user" | "assistant" | "toolResult"; text?: string }>): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let prev: string | null = null;
	specs.forEach((s, i) => {
		const id = `e${i}`;
		const timestamp = new Date(i).toISOString();
		let message: AgentMessage;
		if (s.role === "user") message = createUserMessage(s.text ?? "u");
		else if (s.role === "assistant") {
			message = createAssistantMessage([{ type: "text", text: s.text ?? "a" }], "stop");
		} else {
			message = { role: "toolResult", toolCallId: `tc${i}`, toolName: "read", content: [{ type: "text", text: s.text ?? "r" }], isError: false, timestamp: i };
		}
		entries.push({ type: "message", id, parentId: prev, timestamp, message });
		prev = id;
	});
	return entries;
}

const noopEmit: AgentEventSink = () => {};

describe("上下文工程 ③ Compaction(内容层,不涉会话)", () => {
	it("shouldCompact:超过 window−reserve 触发;未超/禁用不触发", () => {
		const settings: CompactionSettings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
		expect(shouldCompact(183617, 200000, settings)).toBe(true);
		expect(shouldCompact(1000, 200000, settings)).toBe(false);
		expect(shouldCompact(190000, 200000, { ...settings, enabled: false })).toBe(false);
	});

	it("estimateTokens:chars/4 依角色累加", () => {
		expect(estimateTokens(createUserMessage("abcd"))).toBe(1); // 4字符→1
		expect(estimateTokens(createAssistantMessage([{ type: "text", text: "abcdefgh" }], "stop"))).toBe(2);
		expect(estimateTokens({ role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "abcdefgh" }], isError: false, timestamp: 0 })).toBe(2);
	});

	it("findCutPoint:切点不在 toolResult 上(即使预算把边界逼到 toolResult 旁)", () => {
		const entries = buildChain([
			{ role: "user", text: "u" },
			{ role: "assistant", text: "a" },
			{ role: "toolResult", text: "r" },
			{ role: "user", text: "u" },
			{ role: "assistant", text: "a" },
			{ role: "toolResult", text: "r" },
			{ role: "assistant", text: "a" },
		]);
		// keepRecentTokens=2:从 e7(a,1) 往回累积,e6(r,1) 恰好到 2 → 找 ≥e6 的合法切点
		const cut = findCutPoint(entries, 0, entries.length, 2);
		const kept = entries[cut.firstKeptEntryIndex];
		if (kept.type !== "message") throw new Error("expected message entry at cut point");
		expect(kept.message.role).not.toBe("toolResult");
		expect(cut.firstKeptEntryIndex).toBe(6);
	});

	it("prepareCompaction:切在 assistant 上 → isSplitTurn=true + turnPrefixMessages 被收集", () => {
		const entries = buildChain([
			{ role: "user" }, { role: "assistant" }, { role: "toolResult" },
			{ role: "user" }, { role: "assistant" }, { role: "toolResult" },
			{ role: "assistant" },
		]);
		const prep = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 2 });
		expect(prep).toBeDefined();
		if (!prep) return;
		expect(prep.isSplitTurn).toBe(true);
		expect(prep.firstKeptEntryId).toBe("e6");
		expect(prep.messagesToSummarize.length).toBeGreaterThan(0);   // 旧消息被压缩
		expect(prep.turnPrefixMessages.length).toBeGreaterThan(0);    // 被切回合的前缀被收集
	});

	it("prepareCompaction:预算很大、无东西可压 → 返回 undefined", () => {
		const entries = buildChain([{ role: "user" }, { role: "assistant" }]);
		expect(prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
	});

	it("generateSummary:mock streamFn 产出摘要文本", async () => {
		const summary = await generateSummary(
			[createUserMessage("hello")], mockModel, 16000, undefined,
			undefined, undefined, undefined, undefined, undefined,
			mockSummaryStream("## Goal\nFix auth"), undefined,
		);
		expect(summary).toBe("## Goal\nFix auth");
	});

	it("compact():返回 CompactionResult(summary/firstKeptEntryId/tokensBefore/details)", async () => {
		const entries = buildChain([
			{ role: "user" }, { role: "assistant" }, { role: "toolResult" },
			{ role: "user" }, { role: "assistant" }, { role: "toolResult" },
			{ role: "assistant" },
		]);
		const prep = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 2 }) as CompactionPreparation;
		const result = await compact(prep, mockModel, undefined, undefined, undefined, undefined, undefined,
			mockSummaryStream("## Goal\n修复 auth"), undefined);
		expect(result.summary).toContain("## Goal");
		expect(result.firstKeptEntryId).toBe("e6");
		expect(result.tokensBefore).toBeGreaterThan(0);
		expect(result.details).toBeDefined();
	});

	it("端到端:第二轮 context 以 compactionSummary 开头,convertToLlm 只见 <summary> user", async () => {
		// 第一轮:普通跑一轮拿真实消息
		const { runAgentLoop } = await import("../../agent/src/agent-loop.ts");
		const r1 = await runAgentLoop(
			[createUserMessage("你好")],
			{ systemPrompt: "你是教学 Agent。", messages: [], tools: [] },
			{ model: mockModel, convertToLlm },
			noopEmit,
		);
		// 模拟 buildSessionContext 重建:第二轮 context = [CompactionSummaryMessage, ...近期消息]
		const summaryMsg = createCompactionSummaryMessage("## Goal\n修复 auth", 1000, new Date().toISOString());
		const ctx2: AgentMessage[] = [summaryMsg, ...r1.slice(-2)];

		// convertToLlm 边界:第一条变成 <summary> 包裹的 user
		const llm = convertToLlm(ctx2);
		const firstText = (llm[0] as UserMessage).content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
		expect(llm[0].role).toBe("user");
		expect(firstText).toContain("<summary>");
		expect(firstText).toContain("修复 auth");       // 摘要正文进了 LLM 上下文
		expect(firstText).toContain("</summary>");

		// 第二轮 loop 带压缩摘要上下文照跑
		const r2 = await runAgentLoop(
			[createUserMessage("继续")],
			{ systemPrompt: "你是教学 Agent。", messages: ctx2, tools: [] },
			{ model: mockModel, convertToLlm },
			noopEmit,
		);
		expect(r2.at(-1)?.role).toBe("assistant");
	});
});