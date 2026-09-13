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
import type { ReadonlySessionManager, SessionEntry } from "../src/core/session-manager.ts";
import { buildSessionContext, getLatestCompactionEntry } from "../src/core/session-manager.ts";
import { convertToLlm, createCompactionSummaryMessage } from "../src/core/messages.ts";
import {
	collectEntriesForBranchSummary,
	generateBranchSummary,
	prepareBranchEntries,
} from "../src/core/compaction/branch-summarization.ts";
import { computeFileLists, SUMMARIZATION_SYSTEM_PROMPT } from "../src/core/compaction/utils.ts";

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

/**
 * 返回生成分支摘要用的 mock streamFn(支持 stop / aborted / error 三种结局)。
 * captured 非空时记录收到的一次调用(model/context/options),供断言请求形状。
 */
function mockBranchSummaryStream(opts: {
	summary?: string;
	end?: "stop" | "aborted" | "error";
	errorMessage?: string;
	captured?: { request?: unknown };
}): StreamFn {
	const { summary = "", end = "stop", errorMessage, captured } = opts;
	return async (model, context, options) => {
		if (captured) captured.request = { model, context, options };
		// head 一律带真实 stopReason,让 generateBranchSummary 的 aborted/error 分支能被触发
		const head = createAssistantMessage(
			[{ type: "text", text: summary }],
			end === "error" ? "error" : end === "aborted" ? "aborted" : "stop",
		);
		const stream = await import("pi-ai").then((m) => new m.AssistantMessageEventStream());
		if (end === "error") {
			stream.push({ type: "error", reason: "error", error: { ...head, errorMessage: errorMessage ?? "Summarization failed" } });
		} else if (end === "aborted") {
			stream.push({ type: "error", reason: "aborted", error: { ...head } });
		} else {
			stream.push({ type: "start", partial: head });
			stream.push({ type: "text_delta", contentIndex: 0, delta: summary, partial: head });
			stream.push({ type: "done", reason: "stop", message: head });
			stream.end(head);
		}
		return stream;
	};
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

describe("上下文工程 ④ 分支摘要(collect → prepare → generate + 端到端)", () => {
	function mkEntry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
		return { type: "message", id, parentId, timestamp: new Date(0).toISOString(), message };
	}
	function asst(id: string, parentId: string | null, text: string): SessionEntry {
		return mkEntry(id, parentId, createAssistantMessage([{ type: "text", text }], "stop"));
	}
	/** assistant 带 toolCall(read/write/edit),供文件操作提取测试。 */
	function toolAsst(id: string, parentId: string | null, toolCalls: Array<{ name: string; path: string }>): SessionEntry {
		const content = toolCalls.map((t, i) => ({
			type: "toolCall" as const,
			id: `${id}tc${i}`,
			name: t.name,
			arguments: { path: t.path },
		}));
		return mkEntry(id, parentId, createAssistantMessage(content, "toolUse"));
	}
	/** 造一条 branch_summary entry(details/fromHook 可选)。 */
	function branchEntry(
		id: string,
		parentId: string | null,
		opts: { summary: string; fromId?: string; details?: unknown; fromHook?: boolean },
	): SessionEntry {
		return {
			type: "branch_summary",
			id,
			parentId,
			timestamp: new Date(0).toISOString(),
			fromId: opts.fromId ?? id,
			summary: opts.summary,
			details: opts.details,
			fromHook: opts.fromHook,
		};
	}

	it("找公共祖先(LCA)+ 收集被放弃分支(时间序,不含公共祖先)", () => {
		const entries: SessionEntry[] = [
			mkEntry("r0", null, createUserMessage("root")),
			mkEntry("a1", "r0", createUserMessage("a1")),
			asst("a2", "a1", "a2"),
			mkEntry("b1", "r0", createUserMessage("b1")),
			asst("b2", "b1", "b2"),
			mkEntry("b3", "b2", createUserMessage("b3")),
		];
		// 测试夹具:分支摘要只用到 getBranch/getEntry 两个只读方法,故只实现这两个再断言补齐类型
		// (ReadonlySessionManager 是生产 session-manager.ts:186 从真实 SessionManager Pick 出的 13 个读方法)
		const byId = new Map(entries.map((e) => [e.id, e]));
		const session = {
			getBranch: (fromId?: string) => {
				const path: SessionEntry[] = [];
				let current: SessionEntry | undefined = fromId ? byId.get(fromId) : undefined;
				while (current) {
					path.push(current);
					current = current.parentId ? byId.get(current.parentId) : undefined;
				}
				return path.reverse();
			},
			getEntry: (id: string) => byId.get(id),
		} as unknown as ReadonlySessionManager;

		const result = collectEntriesForBranchSummary(session, "a2", "b3");

		expect(result.commonAncestorId).toBe("r0");
		// 被放弃的是旧分支 a1→a2(公共祖先 r0 之下),时间序
		expect(result.entries.map((e) => e.id)).toEqual(["a1", "a2"]);
	});

	it("无旧位置(oldLeafId=null)→ 空结果", () => {
		const session = { getBranch: () => [], getEntry: () => undefined } as unknown as ReadonlySessionManager;
		expect(collectEntriesForBranchSummary(session, null, "b3")).toEqual({ entries: [], commonAncestorId: null });
	});

	it("prepareBranchEntries:从最新往回收,预算内保最近上下文(时间序不变)", () => {
		const entries: SessionEntry[] = [
			mkEntry("e0", null, createUserMessage("aaaa")),                                                             // 1 token
			mkEntry("e1", "e0", createAssistantMessage([{ type: "text", text: "bbbb" }], "stop")), // 1
			mkEntry("e2", "e1", createUserMessage("cccc")),                                                             // 1
			mkEntry("e3", "e2", createAssistantMessage([{ type: "text", text: "dddd" }], "stop")), // 1
		];
		// 预算是 2:新→旧收 e3(1)+e2(1)=2,e1 再收就超且非摘要 → 停
		const prep = prepareBranchEntries(entries, 2);
		expect(prep.messages.map((m) => m.role)).toEqual(["user", "assistant"]); // 留下的恰是最近的 e2/e3
		expect(prep.totalTokens).toBe(2);

		// 预算 0 = 不限,全部收,保持时间序
		const unlimited = prepareBranchEntries(entries, 0);
		expect(unlimited.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
	});

	it("prepareBranchEntries:assistant toolCall 的文件操作被提取(read/write/edit)", () => {
		const entries: SessionEntry[] = [
			mkEntry("e0", null, createUserMessage("u")),
			toolAsst("e1", "e0", [
				{ name: "read", path: "src/a.ts" },
				{ name: "write", path: "src/b.ts" },
				{ name: "edit", path: "src/c.ts" },
			]),
		];
		const prep = prepareBranchEntries(entries, 0);
		const { readFiles, modifiedFiles } = computeFileLists(prep.fileOps);
		expect(readFiles).toEqual(["src/a.ts"]);         // 只读未改 → readFiles
		expect(modifiedFiles).toEqual(["src/b.ts", "src/c.ts"]); // write/edit → modifiedFiles
	});

	it("prepareBranchEntries:嵌套 branch_summary 的 details 跨分支累积(fromHook 不并)", () => {
		const entries: SessionEntry[] = [
			mkEntry("r0", null, createUserMessage("root")),
			branchEntry("bs1", "r0", {
				summary: "s1",
				details: { readFiles: ["lib/old.ts"], modifiedFiles: ["lib/old.ts", "lib/keep.ts"] },
			}),
			branchEntry("bs2", "bs1", {
				summary: "s2",
				fromHook: true, // 扩展生成的摘要,不参与文件累积
				details: { readFiles: ["ext/only.ts"], modifiedFiles: ["ext/only.ts"] },
			}),
		];
		const prep = prepareBranchEntries(entries, 0);
		const { readFiles, modifiedFiles } = computeFileLists(prep.fileOps);
		// lib/old.ts 读且改 → 只进 modified;lib/keep.ts 只改;ext/only.ts 被 fromHook 过滤
		expect(readFiles).toEqual([]);
		expect(modifiedFiles).toEqual(["lib/keep.ts", "lib/old.ts"]);
	});

	it("prepareBranchEntries:不产生对话内容的 entry(toolResult/thinking/model/custom/label/session_info)被跳过", () => {
		const entries: SessionEntry[] = [
			mkEntry("e0", null, createUserMessage("u")),
			{ type: "thinking_level_change", id: "e1", parentId: "e0", timestamp: new Date(1).toISOString(), thinkingLevel: "high" },
			{ type: "model_change", id: "e2", parentId: "e1", timestamp: new Date(2).toISOString(), provider: "p", modelId: "m" },
			{ type: "custom", id: "e3", parentId: "e2", timestamp: new Date(3).toISOString(), customType: "x" },
			{ type: "label", id: "e4", parentId: "e3", timestamp: new Date(4).toISOString(), targetId: "e0", label: undefined },
			{ type: "session_info", id: "e5", parentId: "e4", timestamp: new Date(5).toISOString() },
			{
				type: "message", id: "e6", parentId: "e5", timestamp: new Date(6).toISOString(),
				message: { role: "toolResult", toolCallId: "tc", toolName: "read", content: [{ type: "text", text: "r" }], isError: false, timestamp: 6 },
			},
			mkEntry("e7", "e6", createUserMessage("final")),
		];
		const prep = prepareBranchEntries(entries, 0);
		// 只剩两条真对话:e0("u") 与 e7("final");其余 6 条全被跳过
		expect(prep.messages.map((m) => m.role)).toEqual(["user", "user"]);
		expect(prep.totalTokens).toBe(3); // "u"=1 + "final"(5 字符)=2
	});

	it("prepareBranchEntries:摘要类(branch_summary)超预算也尽量塞,留 10% 余量;普通消息超预算即停", () => {
		const entries: SessionEntry[] = [
			mkEntry("e0", null, createUserMessage("u")), // 1 token
			branchEntry("bs", "e0", { summary: "abcdefghij" }), // 10 字符 → ceil(10/4)=3
			mkEntry("e2", "bs", createUserMessage("bbbb")), // 1 token
		];
		const prep = prepareBranchEntries(entries, 2);
		// 新→旧:bbbb(1)收 → bs 超预算(1+3>2)但 <90% 余量 → 强塞 → "u" 超预算且非摘要 → 停
		expect(prep.messages.map((m) => m.role)).toEqual(["branchSummary", "user"]);
		expect((prep.messages[0] as { summary: string }).summary).toBe("abcdefghij");
		expect((prep.messages[1] as UserMessage).content[0]).toMatchObject({ text: "bbbb" });
		expect(prep.totalTokens).toBe(4);
	});

	it("generateBranchSummary:mock streamFn 产出 前导+结构化摘要+文件标签,请求形状正确", async () => {
		const entries: SessionEntry[] = [
			mkEntry("e0", null, createUserMessage("一开始想修 auth")),
			toolAsst("e1", "e0", [{ name: "read", path: "src/auth.ts" }]),
			mkEntry("e2", "e1", createUserMessage("继续")),
		];
		const captured: { request?: unknown } = {};
		const result = await generateBranchSummary(entries, {
			model: mockModel,
			apiKey: "test-key",
			signal: new AbortController().signal,
			streamFn: mockBranchSummaryStream({ summary: "## Goal\nFix auth", captured }),
		});
		expect(result.aborted).toBeUndefined();
		expect(result.error).toBeUndefined();
		// 前导说明(向未来模型交代"这是分支探索的摘要")+ 结构化正文
		expect(result.summary).toContain("explored a different conversation branch");
		expect(result.summary).toContain("## Goal");
		expect(result.summary).toContain("Fix auth");
		// 末尾文件标签(从 e1 的 read toolCall 提取)
		expect(result.summary).toContain("<read-files>");
		expect(result.summary).toContain("src/auth.ts");
		expect(result.readFiles).toEqual(["src/auth.ts"]);
		expect(result.modifiedFiles).toEqual([]);

		// 请求形状:摘要系统提示词 + maxTokens 2048 + <conversation> 里带 5-section 指令
		const req = captured.request as {
			model: Model<any>;
			context: { systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }> };
			options: { maxTokens?: number; apiKey?: string };
		};
		expect(req.context.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT);
		expect(req.options.maxTokens).toBe(2048);
		expect(req.options.apiKey).toBe("test-key");
		const promptText = req.context.messages[0].content[0].text;
		expect(promptText).toContain("<conversation>");
		expect(promptText).toContain("Create a structured summary of this conversation branch");
		expect(promptText).toContain("## Goal");
	});

	it("generateBranchSummary:没有可摘要内容 → 'No content to summarize' 且不调 LLM", async () => {
		const captured: { request?: unknown } = {};
		// 只有 toolResult:getMessageFromEntry 直接跳过 → messages 空
		const entries: SessionEntry[] = [
			{
				type: "message", id: "e0", parentId: null, timestamp: new Date(0).toISOString(),
				message: { role: "toolResult", toolCallId: "tc", toolName: "read", content: [{ type: "text", text: "r" }], isError: false, timestamp: 0 },
			},
		];
		const result = await generateBranchSummary(entries, {
			model: mockModel,
			apiKey: "k",
			signal: new AbortController().signal,
			streamFn: mockBranchSummaryStream({ summary: "", captured }),
		});
		expect(result.summary).toBe("No content to summarize");
		expect(captured.request).toBeUndefined(); // 压根没调 LLM
	});

	it("generateBranchSummary:用户中断 → aborted:true;模型错误 → error 透传(无 errorMessage 时兜底)", async () => {
		const base = { model: mockModel, apiKey: "k", signal: new AbortController().signal };
		const entries = [mkEntry("e0", null, createUserMessage("u"))];

		const aborted = await generateBranchSummary(entries, { ...base, streamFn: mockBranchSummaryStream({ end: "aborted" }) });
		expect(aborted.aborted).toBe(true);
		expect(aborted.summary).toBeUndefined();

		const errored = await generateBranchSummary(entries, { ...base, streamFn: mockBranchSummaryStream({ end: "error", errorMessage: "boom" }) });
		expect(errored.error).toBe("boom");

		const generic = await generateBranchSummary(entries, { ...base, streamFn: mockBranchSummaryStream({ end: "error" }) });
		expect(generic.error).toBe("Summarization failed");
	});

	it("generateBranchSummary:customInstructions 追加(replace 关闭)/整体替换(replace 打开)", async () => {
		const entries = [mkEntry("e0", null, createUserMessage("u"))];
		const capAppend: { request?: unknown } = {};
		await generateBranchSummary(entries, {
			model: mockModel,
			apiKey: "k",
			signal: new AbortController().signal,
			customInstructions: "聚焦错误信息",
			streamFn: mockBranchSummaryStream({ captured: capAppend }),
		});
		const appendPrompt = (capAppend.request as { context: { messages: Array<{ content: Array<{ text: string }> }> } }).context.messages[0].content[0].text;
		expect(appendPrompt).toContain("Additional focus: 聚焦错误信息");
		expect(appendPrompt).toContain("Create a structured summary of this conversation branch");

		const capReplace: { request?: unknown } = {};
		await generateBranchSummary(entries, {
			model: mockModel,
			apiKey: "k",
			signal: new AbortController().signal,
			customInstructions: "只摘要错误",
			replaceInstructions: true,
			streamFn: mockBranchSummaryStream({ captured: capReplace }),
		});
		const replacePrompt = (capReplace.request as { context: { messages: Array<{ content: Array<{ text: string }> }> } }).context.messages[0].content[0].text;
		expect(replacePrompt).toContain("只摘要错误");
		expect(replacePrompt).toContain("<conversation>");
		expect(replacePrompt).not.toContain("Create a structured summary of this conversation branch");
	});

	it("端到端:collect → prepare → generate → BranchSummaryEntry → buildSessionContext → convertToLlm 只见 <summary> user", async () => {
		// 一棵两分支的会话树:r0 →(a1→a2)与 r0 →(b1→b2)
		const r0 = mkEntry("r0", null, createUserMessage("根:修 bug"));
		const a1 = mkEntry("a1", "r0", createUserMessage("A 分支:改 login"));
		const a2 = toolAsst("a2", "a1", [{ name: "edit", path: "src/login.ts" }]);
		const b1 = mkEntry("b1", "r0", createUserMessage("B 分支:看仪表盘"));
		const b2 = mkEntry("b2", "b1", createUserMessage("继续 B"));
		const all = [r0, a1, a2, b1, b2];
		const byId = new Map(all.map((e) => [e.id, e]));
		const session = {
			getBranch: (fromId?: string) => {
				const path: SessionEntry[] = [];
				let current: SessionEntry | undefined = fromId ? byId.get(fromId) : undefined;
				while (current) {
					path.push(current);
					current = current.parentId ? byId.get(current.parentId) : undefined;
				}
				return path.reverse();
			},
			getEntry: (id: string) => byId.get(id),
		} as unknown as ReadonlySessionManager;

		// 1) 从 a2 导航到 b2:被放弃的是 A 分支 a1→a2,LCA = r0
		const { entries, commonAncestorId } = collectEntriesForBranchSummary(session, "a2", "b2");
		expect(commonAncestorId).toBe("r0");
		expect(entries.map((e) => e.id)).toEqual(["a1", "a2"]);

		// 2) 生成摘要:文件标签来自 a2 的 edit toolCall
		const result = await generateBranchSummary(entries, {
			model: mockModel,
			apiKey: "k",
			signal: new AbortController().signal,
			streamFn: mockBranchSummaryStream({ summary: "## Goal\n改 login 页" }),
		});
		expect(result.summary).toContain("src/login.ts");
		expect(result.modifiedFiles).toEqual(["src/login.ts"]);

		// 3) 会话层写入 BranchSummaryEntry(挂在公共祖先 r0 下,通向 b2 的路径上)
		const bsEntry: SessionEntry = {
			type: "branch_summary",
			id: "bs",
			parentId: "r0",
			timestamp: new Date(1).toISOString(),
			fromId: "a2",
			summary: result.summary ?? "",
			details: { readFiles: result.readFiles, modifiedFiles: result.modifiedFiles },
		};
		const afterNav: SessionEntry[] = [r0, bsEntry, mkEntry("b1", "bs", createUserMessage("B 分支:看仪表盘")), mkEntry("b2", "b1", createUserMessage("继续 B"))];

		// 4) buildSessionContext 重建 B 分支上下文:branch_summary 变成 branchSummary 消息进入消息流
		const ctx = buildSessionContext(afterNav, "b2");
		expect(ctx.messages.find((m) => m.role === "branchSummary")).toBeDefined();

		// 5) convertToLlm 边界:该消息被翻成 <summary> 包裹的 user,正文含文件标签
		let wrappedText = "";
		for (const m of convertToLlm(ctx.messages)) {
			const c = (m as UserMessage).content;
			if (Array.isArray(c)) {
				const textContent = (c as Array<{ type: string; text?: string }>)
					.filter((b) => b.type === "text")
					.map((b) => b.text ?? "")
					.join("");
				if (textContent.includes("The following is a summary of a branch")) wrappedText = textContent;
			}
		}
		expect(wrappedText).toContain("<summary>");
		expect(wrappedText).toContain("改 login 页");
		expect(wrappedText).toContain("<modified-files>");
		expect(wrappedText).toContain("src/login.ts");
		expect(wrappedText).toContain("</summary>");
	});
});