import { describe, expect, it } from "vitest";
import type { AssistantMessage, Model } from "pi-ai";
import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	isContextOverflow,
	modelsAreEqual,
} from "pi-ai";

/** 造一个最小 mock model(默认支持推理、无 thinkingLevelMap)。 */
function mkModel(over: Partial<Model<"mock">> = {}): Model<"mock"> {
	return {
		id: "mock",
		name: "Mock",
		api: "mock",
		provider: "mock",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
		...over,
	} as Model<"mock">;
}

/** 造一条 assistant 消息(只填 isContextOverflow 用得到的字段)。 */
function mkAssistant(over: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "x" }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
		...over,
	} as AssistantMessage;
}

describe("pi-ai models.ts:思考级别(对齐生产 models.ts:397-441)", () => {
	it("getSupportedThinkingLevels:不支持推理 → 只有 off", () => {
		expect(getSupportedThinkingLevels(mkModel({ reasoning: false }))).toEqual(["off"]);
	});

	it("getSupportedThinkingLevels:支持推理且无 thinkingLevelMap → 5 档(xhigh 默认不给,须显式映射)", () => {
		expect(getSupportedThinkingLevels(mkModel())).toEqual(["off", "minimal", "low", "medium", "high"]);
		// 显式映射 xhigh 后才出现
		expect(getSupportedThinkingLevels(mkModel({ thinkingLevelMap: { xhigh: "extra-high" } }))).toContain("xhigh");
	});

	it("getSupportedThinkingLevels:null 标记不支持;xhigh 必须显式映射才出现", () => {
		const model = mkModel({ thinkingLevelMap: { minimal: null, xhigh: "extra-high" } });
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "high", "xhigh"]);

		// 配了别的档但没提 xhigh → xhigh 不出现(不能给没这档的模型强开)
		const noXhigh = mkModel({ thinkingLevelMap: { minimal: "m" } });
		expect(getSupportedThinkingLevels(noXhigh)).not.toContain("xhigh");
	});

	it("clampThinkingLevel:支持则原样;不支持先往更强的档找,再往更弱的找", () => {
		const model = mkModel({ thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null } });
		// 该模型只支持:off / high
		expect(clampThinkingLevel(model, "high")).toBe("high"); // 本来就支持
		expect(clampThinkingLevel(model, "off")).toBe("off");
		expect(clampThinkingLevel(model, "minimal")).toBe("high"); // 不支持 → 往更强找
		expect(clampThinkingLevel(model, "xhigh")).toBe("high"); // 更强的都没有 → 往更弱退到 high
	});
});

describe("pi-ai models.ts:modelsAreEqual(生产 :435)", () => {
	it("比 provider + id;缺任一 → false", () => {
		expect(modelsAreEqual(mkModel(), mkModel())).toBe(true);
		expect(modelsAreEqual(mkModel(), mkModel({ id: "other" }))).toBe(false);
		expect(modelsAreEqual(mkModel(), mkModel({ provider: "other" }))).toBe(false);
		expect(modelsAreEqual(mkModel(), null)).toBe(false);
		expect(modelsAreEqual(undefined, mkModel())).toBe(false);
	});
});

describe("pi-ai utils/overflow.ts:isContextOverflow(生产 overflow.ts:126)", () => {
	it("情形 1:报错文案命中 → true;限流文案即便同时像超窗也排除", () => {
		expect(isContextOverflow(mkAssistant({ stopReason: "error", errorMessage: "prompt is too long: 213462 tokens > 200000 maximum" }))).toBe(true);
		// Bedrock 限流经 formatBedrockError 变 "Throttling error:" 前缀 → 被 NON_OVERFLOW_PATTERNS 挡掉
		expect(isContextOverflow(mkAssistant({ stopReason: "error", errorMessage: "Throttling error: Too many tokens, please wait" }))).toBe(false);
		expect(isContextOverflow(mkAssistant({ stopReason: "error", errorMessage: "boom" }))).toBe(false);
	});

	it("情形 2:成功返回但 input+cacheRead 超窗(需传 contextWindow)", () => {
		const msg = mkAssistant({ usage: { ...mkAssistant().usage, input: 9000, cacheRead: 0 } });
		expect(isContextOverflow(msg, 8192)).toBe(true);
		expect(isContextOverflow(msg)).toBe(false); // 不传窗口则识别不了
	});

	it("情形 3:截断型——stopReason length + output=0 且输入填满 ≥99% 窗口", () => {
		const msg = mkAssistant({ stopReason: "length", usage: { ...mkAssistant().usage, input: 8192, output: 0 } });
		expect(isContextOverflow(msg, 8192)).toBe(true);
		// 有输出就不算截断型
		expect(isContextOverflow(mkAssistant({ stopReason: "length", usage: { ...mkAssistant().usage, input: 8192, output: 5 } }), 8192)).toBe(false);
	});
});
