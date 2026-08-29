/**
 * 系统提示词的组装与项目上下文加载。
 * 属于上下文工程"输入侧 ② 系统提示词组装"(见 plans/05-context-engineering.md)。
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";


export interface BuildSystemPromptOptions {

    /** 自定义系统提示词(替换默认)。 */
    customPrompt?: string;

    /** 要在提示词里列出的工具。缺省:[read, bash, edit, write]。 */
    selectedTools?: string[];

    /** 按工具名索引的可选一句话工具简介。 */
    toolSnippets?: Record<string, string>;

    /** 追加到默认系统提示词 Guidelines 段的附加说明点。 */
    promptGuidelines?: string[];

    /** 追加到系统提示词末尾的文本。 */
    appendSystemPrompt?: string;

    /** 当前工作目录。 */
    cwd: string;

    /** 预加载的项目上下文文件(path = 文件路径,content = 内容,由 CLAUDE.md 向上递归收集)。 */
    contextFiles?: Array<{ path: string; content: string }>;

    /** 预加载的 skills(懒加载清单用,只放 name/description/location,全文让 LLM 用 read 拉)。 */
    skills?: Skill[];
}

/**
 * 组装发送给 LLM 的系统提示词(上下文工程"输入侧加法",见 plans/05 §四/§五)。
 *
 * 默认模板按顺序拼装:
 *   1. 角色定位 + Available tools(仅列有 toolSnippets 的可见工具)+ Guidelines
 *   2. Pi 文档路径(让 LLM 能 read 自身文档)
 *   3. appendSystemPrompt(调用方追加内容)
 *   4. <project_context>(CLAUDE.md 递归的项目规范,XML 包装且带 path)
 *   5. <available_skills>(Skills 懒加载清单,只放 name/description/location)
 *   6. Current date / cwd(基础元数据,始终放末尾)
 * 传了 customPrompt 则跳过默认模板,只在其基础上追加 3-6 各段。
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
    const {
		customPrompt,       // 自定义提示词:有则替换默认模板,只追加可选段
		selectedTools,      // 工具白名单:决定 Available tools 列表与 guidelines
		toolSnippets,       // 工具一句话简介:有简介的工具才会被列出
		promptGuidelines,   // 调用方附加的 guideline 点
		appendSystemPrompt, // 追加到系统提示词末尾的文本
		cwd,                // 工作目录:作为提示词里的 cwd,供相对路径解析
		contextFiles: providedContextFiles, // 项目规范文件(由 CLAUDE.md 向上递归收集)
		skills: providedSkills,             // Skills 懒加载清单(超集,过滤后只留元信息)
	} = options;

    // 统一路径分隔符:把 \ 换成 /,LLM 按 / 解析相对路径(平台无关)。
    const resolvedCwd = cwd;
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	// 组装 yyyy-MM-dd 日期 —— LLM 解释"昨天/上周"这类相对时间依赖它。
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	// 追加段带两个换行分隔,避免与上一段粘连。
	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	// 项目上下文与 skills 均可缺省——先空值占位,后面按需拼。
	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// 追加项目上下文:用 <project_context> + <project_instructions path="..."> XML 包装。
		// path 属性让 LLM 区分"组织级/项目级"规范优先级;XML 结束标记避免把规范与外部指令混淆。
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// 追加 Skills 懒加载清单(拉模式):只放 name/description/location + "Use read to load" 指令。
		// 仅在 read 工具可用时才加——清单靠 LLM 自己用 read 拉全文。
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// 末尾补基础元数据:日期(相对时间推理)+ cwd(相对路径解析)——总是放最后。
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// 取 pi 自身文档的绝对路径——LLM 被引导 read 文档时知道去哪找。
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// 由 selectedTools 决定工具集;某工具只在提供了 toolSnippets 一句话简介时才进 Available tools。
	// visibleTools = 被选中且有简介的工具;没简介的不展示(省 token,避免占位噪音)。
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// 按实际可用的工具构造 guidelines:Set 去重保序,同一个 guideline 只加一次。
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// 文件探索指导:若只有 bash 而无 grep/find/ls,就提示用 bash 做文件探索(补偿缺失的专属工具)。
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}

	// 调用方附加的 guideline 点:trim 后非空才加入。
	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// 通用说明:任何工具组合都要有(简洁回答 + 文件路径展示清楚)。
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	// 统一拼成 "- ..." 列表,插进模板的 Guidelines 段。
	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// 追加项目上下文:用 <project_context> + <project_instructions path="..."> XML 包装。
		// path 属性让 LLM 区分"组织级/项目级"规范优先级;XML 结束标记避免把规范与外部指令混淆。
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// 追加 Skills 懒加载清单(拉模式):只放 name/description/location + "Use read to load" 指令。
		// 仅在 read 工具可用时才加——清单靠 LLM 自己用 read 拉全文。
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// 末尾补基础元数据:日期(相对时间推理)+ cwd(相对路径解析)——总是放最后。
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
