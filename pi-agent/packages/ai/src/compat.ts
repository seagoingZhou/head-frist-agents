/**
 * pi-ai/compat 桩 —— 对应生产 `@earendil-works/pi-ai/compat` 的辅助函数。
 * 教学仓后续真正用到时再补实现;这里先导出占位,保证 import 不红。
 *
 * ⚠️ 级别联合用本地类型(与 pi-agent-core 的 ThinkingLevel 一致),避免 pi-ai → pi-agent 的跨包依赖。
 */

/** 思考级别本地占位(与 pi-agent-core ThinkingLevel 同形) */
export type CompatThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** 把请求的思考级别收敛到"支持集合"里最近的一个。TODO(后续实现)。 */
export function clampThinkingLevel(level: CompatThinkingLevel, levels: CompatThinkingLevel[]): CompatThinkingLevel {
	void levels;
	return level;
}

/** 按模型返回支持的思考级别列表。TODO(后续实现):按 model.reasoning 等区分。 */
export function getSupportedThinkingLevels(model: { reasoning?: boolean }): CompatThinkingLevel[] {
	if (model?.reasoning === false) {
		return ["off"];
	}
	return ["off", "minimal", "low", "medium", "high", "xhigh"];
}

/** 判断 assistant 消息是否触发"上下文溢出"。TODO(后续实现):stopReason==="error" 且 errorMessage 含 overflow / usage 超窗。 */
export function isContextOverflow(
	message: { stopReason?: string; errorMessage?: string; usage?: { totalTokens: number } },
	contextWindow: number,
): boolean {
	void message;
	void contextWindow;
	return false;
}

/** 两个模型是否同一(provider + id)。简单比较可先用。 */
export function modelsAreEqual(a: { id: string; provider: string }, b: { id: string; provider: string }): boolean {
	return a.id === b.id && a.provider === b.provider;
}