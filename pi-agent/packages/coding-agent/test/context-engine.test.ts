import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	truncateLine,
	truncateTail,
} from "../src/core/tools/truncate.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { formatSkillsForPrompt, type Skill } from "../src/core/skills.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

/**
 * 让 config.getPackageDir() 短路 __dirname 的 ESM 探测,直接返回固定资产目录:
 * getReadmePath 等就变成纯字符串拼接(/pi-assets/README.md),无 fs 访问、确定性可测。
 * (生产同样有 PI_PACKAGE_DIR 覆盖,Nix/Guix 场景用。)
 */
process.env.PI_PACKAGE_DIR = "/pi-assets";

/** 造一个最小 Skill(懒加载清单 / disableModelInvocation 过滤测试用)。 */
function mkSkill(
	name: string,
	opts: { description?: string; disableModelInvocation?: boolean } = {},
): Skill {
	return {
		name,
		description: opts.description ?? `${name} 的描述`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: { path: `/skills/${name}/SKILL.md`, source: "project", scope: "project", origin: "package" },
		disableModelInvocation: opts.disableModelInvocation ?? false,
	};
}

describe("上下文工程 ① 工具输出截断(truncate.ts)", () => {
	it("truncateTail:8000 行截到 2000 行,以原文件末尾几行结尾", () => {
		const content = Array.from({ length: 8000 }, (_, i) => `line-${i}`).join("\n");
		const r = truncateTail(content);
		expect(r.truncated).toBe(true);
		expect(r.totalLines).toBe(8000);
		expect(r.outputLines).toBe(DEFAULT_MAX_LINES); // 2000
		const out = r.content.split("\n");
		expect(out).toHaveLength(2000);
		expect(out[0]).toBe("line-6000"); // 保留的是最后 2000 行
		expect(out[out.length - 1]).toBe("line-7999"); // 原末尾保留
	});

	it("truncateHead:3000 行以开头 import 开头,truncatedBy = lines", () => {
		const content = Array.from({ length: 3000 }, (_, i) => (i === 0 ? "import first" : `line-${i}`)).join("\n");
		const r = truncateHead(content);
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe("lines");
		expect(r.content.startsWith("import first")).toBe(true);
		expect(r.content.split("\n")).toHaveLength(DEFAULT_MAX_LINES);
	});

	it("双限制先触者胜:10 行 ×10KB 超字节不超行 → truncatedBy = bytes", () => {
		const line = "A".repeat(10 * 1024); // 每行 10KB
		const content = Array.from({ length: 10 }, () => line).join("\n");
		const r = truncateHead(content);
		expect(r.truncated).toBe(true);
		expect(r.totalLines).toBe(10); // 行数没超就撞上字节上限
		expect(r.truncatedBy).toBe("bytes");
		expect(r.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});

	it("多字节安全:截尾兜底(单行超限)按 UTF-8 边界切,不产生损坏字符", () => {
		const lastLine = "尾".repeat(5000); // 3 字节 × 5000 = 15KB 的单行
		const content = `${"x\n".repeat(100)}${lastLine}`;
		const r = truncateTail(content, { maxBytes: 80 });
		expect(r.truncated).toBe(true);
		expect(r.lastLinePartial).toBe(true);
		expect(r.content).not.toContain("�"); // 没有替换符(�) = 没切坏字符
		expect(Buffer.byteLength(r.content, "utf-8")).toBeLessThanOrEqual(80);
		expect(r.content.endsWith("尾")).toBe(true); // 取的是原行末尾一段
	});

	it("truncateLine:grep 超长行截到 500 字符并带 [truncated],短行原样", () => {
		const long = "x".repeat(5000);
		const { text: cut, wasTruncated } = truncateLine(long);
		expect(wasTruncated).toBe(true);
		expect(cut.startsWith("x".repeat(500))).toBe(true);
		expect(cut.endsWith("... [truncated]")).toBe(true);
		expect(truncateLine("short").wasTruncated).toBe(false);
	});
});

describe("上下文工程 ② 系统提示词(system-prompt.ts + skills.ts)", () => {
	it("buildSystemPrompt 分层:角色/可见工具/guidelines/项目上下文/Skills/date·cwd", () => {
		const prompt = buildSystemPrompt({
			cwd: "/work/proj",
			selectedTools: ["read", "bash"],
			toolSnippets: { read: "读取文件", bash: "执行命令" },
			promptGuidelines: ["回答前先 read"],
			contextFiles: [{ path: "/root/CLAUDE.md", content: "第一条项目规范" }],
			skills: [mkSkill("review")],
		});
		// 1. 角色定位 + 可见工具(只列有 snippet 的)
		expect(prompt).toContain("You are an expert coding assistant");
		expect(prompt).toContain("- read: 读取文件");
		expect(prompt).toContain("- bash: 执行命令");
		// 2. guidelines:自定义点 + 通用兜底点
		expect(prompt).toContain("- 回答前先 read");
		expect(prompt).toContain("- Show file paths clearly when working with files");
		// 3. Pi 文档路径(走 PI_PACKAGE_DIR,纯字符串无 fs)
		expect(prompt).toContain("/pi-assets/README.md");
		// 4. 项目上下文 XML 包装 + 来源路径
		expect(prompt).toContain('<project_instructions path="/root/CLAUDE.md">');
		expect(prompt).toContain("第一条项目规范");
		expect(prompt).toContain("</project_context>");
		// 5. Skills 懒加载清单(只放元信息)
		expect(prompt).toContain("<available_skills>");
		expect(prompt).toContain("<name>review</name>");
		// 6. 基础元数据都在末尾,date 在前 cwd 在后
		expect(prompt).toMatch(/Current date: \d{4}-\d{2}-\d{2}/);
		expect(prompt).toContain("Current working directory: /work/proj");
		expect(prompt.lastIndexOf("Current date")).toBeLessThan(prompt.lastIndexOf("Current working directory"));
	});

	it("customPrompt:跳过默认模板,只追加可选段", () => {
		const prompt = buildSystemPrompt({
			cwd: "/x",
			customPrompt: "我是铁律",
			contextFiles: [{ path: "/p.md", content: "P 规范" }],
		});
		expect(prompt).toContain("我是铁律");
		expect(prompt).not.toContain("You are an expert coding assistant");
		expect(prompt).toContain('<project_instructions path="/p.md">');
		expect(prompt).toContain("Current working directory: /x");
	});

	it("formatSkillsForPrompt:只放 name/description/location 元信息,无全文;disableModelInvocation 过滤", () => {
		const out = formatSkillsForPrompt([
			mkSkill("review"),
			mkSkill("secret", { disableModelInvocation: true }),
		]);
		expect(out).toContain("Use the read tool to load a skill's file when the task matches its description.");
		expect(out).toContain("<available_skills>");
		expect(out).toContain("<skill>");
		expect(out).toContain("<name>review</name>");
		expect(out).toContain("<description>review 的描述</description>");
		expect(out).toContain("<location>/skills/review/SKILL.md</location>");
		expect(out).not.toContain("secret"); // disableModelInvocation=true 不进清单
		expect(out).not.toContain("### 全文"); // 全文不塞提示词
	});

	it("formatSkillsForPrompt:XML 转义(&<>\"')", () => {
		const out = formatSkillsForPrompt([mkSkill("a&<b>", { description: "A <script> & \"q\"" })]);
		expect(out).toContain("<name>a&amp;&lt;b&gt;</name>");
		expect(out).toContain("<description>A &lt;script&gt; &amp; &quot;q&quot;</description>");
	});
});

describe("上下文工程 ① read 截断集成(core/tools/read.ts)", () => {
	it("长文件:details 带截断信息 + 逃生提示,不偷偷截", async () => {
		const big = Array.from({ length: 3000 }, (_, i) => `line-${i}`).join("\n");
		const tool = createReadToolDefinition("/ws", {
			readFile: async () => big,
			access: async () => undefined,
		});
		const res = await tool.execute("call-1", { path: "big.ts" }, new AbortController().signal, () => {}, {});

		expect(res.details.truncated).toBe(true);
		expect(res.details.truncatedBy).toBe("lines");
		expect(res.details.outputLines).toBe(2000);
		expect(res.details.totalFileLines).toBe(3000);
		// 逃生提示:告诉 LLM 只看了前 N 行、共多少行
		const outText = (res.content[0] as { type: "text"; text: string }).text;
		expect(outText).toContain("[Showing first 2000 of 3000 lines. Output truncated.]");
	});

	it("小文件:原样返回,truncated = false、无逃生提示", async () => {
		const small = "short\ntext\n";
		const tool = createReadToolDefinition("/ws", {
			readFile: async () => small,
			access: async () => undefined,
		});
		const res = await tool.execute("call-2", { path: "small.ts" }, new AbortController().signal, () => {}, {});

		expect(res.details.truncated).toBe(false);
		expect((res.content[0] as { type: "text"; text: string }).text).toBe(small);
		expect((res.content[0] as { type: "text"; text: string }).text).not.toContain("[Showing");
	});
});