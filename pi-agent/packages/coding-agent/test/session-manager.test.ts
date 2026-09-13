import { describe, expect, it } from "vitest";
import { createUserMessage } from "pi-ai";
import {
	getLatestCompactionEntry,
	SessionManager,
	type CompactionEntry,
	type SessionEntry,
} from "../src/core/session-manager.ts";

/** 造一条 user message entry(最小合法形态)。 */
function mkEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(1).toISOString(),
		message: createUserMessage(text),
	} as unknown as SessionEntry;
}

/** 造一条 compaction entry(只填判定用得到的字段)。 */
function mkCompaction(id: string, parentId: string | null, timestampIso: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: timestampIso,
		summary: "旧摘要",
		firstKeptEntryId: "x",
		tokensBefore: 100,
	};
}

describe("会话管理:getLatestCompactionEntry(压缩边界判定,生产 session-manager.ts:311)", () => {
	it("多条压缩 → 取最后一条(最新);一条都没有 → null", () => {
		const entries: SessionEntry[] = [
			mkEntry("u1", null, "一"),
			mkCompaction("c1", "u1", new Date(100).toISOString()),
			mkEntry("u2", "c1", "二"),
			mkCompaction("c2", "u2", new Date(200).toISOString()),
		];
		expect(getLatestCompactionEntry(entries)?.id).toBe("c2");

		expect(getLatestCompactionEntry([mkEntry("u1", null, "一")])).toBeNull();
		expect(getLatestCompactionEntry([])).toBeNull();
	});
});

describe("会话管理:getSessionName / appendSessionInfo(生产 session-manager.ts:1042)", () => {
	it("取最近一条 session_info;空名 = 显式清空标题 → undefined", () => {
		const sm = SessionManager.inMemory("/test");
		expect(sm.getSessionName()).toBeUndefined();

		sm.appendSessionInfo("  修 bug  ");
		expect(sm.getSessionName()).toBe("修 bug"); // 两侧空白被 trim

		sm.appendSessionInfo("改 login");
		expect(sm.getSessionName()).toBe("改 login"); // 取最近一条

		sm.appendSessionInfo("");
		expect(sm.getSessionName()).toBeUndefined(); // 空名显式清除
	});
});
