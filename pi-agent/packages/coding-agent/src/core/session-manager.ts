import { type AgentMessage, uuidv7 } from "pi-agent-core";
import type {Message, TextContent } from "pi-ai";
import { randomUUID } from "crypto";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
	writeFileSync,
} from "fs";
import { readdir, stat } from "fs/promises";
import path, { join, resolve } from "path";
import { createInterface } from "readline";
import { StringDecoder } from "string_decoder";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./messages.ts";

export const CURRENT_SESSION_VERSION = 3;

// ============================================================================
// 会话头部与 entry 类型家族 —— Session Tree 的"数据类型层"(见 plans/06 §三)
// ============================================================================

/**
 * 会话文件的头(第一行)。
 * 它不是树节点——是文件元信息(记这个会话属于哪个项目、从哪个会话克隆而来),
 * 后续每一行才是 (type+id+parentId+timestamp) 的树 entry。
 */
export interface SessionHeader {
	type: "session";
	/** 版本号;v1 的会话文件没有这个字段(迁移时补上,见 CURRENT_SESSION_VERSION=3) */
	version?: number;
	/** 会话 id(uuidv7),也是文件名的一部分 */
	id: string;
	timestamp: string;
	/** 创建会话时的工作目录——会话"跟项目走"的依据 */
	cwd: string;
	/** 由哪个会话克隆而来(createBranchedSession 分支副本会带上) */
	parentSession?: string;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
}

/**
 * 所有 entry 的公共基字段。
 * type 区分种类、id 唯一标识、parentId 认父不认子(append-only 的前提,见 06 §3.2)、
 * timestamp 记录创建时间(排序/调试用)。派生类型只在此基础上加各自 payload。
 */
export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

/** 对话消息节点:真正的 user / assistant / toolResult 消息(组① 进 LLM 上下文)。 */
export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

/** 思考级别切换(组② 影响状态):后面 buildSessionContext 覆盖式更新 thinkingLevel。 */
export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

/** 模型切换(组② 影响状态):后续 LLM 用 modelId;生产字段是 provider+modelId。 */
export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

/**
 * 压缩节点(组①,由 05 的 compact() 写入):把"压缩区旧消息"替换成一段结构化摘要。
 * buildSessionContext 遇到它:把 summary 生成 CompactionSummaryMessage 放最前,
 * 再按 firstKeptEntryId 选择性保留压缩点之前的近期消息(见下方 buildSessionContext 的注释)。
 */
export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	/** 压缩生成的结构化摘要文本(6-section) */
	summary: string;
	/** 保留区内第一条 entry 的 id —— 压缩点之前、>= 它的消息才继续保留 */
	firstKeptEntryId: string;
	/** 被压缩掉的段的估算 token 数(给 LLM 判断"这段历史有多大多重要") */
	tokensBefore: number;
	/** 扩展自定义数据(如 ArtifactIndex、结构化压缩的版本标记);**不发给 LLM** */
	details?: T;
	/** true = 由扩展生成;undefined/false = pi 自身生成(向后兼容;分支摘要的文件累积只认后者) */
	fromHook?: boolean;
}

/**
 * 分支摘要节点(组①,回退时由 branchWithSummary 写入,见 06 §四):被抛弃分支的"遗言"。
 * buildSessionContext 遇到它 → createBranchSummaryMessage → convertToLlm 包成 <summary> user。
 * 注意与 CompactionEntry 是两种不同消息。
 */
export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	/** 被摘要分支的起点 entry id——"这段摘要讲的是哪条分支" */
	fromId: string;
	/** 5-section 分支摘要正文(Goal/Progress/Decisions 等,生成在分支摘要算法里) */
	summary: string;
	/** 扩展自定义数据(如 readFiles/modifiedFiles 文件追踪);**不发给 LLM** */
	details?: T;
	/** true = 扩展生成;false = pi 生成(文件追踪累积只认 pi 生成的) */
	fromHook?: boolean;
}

/**
 * 扩展自定义数据节点(组③ 纯元数据)。
 * 用途:跨会话重载保存扩展内部状态——重载时扩展扫一遍 customType 即可重建状态。
 * 不参与 LLM 上下文(buildSessionContext 直接跳过);
 * 想往上下文注入内容,用 CustomMessageEntry。
 */
export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

/** 标签/书签节点(组③ 纯元数据):给某个 entry 打标;label 为 undefined/空 = 清除标记。 */
export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

/** 会话元信息节点(组③ 纯元数据):用户自定义的会话显示名等。 */
export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

/**
 * 自定义消息节点(组① 进 LLM 上下文)——区别于 CustomEntry。
 * 内容会由 buildSessionContext 转成一条 user 消息,经 convertToLlm 进 LLM;
 * details 仅供扩展元数据,**不发 LLM**。
 */
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent)[];
	details?: T;
	/** 控制 TUI 渲染:false = 完全隐藏;true = 用区别于 user 消息的样式展示 */
	display: boolean;
}

/**
 * 会话树上的 9 种 entry 联合(SessionManager 的"读"方法返回的类型)。
 * 全部共享 SessionEntryBase 的 id/parentId/timestamp——这就是树形结构的数据根基。
 */
export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry;

/** 原始文件行 = 会话头 或 普通 entry(loadEntriesFromFile 按行解析后的完整形态)。 */
export type FileEntry = SessionHeader | SessionEntry;

/** 树的节点(getTree() 的返回类型):entry 的防篡改浅拷贝 + 已解析的标签。 */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	/** 解析后的标签(给该 entry 打过标才有) */
	label?: string;
	/** 最近一次对该 entry 打标的时间戳(打过标才有) */
	labelTimestamp?: string;
}


/** buildSessionContext 的产物 = 发给 LLM 的线性上下文 + 调用参数用到的状态。 */
export interface SessionContext {
	/** 要发给 LLM 的线性消息数组(树的"出口形态") */
	messages: AgentMessage[];
	/** 当前思考级别(受路径上 thinking_level_change 覆盖式影响) */
	thinkingLevel: string;
	/** 当前模型(受路径上 model_change 覆盖式影响;无则 null 由调用方兜底) */
	model: { provider: string; modelId: string } | null;
}


function createSessionId(): string {
	return uuidv7();
}

export function assertValidSessionId(id: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

/** 生成 8 位十六进制短 id(entry 的唯一标识,随机 + 查重)。 */
function generateId(byId: { has(id: string): boolean }): string {
	// 最多试 100 次:取 randomUUID 前 8 位,已被占用就重抽(避免撞已有 entry)
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// 100 次还撞 → 极端情况,回退完整 UUID(再撞概率可忽略)
	return randomUUID();
}

/**
 * 迁移 v1 → v2:v1 的会话是纯线性消息、没有树结构。
 * 这里给每条非 header 条目补 id/parentId(前一个条目当父,形成链)。
 * **原地修改**(直接改传入数组)。
 */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		entry.parentId = prevId;
		prevId = entry.id;

		// v1 压缩字段是"下标";迁移成"id"(v2 后一切引用都按 id,先删后建更稳)。
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/**
 * 迁移 v2 → v3:把旧的 hookMessage 角色名改名为 custom。
 * v2 里扩展注入的消息角色叫 "hookMessage",v3 统一叫 "custom"(03 的消息体系以 custom 为准)。
 * **原地修改**。
 */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		// 只处理 message 条目,且 role 恰为旧名 "hookMessage" 时改名
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

/**
 * 统一入口:把旧版本会话一路升级到 CURRENT_SESSION_VERSION。
 * **原地修改**;返回"是否真的发生过迁移"(调用方据此决定要不要重写落盘)。
 */
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	// 无 header 按 v1 算;header 里 version 缺省也按 v1
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	// 已是当前版本 → 无事可做
	if (version >= CURRENT_SESSION_VERSION) return false;

	// 从旧到新逐级迁移(每一级都基于上一级产物)
	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);

	return true;
}

/** 对外暴露给测试用:统一入口——把所有旧版本条目一路迁到当前版本(原地修改)。 */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}

/** 对外暴露给 compaction.test.ts 用:把会话文件文本按行 JSON.parse 成 FileEntry[]。 */
export function parseSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			// 这一行是坏 JSON → 跳过(容忍脏行,不整个文件报废)
		}
	}

	return entries;
}

/**
 * 从会话树的 entry 构建 LLM 上下文(树的"压扁出口",见 06 §五)。
 * 路径遍历:从 leafId 沿 parentId 上溯到 root,收集的路径 reverse 成 root-first;
 * 路径上的 entry 用"根 → 叶"顺序按类型分派处理。沿路径处理 compaction 与分支摘要。
 *
 * @param entries 全部会话条目(不含 header)
 * @param leafId  要走的叶子:null 表示"在第一条之前"(空上下文);undefined 表示"默认走最后一条"
 * @param byId    可选预建的 id→entry 索引(多次调用可复用,省重建)
 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	// 建 uuid(entry id)→entry 的反向索引:树"认父不认子",靠这张全量 map 才能顺着 parentId 一路反查
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	// 定位叶子:null 是用户显式"导航到第一条之前" → 空上下文
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return { messages: [], thinkingLevel: "off", model: null };
	}
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		leaf = entries[entries.length - 1];
	}

	// 一条有效 entry 都没有 → 空上下文
	if (!leaf) {
		return { messages: [], thinkingLevel: "off", model: null };
	}

	// 路径遍历:从 leaf 沿 parentId 上溯到 root,再 reverse 成 root-first(时间序)
	// 注意只走当前分支——被回退/被抛弃的分支不会出现在消费路径里
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();

	// 状态提取(覆盖式,root→leaf 顺序,后写覆盖先写——"最后生效"):
	//   thinking_level_change 改 thinkingLevel;model_change 改 model
	//   另:assistant 消息本身也携带"生成它的 provider/model",一并提取
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	// 组装 messages。有压缩节点时,顺序是:
	//   1. 最前放 CompactionSummaryMessage(压缩摘要,替换掉压缩区的旧消息)
	//   2. 压缩点之前只保留 firstKeptEntryId 及之后的近期消息
	//   3. 压缩点之后全部照常收集
	// 无压缩节点:路径上全部按类型收集(分支摘要/自定义消息也在这一步处理)。
	const messages: AgentMessage[] = [];

	/** entry → messages 的共同出口:message 直接取;custom_message / branch_summary 经工厂转成对应消息。 */
	const appendMessage = (entry: SessionEntry) => {
		if (entry.type === "message") {
			messages.push(entry.message);
		} else if (entry.type === "custom_message") {
			messages.push(
				createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp),
			);
		} else if (entry.type === "branch_summary" && entry.summary) {
			messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	};

	if (compaction) {
		// 1) 压缩摘要放最前:LLM 先看到"这段历史被压缩成了什么"
		messages.push(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp));

		// 定位压缩节点在 path 里的下标
		const compactionIdx = path.findIndex((e) => e.type === "compaction" && e.id === compaction.id);

		// 2) 压缩点之前的消息:只保留从 firstKeptEntryId 开始的(压缩区里的 e1/e2 被跳过,不是真删——append-only)
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = path[i];
			if (entry.id === compaction.firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (foundFirstKept) {
				appendMessage(entry);
			}
		}

		// 3) 压缩点之后:全部照常收集
		for (let i = compactionIdx + 1; i < path.length; i++) {
			const entry = path[i];
			appendMessage(entry);
		}
	} else {
		// 无压缩:路径全部按类型收集(分支摘要/自定义消息也在 appendMessage 里处理)
		for (const entry of path) {
			appendMessage(entry);
		}
	}

	return { messages, thinkingLevel, model };
}

/**
 * 计算 cwd 对应的默认会话目录:把 cwd 编码成安全目录名,挂在 ~/.pi/agent/sessions/ 下。
 * (会话"跟项目走":cd 到哪个目录,就打开编码后同名目录里的会话历史,见 06 §一)
 */
function getDefaultSessionDirPath(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	// 去掉开头的 /、把剩下路径中的 / 和 : 换成 - → "--src-eslint-rc--" 这种安全目录名
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvedAgentDir, "sessions", safePath);
}

/** 取(并按需创建)默认会话目录。 */
export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}
	return sessionDir;
}

/** 流式读会话文件时每次 readSync 的缓冲大小(1MB,兼顾大文件性能与内存)。 */
const SESSION_READ_BUFFER_SIZE = 1024 * 1024;

/**
 * 会话管理器:把对话历史当作"只追加的树"存在 JSONL 文件里。
 *
 * 树结构靠每个 entry 的 id + parentId("认父不认子");`leafId` 指针标记当前停留位置——
 * 追加 = 在 leaf 下挂新子节点并前移指针,回退/分支 = 只移动指针、不删任何历史。
 *
 * 对外用 `buildSessionContext()` 把当前路径压扁成给 LLM 的线性 messages
 * (沿途处理压缩摘要 / 分支摘要,见 06 §五)。
 *
 * 完整实现参考 06 §九 Tier 2/3(生产 session-manager.ts:758 起)。
 */
export class SessionManager {

	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	/** 是否落盘(测试可传 false 只跑内存树,不写文件) */
	private persist: boolean;
	/** "是否已进入稳定 append 通道":配合 _persist 的延迟写入策略(见 06 §6.3) */
	private flushed: boolean = false;
	/** 内存全量条目:header + 所有 entry(append-only,永不删改) */
	private fileEntries: FileEntry[] = [];
	/** id → entry 反向索引("认父不认子"的反查表,读路径全走它) */
	private byId: Map<string, SessionEntry> = new Map();
	/** targetId → label:标签缓存(打标/清标即时维护) */
	private labelsById: Map<string, string> = new Map();
	/** targetId → 打标时间:给 TUI 排序/展示用 */
	private labelTimestampsById: Map<string, string> = new Map();
	/** 当前叶子指针:追加的新 entry 的 parentId 就是它 */
	private leafId: string | null = null;

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
	) {
		this.cwd = cwd;
		this.sessionDir = sessionDir;
		this.persist = persist;

		if (persist && this.sessionDir && !existsSync(this.sessionDir)) {
			mkdirSync(
				this.sessionDir,
				{recursive: true},
			);
		}

		if (sessionFile) {
			this.setSessionFile(sessionFile)
		} else {
			this.newSession(newSessionOptions)
		}

	}

	/** 切到另一个会话文件(用于 resume 恢复 / 分支跳转):把磁盘上的树加载进内存。 */
	setSessionFile(sessionFile: string): void {
		this.sessionFile = resolve(sessionFile);
		if (existsSync(this.sessionFile)) {
			this.fileEntries = loadEntriesFromFile(this.sessionFile);

			// 文件为空或损坏(没有合法 header):重建一个全新会话再重写——
			// 不能后续往没 header 的文件里 append(没有 header 的会话是坏的)
			if (this.fileEntries.length === 0) {
				const explicitPath = this.sessionFile;
				this.newSession();
				this.sessionFile = explicitPath;
				this._rewriteFile();
				this.flushed = true;
				return;
			}

			const header = this.fileEntries.find(
											(e) =>
												e.type === "session"
											) as SessionHeader | undefined;
			this.sessionId = header?.id ?? createSessionId();

			// 旧版本文件:先原地迁移到当前版本,再整体重写落盘
			if (migrateToCurrentVersion(this.fileEntries)) {
				this._rewriteFile();
			}

			this._buildIndex();
			this.flushed =true;
		} else {
			// 目标文件不存在:按 newSession 生成一个新会话,
			// 但要把 --session 显式指定的路径保留下来(不换成默认文件名)
			const explicitPath = this.sessionFile;
			this.newSession();
			this.sessionFile = explicitPath;
		}

	}

	/** 开一个全新会话:写 header、清空所有索引与 leafId(内存态回到"空树")。 */
	newSession(options?: NewSessionOptions): string | undefined {
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		this.sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
		};
		this.fileEntries = [header];
		this.byId.clear();
		this.labelsById.clear();
		this.leafId = null;
		this.flushed = false;

		if (this.persist) {
			// 文件名带时间(可排序)+ 会话 id;冒号/点换成 - (文件名安全字符)
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
		}
		return this.sessionFile;
	}

	/** 从 fileEntries 全量重建索引(byId/labels/leafId)——加载文件后调用一次。 */
	private _buildIndex(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			this.byId.set(entry.id, entry);
			this.leafId = entry.id; // 最后一条就是当前叶子(线性加载时正确;分支见 _buildIndex 后的重定位)
			if (entry.type === "label") {
				// label 打标:记进缓存;label 为 falsy(undefined/空)→ 清除该 target 的标记
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
	}

	/** 把内存全量 fileEntries 整体重写进文件(openSync "w" 覆盖写)。 */
	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		const fd = openSync(this.sessionFile, "w");
		try {
			for (const entry of this.fileEntries) {
				writeFileSync(fd, `${JSON.stringify(entry)}\n`);
			}
		} finally {
			closeSync(fd); // 无论写成功与否都要关 fd
		}
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	usesDefaultSessionDir(): boolean {
		return this.sessionDir === getDefaultSessionDirPath(this.cwd);
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	/**
	 * 落盘入口(每个 entry 追加后调用):配合 `flushed` 实现"等到有 assistant 再写"的延迟策略,
	 * 避免"有问无答"的半截对话残留。四情况:
	 *   无 assistant+已 flushed → append;无+未 flushed → 不写(等);
	 *   有+未 flushed → openSync("wx") 整写全部 + 置 flushed;有+已 flushed → append。
	 * (对照生产 session-manager.ts:909,行号即生产锚点)
	 */
	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) return;

		const hasAssistant = this.fileEntries.some(
			(e) => e.type === "message" && e.message.role === "assistant"
		);
		if (!hasAssistant) {
			if (this.flushed) {
				// 无 assistant + 已 flushed → 追加写
				appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
			} else {
				// 无 assistant + 未 flushed → 不写(等有 assistant 再整写)
				this.flushed = false;
			}
			return;
		}

		if (!this.flushed) {
			const fd = openSync(this.sessionFile, "wx"); // "wx" → 文件不存在才写,避免覆盖已有文件
			try {
				for (const e of this.fileEntries) {
					writeFileSync(fd, `${JSON.stringify(e)}\n`);
				}
			} finally {
				closeSync(fd);
			}
			this.flushed = true;
		} else {
			appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
		}
	}

	/** 追加的公共收敛点:进内存(fileEntries+byId)、前移叶子指针、落盘。所有 appendXXX 都走这里。 */
	private _appendEntry(entry: SessionEntry): void {
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		this._persist(entry);
	}

	/**
	 * 在当前叶下追加一条对话消息,然后把叶子指针前移到新节点。返回 entry id。
	 * 注意:**不允许**直接写 CompactionSummaryMessage / BranchSummaryMessage——
	 * 它们必须是会话的"顶层 entry"(方便检索),要走 appendCompaction() 和 branchWithSummary()。
	 */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {

		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};

		this._appendEntry(entry);

		return entry.id;
	}

	/** 追加一条思考级别切换,并把叶子移到新节点。返回 entry id。 */
	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		}
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加一条模型切换(provider+modelId),并把叶子移到新节点。返回 entry id。 */
	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		}
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加一条压缩节点(05 压缩结果的落库入口),并把叶子移到新节点。返回 entry id。 */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
		}
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加一条扩展自定义 entry(组③ 纯元数据,不进 LLM 上下文),返回 entry id。 */
	appendCustomEntry(customType: string, data?: unknown): string {

		const entry: CustomEntry = {
			type: "custom",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			customType,
			data,
		}
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加一条会话元信息(如显示名;换行会被清洗),返回 entry id。 */
	appendSessionInfo(name: string): string {
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: sanitizedName,
		}
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * 追加一条自定义消息 entry(组①,扩展往 LLM 上下文注入内容用)。
	 * 与 CustomEntry 不同,这条会经 buildSessionContext 进 messages,再被 convertToLlm 翻成 user 消息。
	 * @param customType 扩展标识(重载时按它过滤重建)
	 * @param content 消息内容(字符串或 TextContent/ImageContent 数组)
	 * @param display TUI 渲染:false 隐藏;true 用样式展示
	 * @param details 扩展元数据(**不发给 LLM**)
	 * @returns 新 entry 的 id
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent)[],
		display: boolean,
		details?: T,
	): string {

		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			customType,
			content,
			display,
			details,
		}
		this._appendEntry(entry);
		return entry.id;
	}



	/**
	 * 给某个 entry 打标或清标(书签/导航标记)。
	 * label 传 undefined 或空串 = 清除该 target 的标记;打标同时维护 labelsById 缓存。
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {

		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}

		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		}
		this._appendEntry(entry);

		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		
		return entry.id;
	}

	// =========================================================================
	// 树的遍历与查询 —— SessionManager 的只读方法(全部取自内存索引 byId)
	// =========================================================================

	/** 当前叶子 id(指针;null = 还没走到任何节点/"第一条之前")。 */
	getLeafId(): string | null {
		return this.leafId;
	}

	/** 当前叶子 entry(拿"当前所在节点"做判断用)。 */
	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	/** 按 id 取任意 entry(O(1),走 byId 索引)。 */
	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	/**
	 * 取某个 entry 的全部直接子节点。
	 * "认父不认子"的反向查询——节点不存 children 列表,只能遍历全量 byId 找 parentId 匹配的(不会落盘)。
	 */
	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}

		return children;
	}

	/** 取某条 entry 的标签(书签);没有则为 undefined。直接读 labelsById 缓存,不落盘。 */
	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}


	/**
	 * 从指定 entry(缺省 = 当前叶子)沿 parentId 一路走到 root,返回 root-first 的完整路径。
	 * 路径含全部类型(消息/压缩/模型切换等);要"压扁成给 LLM 的线性上下文",把它交 buildSessionContext()。
	 */
	getBranch(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.leafId;
		let current = startId ? this.byId.get(startId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}

		path.reverse(); // reverse 成 root-first(根在前、叶在后)
		return path;
	}

	/**
	 * 直接拿"当前叶子对应的 LLM 上下文":委托纯函数 buildSessionContext(),
	 * 只为顺手带上内存里的 entries / leafId / byId(便捷壳,逻辑全在纯函数里)。
	 */
	buildSessionContext(): SessionContext {
		return buildSessionContext(this.getEntries(), this.leafId, this.byId);
	}

	/** 取会话文件的 header(元信息);null = 文件里没有 header。 */
	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	/**
	 * 取全部会话 entry(不含 header)。返回浅拷贝。
	 * 会话是 append-only:写入只能走 appendXXX(),改位置只能走 branch()——entry 不可改、不可删。
	 */
	getEntries(): SessionEntry[] {
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	}


	/**
	 * 把会话组织成树形结构返回(节点带解析好的 label)。全部 entry 的防篡改浅拷贝。
	 * 规范会话只有 1 个根(parentId === null 的首条);parentId 悬空(指向不存在 / 指向自己)的孤立节点也当根返回。
	 */
	getTree(): SessionTreeNode[] {
		const roots: SessionTreeNode[] = [];
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();

		// 创建所有节点并放入 map
		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(
				entry.id, 
				{ 
					entry, 
					children: [], 
					label, 
					labelTimestamp,
				 }
			);
		}

		// 将节点组织成树结构
		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId == null || entry.parentId === entry.id) {
				// 根节点或 parentId 指向自己(孤立节点)
				roots.push(node);
			} else {
				const parentNode = nodeMap.get(entry.parentId);
				if (parentNode) {
					parentNode.children.push(node);
				} else {
					// parentId 指向不存在的节点(孤立节点)
					roots.push(node);
				}
			}
		}

		// 对每个节点的 children 按时间戳排序，保证顺序一致
		// 遍历（而不是递归），防止栈溢出
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const currentNode = stack.pop()!;
			currentNode.children.sort(
				(a, b) => 
					a.entry.timestamp.localeCompare(b.entry.timestamp)
			);
			stack.push(...currentNode.children);
		}

		return roots;
	}

	// =========================================================================
	// 分支与克隆 —— 只移动 leafId 指针,不删任何历史数据(append-only)
	// =========================================================================

	/**
	 * 从更早的某条 entry 处开新分支。
	 * 核心 = 把 leafId 移到指定 entry;此后下一次 appendXXX() 就会在它下面挂新子节点,形成新分支。
	 * 已存在的条目**不修改、不删除**——它们只是离开当前路径。
	 * (✅ 已实现,对照生产 session-manager.ts:1244:先校验 branchFromId 存在,再 `leafId = branchFromId`)
	 */
	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
	}

	/**
	 * 把 leaf 指针复位到 null("第一条之前")。
	 * 下一次 appendXXX() 会创建 parentId = null 的新根——用于回退到开头重编第一条 user 消息。
	 */
	resetLeaf(): void {
		this.leafId = null;
	}

	/**
	 * 开新分支,同时给"被抛弃的旧路径"留一份摘要(BranchSummaryEntry)。
	 * 与 branch() 相同(先移 leafId),区别是额外 append 一条 branch_summary:
	 *   buildSessionContext 遇到它 → 生成 BranchSummaryMessage,新分支的 Agent 能看到"之前试过什么"。
	 * 注意:summary 是**入参**(LLM 生成在调用方 generateBranchSummary,06 §四),这里只负责存储,不调 LLM。
	 * (✅ 已实现,对照生产 session-manager.ts:1265:校验 → 移 leafId → append BranchSummaryEntry{parentId:分支点, fromId, summary, details, fromHook})
	 */
	branchWithSummary(
		branchFromId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean
	): string {

		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.byId),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId: branchFromId ?? "root", // null → root-first 分支摘要
			summary,
			details,
			fromHook,
		};
		this._appendEntry(entry);

		return entry.id;
	}


	/**
	 * 把"root → 指定叶子"这条路径克隆成一个**新会话文件**(只含当前路径,过滤掉被弃分支),
	 * 并把当前 SessionManager 切换到新会话上。persist=false(内存模式)时只换内存态、返回 undefined。
	 *
	 * 为什么能"克隆出单条对话":分支树里任意一条 root→leaf 路径就是一段独立对话;
	 * 把它连同 header 写进新文件,就得到"只讲这一条线"的会话,可与原分叉会话井水不犯河水。
	 *
	 * 算法(照生产 session-manager.ts:1289,五步):
	 *   1. getBranch(leaf) 取 root-first 完整路径;
	 *   2. **过滤 label + 重链 parentId** —— label 是真实树节点,后续 entry 可能挂在 label 之下,
	 *      直接剔除 label 会让挂在它下面的 entry 变成悬空(orphan),所以要把保留路径重新串成一条直线;
	 *   3. 造新会话 id / 文件名 / header(parentSession 记下旧文件路径,可溯源回原分叉会话);
	 *   4. 从 labelsById 里挑"目标在保留路径上"的标签,重生成 label entry,首位相接挂在路径末尾;
	 *   5. persist 模式 → 整体写盘(仅当有 assistant 时立即写,否则交给 _persist 延迟,见下方注释)、
	 *      返回新文件路径;内存模式 → 只替换 fileEntries + 重建索引,返回 undefined。
	 */
	createBranchedSession(leafId: string): string | undefined {

		const previousSessionFile = this.sessionFile;
		const branchPath = this.getBranch(leafId);
		if (branchPath.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		// 过滤 label + 重链:label 是真实树节点,后续 entry 可能以它为父;
		// 直接删 label 会让子树悬空。所以把保留路径里的 label 剔除,
		// 让每个 entry 的 parentId 改指回"前一个非 label 节点",串成一条无间断的链。
		const pathWithoutLabels: SessionEntry[] = [];
		let pathParentId: string | null = null;
		for (const entry of branchPath) {
			if (entry.type !== "label") {
				pathWithoutLabels.push(
					{
						...entry,
						parentId: pathParentId
					}
				);
				pathParentId = entry.id;
			}
		}

		// 新会话三件套:id(uuidv7)、文件名(时间戳冒号/点换 - + id)、header
		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(
			this.getSessionDir(),
			`${fileTimestamp}_${newSessionId}.jsonl`
		);

		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: this.persist ? previousSessionFile : undefined, // 记旧文件,溯源用
		};

		// 收集要带走的标签:labelsById 里 target 落在"保留路径"上的,才写进新会话
		const pathEntryIds = new Set<string>(
			pathWithoutLabels.map((entry) => entry.id)
		);
		const labelToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelToWrite.push({
					targetId,
					label,
					timestamp: this.labelTimestampsById.get(targetId)!,
				});
			}
		}

		if (this.persist) {
			// 重新生成 label entry:一条条排好(前一条的 id 当后一条的 parentId,连成链),
			// id 生成时用 pathEntryIds 查重,新 id 也同步加进冲突集,防下一轮撞
			const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
			let parentId = lastEntryId;
			const labelEntries: LabelEntry[] = [];
			for (const tmpLalel of labelToWrite) {
				const labelEntry: LabelEntry = {
					type: "label",
					id: generateId(new Set(pathEntryIds)),
					parentId: parentId,
					timestamp: tmpLalel.timestamp,
					targetId: tmpLalel.targetId,
					label: tmpLalel.label,
				};
				pathEntryIds.add(labelEntry.id);
				labelEntries.push(labelEntry);
				parentId = labelEntry.id;
			}

			// 当前会话整体替换成"新 header + 保留路径 + 尾部 label 链",重建内存索引
			this.fileEntries = [newHeader, ...pathWithoutLabels, ...labelEntries];
			this.sessionId = newSessionId;
			this.sessionFile = newSessionFile;
			this._buildIndex();

			// 只在路径里有 assistant 时才立即整写文件;否则延迟——
			// 交给 _persist 的"无 assistant 延迟写"策略:首个 assistant 到达再建文件,
			// 既符合 newSession() 的契约,也避免 _persist 的 no-assistant 保护把 flushed 重置回 false,
			// 从而产生"重复写 header"的 bug。
			const hasAssistant = this.fileEntries.some(
				(e) =>
					e.type === "message" && e.message.role === "assistant"
			);
			if (hasAssistant) {
				this._rewriteFile();
				this.flushed = true;
			} else {
				this.flushed = false;
			}

			return newSessionFile;
		}

		// 内存模式(persist=false):不落盘,只换当前会话为"新路径 + 尾部 label 链",返回 undefined
		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		for (const tmpLalel of labelToWrite) {
			const lableId = generateId(
				new Set(
					[
						...pathEntryIds,
						...labelEntries.map((e) => e.id)
					]
				)
			);
			const labelEntry: LabelEntry = {
				type: "label",
				id: lableId,
				parentId: parentId,
				timestamp: tmpLalel.timestamp,
				targetId: tmpLalel.targetId,
				label: tmpLalel.label,
			};
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;

		}

		this.fileEntries = [newHeader, ...pathWithoutLabels, ...labelEntries];
		this.sessionId = newSessionId;
		this._buildIndex();
		return undefined;
	}

}




/** 沿 parentId 从 leaf 上溯到 root,返回 root-first 路径(纯函数版;生产 SessionManager.getBranch 是方法,会话树齐了可直接对齐)。 */
export function getBranchPath(entries: SessionEntry[], leafId: string | null): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leafId ? byId.get(leafId) : undefined;
	while (current) {
		path.unshift(current); // unshift 插到头部 → 最后得到 root-first
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path;
}

/** 按 id 查一条 entry(纯函数;分支摘要的最小会话视图用,配合 getBranchPath 组装 ReadonlySessionManager)。 */
export function getEntryById(entries: SessionEntry[], id: string): SessionEntry | undefined {
	return entries.find((entry) => entry.id === id);
}

function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		// 坏 JSON 行 → 跳过
		return null;
	}
}

/** 从 JSONL 文件读入全部 FileEntry(header + 所有 entry);暴露给测试/工具用。 */
export function loadEntriesFromFile(filePath: string): FileEntry[] {

	// 流式加载(照生产 session-manager.ts:467):openSync 循环 readSync 读满 1MB 缓冲,
	// StringDecoder 处理跨块的多字节 UTF-8,再按换行切出每条 entry;坏 JSON/空行跳过。
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const entries: FileEntry[] = [];
	const fd = openSync(resolvedFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		let pending = "";

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex));
				if (entry) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		const finalEntry = parseSessionEntryLine(pending);
		if (finalEntry) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}

	// 校验 header:首行必须是 type:"session" 且有字符串 id;否则视为损坏,返回空
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return [];
	}

	return entries;
}