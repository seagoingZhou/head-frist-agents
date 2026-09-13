/**
 * 模型相关工具 —— 对齐生产 `ai/src/models.ts:397-441` 的三个纯函数。
 *
 * 说明:生产 models.ts 是个大文件(provider 工厂 / Models 集合 / 认证等),教学仓暂未移植;
 * 这里只落地"思考级别 + 模型比较"这几把被 coding-agent 依赖的纯函数,
 * 文件路径与函数名严格对齐生产,后续补齐 models.ts 其余内容时直接并入本文件。
 */
import type { Api, Model, ModelThinkingLevel } from "./types.ts";

/**
 * 全部思考级别,由弱到强(生产 models.ts:397)。
 * clampThinkingLevel 的"就近收敛"就是按这个顺序往两侧找。
 */
const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * 返回指定模型支持的思考级别(生产 models.ts:399)。
 *
 * 规则:
 * - 模型不支持推理(`reasoning === false`)→ 只有 `"off"`;
 * - 否则按 `thinkingLevelMap` 过滤:显式 `null` = 不支持;`"xhigh"` 特殊——
 *   必须**显式映射**才支持(没配就当不支持,避免给没这档的模型强开)。
 */
export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
}

/**
 * 把请求的思考级别收敛到"该模型支持集合"里最近的一个(生产 models.ts:410)。
 *
 * 语义:支持就直接用;不支持则先往**更强**的方向找最近支持档,找不到再往**更弱**的方向找,
 * 都没有就退回集合首项(或 "off")。这样用户切模型时不会因为档位不被支持而报错。
 */
export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	// 先往上(更强)找
	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	// 再往下(更弱)找
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * 两个模型是否同一 —— 比 provider + id(生产 models.ts:435)。
 * 任一为 null/undefined 一律 false(调用方常见"当前模型还没选"的场景)。
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
