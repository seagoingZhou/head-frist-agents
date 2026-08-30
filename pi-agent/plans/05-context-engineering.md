# 上下文工程设计：四层防线（截断 / 系统提示词 / Compaction / 分支摘要）

> 项目最终目标：实现生产版 pi agent。本方案为**上下文工程**——在内容送进 LLM 前多层裁剪/过滤/压缩/组织,让有限窗口装下对当前任务最有价值的信息。
> 生产参考：`coding-agent/src/core/tools/truncate.ts`（截断算法）、`…/system-prompt.ts`（buildSystemPrompt）、`…/resource-loader.ts:85-123`（CLAUDE.md 递归）、`…/skills.ts:335-361`（懒加载）、`agent/src/harness/compaction/{compaction,branch-summarization}.ts`。

> 📌 **读生产源码先看这个：`agent/harness` 与 `coding-agent/core` 是两份平行实现,别搞混**。
> 原因:内核包 `@earendil-works/pi-agent` **不能 import 产品包** `pi-coding-agent`(反向依赖),但它想自带一个开箱即用的 coding agent,所以在 `agent/src/harness/` 里自包含重写了一份同样的概念(messages / compaction / system-prompt / skills / truncate),并经 `agent/src/index.ts` 公开导出;`coding-agent/src/core/*` 才是**产品真身**,`agent-session.ts` import 的是 core 那份。
> 差异:**harness 精简、可移植**(truncate 数字节带 `globalThis.Buffer` 回退,非 node 可跑);**core 更详尽**(compaction 893 行 vs harness 747、branch 371 vs 261),且接 session/扩展。
> **对我们**:本 repo 只有 coding-agent、没有 harness,05 一律照 **coding-agent/core 那套做**,不会踩两份不一致。

---

## 〇、先答依赖问题：上下文工程挂在哪条已有的链路上

| 依赖 | 关系 | 说明 |
|---|---|---|
| **消息系统 `03`** | 🔴 **必要依赖** | Compaction / 分支摘要的产物就是 03 早已定义的 `CompactionSummaryMessage` / `BranchSummaryMessage`;03 的 `convertToLlm` 已把它们翻成 `<summary>` 包裹的 user 消息——**产物无需新类型,直接进上下文即被 LLM 正确消费** |
| **事件系统 `04`** | 🔴 **必要依赖(Compaction)** | 生产 Compaction 在 **agent_end 之后**触发——agent_end 正从 04 的 `emit` 出来(已实现,loop 对 `emit(agent_end)` `await`,即同步屏障)。Compaction 挂在 emit 的 `agent_end` 分支、结果写会话态,下一轮 `[summary, ...recent]` 注入 |
| 截断 / 系统提示词组装 | 🟢 零依赖 | 纯函数,独立可做 |

> ⚠️ `transformContext` 明确**不用于压缩**:生产 `sdk.ts:350-354` 把 `transformContext` 接给扩展系统的 `context` 事件(`emitContext`,属 04 runner 未实现)——那是**扩展改写消息的落点**,与 Compaction 无关。压缩只走 agent_end(04 已实现,够用)。

**一句话**:截断 / 系统提示词独立;Compaction 产物寄生 03、触发走 04 已实现的 agent_end;**`transformContext` 别拿来当压缩入口**——生产里它是扩展 context hook。

---

## 一、问题与地图：窗口固定,对话无限增长

一次会话送进 LLM 的内容：系统提示词 / 项目上下文(CLAUDE.md)/ Skills / 工具定义 / 对话历史 / 新输入——随便一项都可能爆炸(`npm install` 十几 KB、read 5000 行文件 80KB、几十轮破 100K token),超窗直接 `prompt is too long`。

**两层防护 / 四层防线**：

```
输入侧(送进 LLM 之前)                   历史侧(长对话管理)
① 工具输出截断(每次工具调用)            ③ Compaction(阈值触发,旧消息→摘要)
② 系统提示词组装(每轮 prompt)           ④ 分支摘要(切分支时,旧分支→摘要)
```

设计精华:没有银弹,层层兜底;**"减法"(截断变小)+"加法"(注入规范/摘要)"塑形"而非单纯压缩**;**工具调用=按需上下文加载(拉模式 Skills)**。

---

## 二、现状清点(我们已有 vs 待建)

| 位置 | 现状 | 待建 |
|---|---|---|
| `01`、`02` 工具 | read 返回**全文**(无截断)、bash/find/grep 仍是接口桩 | read 接 `truncateHead`;bash 后补时接 `truncateTail`、grep 接 `truncateLine` |
| 03 消息系统 | `CompactionSummaryMessage` / `BranchSummaryMessage` 类型 + convert 规则**已就位**(`coding-agent/core/messages.ts`) | 无需新类型——只差"谁去生产它们" |
| 03 `transformContext` | loop 每轮调用前已执行(可注入) | ⚠️ 生产里它是扩展 `context` 事件(emitContext)的落点,**不是压缩入口** |
| 04 事件系统 | `emit` 分叉、agent_end 可达(带 messages) | Compaction 触发点:**agent_end 分支**(必要) |
| coding-agent `core/` | types/messages/tool-definition-wrapper | `tools/truncate.ts`、`system-prompt.ts`、`compaction/{index,compaction,branch-summarization,utils}.ts` |
| 系统提示词 | 目前 loop 用 `context.systemPrompt` 字符串 | `buildSystemPrompt` 组装器(分层 + XML + Skills 清单 + date/cwd) |

---

## 三、目标结构

```
packages/coding-agent/src/core/
  tools/truncate.ts         ★ 新建：DEFAULT_MAX_LINES/BYTES + truncateHead/Tail/Line + TruncationResult
  system-prompt.ts          ★ 新建：buildSystemPrompt + project-context 向上递归 + skills 清单
  compaction/
    index.ts                 ★ 新建：export * 三件（对齐生产 index.ts）
    compaction.ts            ★：shouldCompact / findCutPoint / prepareCompaction / generateSummary / compact
    branch-summarization.ts  ★：collectEntriesForBranchSummary(LCA) + prepareBranchEntries + generateBranchSummary
    utils.ts                 ★：序列化等工具（对齐生产 utils.ts）
  index.ts                  ★ 改：追加以上导出
packages/coding-agent/test/
  context-engine.test.ts    ★ 新建：截断单测 / cutpoint / LCA / 系统提示词
packages/coding-agent/src/tools/read.ts  ★ 改：接 truncateHead（details 带截断信息）
```

---

## 四、① 工具输出截断(`tools/truncate.ts`,零依赖,先做)

### 4.1 双重限制 + 双向策略(对齐生产 truncate.ts:11-13、78、168)

```ts
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;  // 50KB
export const GREP_MAX_LINE_LENGTH = 500;      // grep 单行限长

export interface TruncationResult {
    content: string;
    truncated: boolean;
    truncatedBy: "lines" | "bytes" | null;
    totalLines: number; totalBytes: number;
    outputLines: number; outputBytes: number;
    lastLinePartial: boolean;
}
```

- **双限制先触者胜**——行数管"可读性"、字节管"硬体积"(minified 单行几百 KB 时行数限制无用)。
- `truncateHead(content, opts)` — 从前往后保留**开头**(read 文件:import/接口密度最高)。
- `truncateTail(content, opts)` — 从末尾往回保留**末尾**(bash:错误堆栈最有信号)。伪码:

```ts
function truncateTail(content, { maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    const lines = content.split("\n");
    const kept: string[] = []; let bytes = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        const lineBytes = Buffer.byteLength(lines[i], "utf8") + 1;   // +1 换行
        if (kept.length >= maxLines) break;
        if (bytes + lineBytes > maxBytes) break;
        kept.unshift(lines[i]); held += lineBytes;                    // unshift 保持原序
    }
    ... 拼回 + 填 TruncationResult(truncatedBy/total/output) ...
}
```

### 4.2 三个边界细节(教学必带)

| 细节 | 做法 |
|---|---|
| **多字节 UTF-8 安全** | 按字符累加字节,遇到"加一字符就超限"停——用 `for...of` 逐码点而非 `slice` 按字节切;`Buffer.byteLength` 量大小 |
| **单行就超限(截尾兜底)** | 最长单行超 `maxBytes` 时取该行**末尾** `maxBytes` 字节并置 `lastLinePartial: true`,不返回空 |
| **grep 单行限长** | `truncateLine` 把超长行截到 500 字符 + `... [truncated]`(对齐 `GREP_MAX_LINE_LENGTH`) |

### 4.3 逃生通道

截断是有损的,但**不偷偷干**——截断后追加提示,让 LLM 知道完整输出在哪可自己拉:
```
[Showing lines 6501-8500 of 8500. Full output: /tmp/pi-xxx.log]
```
（bash 落盘是 Tier 2；read 的逃生命令就是 read 本身,提示"输出被截断,可用 limit/继续读"。）

### 4.4 落地

- **read**:`execute` 里 `truncateHead(content)` → `details.truncated`/`truncatedBy`/`outputLines`,超限时 append 逃生提示。
- **ls**:已有 `limit` 行数控制,可补 `entryLimitReached` 提示(现有)。
- **bash/grep/find**:仍是桩——实现时各自接 `truncateTail` / `truncateLine`。

---

## 五、② 系统提示词组装(`system-prompt.ts`)

### 5.1 `buildSystemPrompt({ userPrompt, cwd, date?, projectContext?, skills? })` 分层骨架

```
1. 角色定位   "You are an expert coding assistant..."
2. 工具列表   由传入的 ToolDefinition[] 生成 "- read: 读取文件..."
3. 通用 guidelines
4. [可选] 追加段(appendSystemPrompt)
5. <project_context>... <project_instructions path=...> ... </project_context>   ← 有则加
6. <available_skills>... <skill><name/><description/><location/></skill> ... </available_skills>
7. Current date: ${date}                          ← 相对时间推理
8. Current working directory: ${cwd}              ← 相对路径处理
```

- **XML 包装**:`<project_instructions path="/root/CLAUDE.md">` 明确边界 + 带来源路径 → LLM 区分"组织级/项目级"优先级。
- **date / cwd 放末尾**——"基本元数据",LLM 处理"昨天/上周"/相对路径需要。

### 5.2 多层 CLAUDE.md 向上递归(`loadProjectContextFiles(cwd)`)

对齐生产 `resource-loader.ts:85-123`:

```
1. agentDir/CLAUDE.md   ← 全局(用户级)
2. 祖先目录/CLAUDE.md   ← 从 / 到 cwd 上一层(从外到内,先通用)
3. cwd/CLAUDE.md        ← 当前项目(最具体,放最后)
```
逐一 `access` + `readFile`,存在才收集。教学版建议做**纯函数 + 注入 ops**(对齐 read 的 Operations 模式),cwd 默认 WORKSPACE_ROOT,避免真 fs 难测。

### 5.3 Skills 懒加载(拉模式,只放清单)

`formatSkillsForPrompt(skills)` → `<available_skills><skill><name/><description/><location/></skill></available_skills>` + 顶部指令:
> "Use the read tool to load a skill's file when the task matches its description."

**全文不塞**——10 个 skill 全文≈50K token 大多无关;清单≈500 token,LLM 用时 `read` 拉。这就是"工具调用=按需上下文加载"。

---

## 六、③ Compaction(`core/compaction/compaction.ts`)—— 依赖 03 消息体系

### 6.1 与生产同名的函数套（对齐 `core/compaction/compaction.ts`，不自建新名）

```ts
// 触发判定：contextTokens > contextWindow - reserve
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean
// 切割点：从 endIndex 往回累积 token 找保留点（生产 :392；跳过 toolResult，留给最近 N token 的完整消息）
export function findCutPoint(entries, startIndex, endIndex, keepRecentTokens): CutPointResult
// 编排：切割 + 生成摘要 + 装配写回（生产 :759）
export async function compact(session, entryIndex, options?): Promise<CompactionResult>
// 摘要文本的 LLM 调用（生产 :565）——教学版体里走 streamMock 出模板摘要
export async function generateSummary(...): Promise<string>
```

- **产物不是这里的函数**——工厂是生产 03 的 **`messages.ts:createCompactionSummaryMessage(summary, tokensBefore, timestamp)`**,由 `compact()`/`prepareCompaction()` 内部调用(`compaction.ts:90`)。教学版先在 03 补该工厂(带第 3 参 `timestamp`)。
- **token 估算代理**:生产 `estimateTokens`/`calculateContextTokens`/`estimateContextTokens` 用 tokenizer;教学用 `chars/4` 代理,注释明示。
- `findCutPoint` 从后往前累积 token、跳过 toolResult;`CompactionSummaryMessage` 有 `tokensBefore`(被压缩段 token)。

### 6.2 触发与接入（对齐生产：agent_end 事件 → 会话层 `compact()` 写状态）

- **默认摘要**:`generateSummary` 的体用 `streamMock` 产出模板摘要(Goal / Constraints / 关键决定 / read-files),驱动闭环。
- **编排真名是 `compact()`**(compaction.ts:759):内部 `prepareCompaction` → `findCutPoint` → `generateSummary` → **`createCompactionSummaryMessage(...)`** → `[summaryMsg, ...remaining]` 写会话态。**不存在 `Compactor` / `onAgentEnd` / `drain` 这类自造名**。
- **触发点 = 04 的 agent_end**:生产的 `agent-session` 订阅 `agent_end` → `_checkCompaction`(agent-session.ts:979)→ `shouldCompact` → `compact()`。04 的 emit 分叉在 `agent_end` 分支做同一件事(loop 对 `emit(agent_end)` `await` = 同步屏障)，产物进会话态，下一轮从 `[summary, ...recent]` 开跑。
- **入参与会话**:生产 `compact()`/`findCutPoint` 吃 `SessionEntry[]` / `SessionManager`(见 `core/session-manager.ts`)；教学先落地纯函数(messages 裁剪版),会话入参对齐等 session-manager 齐了再动。
- **不再走 `transformContext`**——生产里那是扩展 `context` 事件的落点(04 runner 未实现),与压缩无关。

> CompactionSummaryMessage 一旦进 context,就由 03 的 convertToLlm 自动翻成 `<summary>` user 消息——**你只生产消息,边界翻译不归本章管**。

### 6.3 深挖：完整压缩算法与链路（对齐生产 `core/compaction/{compaction,utils}.ts` + `session-manager.ts`）

> 核心时序先记住:**压缩在两轮之间发生**——`agent_end` → `shouldCompact` → `compact()` → `CompactionEntry` 写会话树 → **下次** `buildSessionContext()` 重建上下文(旧消息被摘要替换)。context 不立即变,而是"下次构造时再生"——压缩无副作用,失败大不了不压。

#### ① 触发与估算（✅ `shouldCompact` compaction.ts:181 / `estimateTokens` :214）

`shouldCompact`:contextTokens > window − reserve(`reserveTokens` 是留给 LLM 回复的余量,不能塞满窗口)。`estimateTokens`:chars/4——⚠️ **中文严重低估**(1 汉字实际约 1-2 token),纯中文场景可能"没到阈值就快超窗"。原则:**宁可高估不可低估**——高估最多多压一次(无害),低估会触发 API 报错(有害),用精度换安全。

#### ② 切割点（✅ `findValidCutPoints` / `findTurnStartIndex` :340 / `findCutPoint` :383）

- **合法切点 = user / assistant**;`findValidCutPoints` **排除 toolResult**(它必须紧跟 toolCall,否则模型"调了工具却没结果"——上下文断裂,不可妥协的硬约束)。
- **切点语义 = 保留区的第一条**(不是被删的最后一条)。切在 user 上 → 它后面的 assistant/toolResult 全进保留区,Turn 天然完整(最安全的切法)。
- **算法**:`findCutPoint` 从最新往旧累积 token,达 `keepRecentTokens`(缺省 20K)就在那附近切——**最近的上下文最重要**(模型需要"刚才读了什么/用户最新说了什么",比"10 轮前聊了什么"关键得多)。

#### ③ 摘要生成（✅ `generateSummary` :665 + `SUMMARIZATION_PROMPT`/`UPDATE_SUMMARIZATION_PROMPT` + `serializeConversation` utils:89）

- 固定 **6-section 模板**(Goal / Constraints&PReferences / Progress[Done·InProgress·Blocked] / Key Decisions / Next Steps / Critical Context)——固定模板对抗 LLM 自由发挥漏记核心需求("易遗漏"变"必须填")。
- **增量更新**:多次压缩时传 `previousSummary`,走 `UPDATE_SUMMARIZATION_PROMPT` **更新而非重写**(保留 Goal/Constraints,追加 Progress),防摘要漂移的累积误差。
- 流程:`convertToLlm(旧消息)` → `serializeConversation` 序列化成文本(避免模型误以为要接着对话) → `<conversation>…</conversation>`(+`<previous-summary>`)包裹 → 一次 LLM 调用出结构化摘要。

#### ④ 文件跟踪（⏳ `extractFileOperations` ✅ / `formatFileOperations` 待补）

- `extractFileOperations` 从**两个来源**累积:上一次压缩的 `details.readFiles/modifiedFiles` + 被压缩消息的 toolCall(read→readFiles、write/edit→modifiedFiles)。
- 摘要末尾用 **`formatFileOperations`** 输出 `<read-files>…</read-files>` / `<modified-files>…</modified-files>` 标签——编码 Agent 的领域知识:"改过哪些文件"比"聊过什么"更精确可验证,避免重复读/覆盖他人改动。

#### ⑤ Turn 分割（⏳ `prepareCompaction` 已产出 `turnPrefixMessages`;`TURN_PREFIX_SUMMARIZATION_PROMPT` + 并行生成待补）

- 切在 **assistant** 上 = 切断 Turn(user 在压缩区、assistant 在保留区)→ `isSplitTurn: true` → `findTurnStartIndex` 找出该轮 user 起点,`turnPrefixMessages`(user 起点到切点之间)单独生成**轻量 3 段前缀摘要**(Original Request / Early Progress / Context for Suffix),与主摘要 **`Promise.all` 并行**(生产 :784-813),合并进同一 CompactionEntry。
- **为什么允许 assistant 切点**:只允许 user 切点 → 保留区永远过大、压缩压不动(可能 token 预算只够留 2-3 条却被迫从最近的 user 开始留);允许 assistant 切点 → 精确控 token,代价是 Turn 被切 → 用 turnPrefix 机制弥补。生产选后者(优先保证压缩能生效)。

#### ⑥ 结果生效（✅ 会话层具备:session-manager `CompactionEntry` + `buildSessionContext`）

```
CompactionEntry { type:"compaction", summary, tokensBefore, firstKeptEntryId, details:{readFiles,modifiedFiles} }
```
- `buildSessionContext()`(session-manager.ts:142)遍历路径遇到 CompactionEntry → 用 `createCompactionSummaryMessage(summary, tokensBefore, timestamp)`(messages.ts:143)生成 `CompactionSummaryMessage` 替换旧消息,其后消息正常 push。
- 03 的 `convertToLlm` 把它翻成 `<summary>` user 消息 → LLM 看到"之前的历史压缩成了结构化摘要"。

#### ⑦ 自动压缩集成（⏳ 走 04 的 emit）

- 生产:agent-session 订阅 `agent_end` → `_checkCompaction`(agent-session.ts:979)→ `shouldCompact` → `compact()`;发 `compaction_start / compaction_end` 事件(管道 B,reason: "manual" | "threshold" | "overflow")供 UI 显示进度。
- 我们:04 的 emit 在 `agent_end` 分支做等价决策(`await` = 生产同步屏障),产物进会话态,下一轮从 `[summary, ...recent]` 开跑(见 §十 Tier-2 阶段 B-6)。

#### ⑧ 设计精华

1. **向后遍历 + 合法切点** = 找"哪里值得保留"而非"哪里能删";toolResult 约束不可妥协。
2. **结构化模板 + 增量更新** = 用 prompt 设计对抗 LLM 认知偏差(固定 section 强制覆盖每个维度;增量防漂移)。
3. **文件跟踪累积** = 通用压缩机制承载领域特定知识(details 字段),跨压缩累积。

#### 当前实现状态对照（2026-08-24 review）

| 环节 | 生产参照 | 我们 | 状态 |
|---|---|---|---|
| 触发/估算 | `shouldCompact`(:225) / `estimateTokens`(:256) / `estimateContextTokens`(:192) | compaction.ts:181 / :214 / :146 | ✅ |
| 切割 | `findValidCutPoints` / `findTurnStartIndex`(:350) / `findCutPoint`(:392) | 本文件 | ✅ |
| 准备分割 | `prepareCompaction`(:652) / `CompactionPreparation`(:634) | :475 / :456 | ✅ |
| 摘要调用 | `generateSummary`(:565) + `serializeConversation`(utils:109) | :665 | ✅ |
| 提示词 | `SUMMARIZATION_PROMPT`(:460) / `UPDATE_SUMMARIZATION_PROMPT`(:493) | 本文件 | ✅ |
| **编排** | **`compact()`(:759) / `CompactionResult`(:103)** | — | ⏳ |
| **turnPrefix** | **`TURN_PREFIX_SUMMARIZATION_PROMPT`(:737) + 并行** | — | ⏳ |
| **文件标签** | **`formatFileOperations`(utils:72)** | — | ⏳ |
| 会话存储/重建 | `CompactionEntry` + `buildSessionContext` | session-manager.ts | ✅ |
| 消息工厂 | `createCompactionSummaryMessage`(messages:109) | messages.ts:143 | ✅ |
| 自动触发 | `agent-session` agent_end → `compact()` | 走 04 emit(未接) | ⏳ |

---

## 七、④ 分支摘要(`core/compaction/branch-summarization.ts`)—— 纯算法,依赖 03

### 7.1 LCA 找分叉点(对齐生产 branch-summarization.ts:102,不自建签名)

生产真名与签名(照抄):
```ts
export function collectEntriesForBranchSummary(
    session: ReadonlySessionManager,
    oldLeafId: string | null,
    targetId: string,
): CollectEntriesResult   // { entries: SessionEntry[]; commonAncestorId: string | null }
```
算法(生产 102-125):两侧各取分支路径(`session.getBranch(id)`,root-first);目标路径从后往前找第一个也在旧路径里的节点 = **公共祖先**(`commonAncestorId`);旧路径从叶子向上爬到公共祖先(不含)→ 被放弃的分支 `entries`。`oldLeafId` 为空 → `{ entries: [], commonAncestorId: null }`。教学版可先抽纯函数再用假 session 测。

### 7.2 摘要产物(依赖 03)

- 工厂:03 的 `messages.ts` 补 **`createBranchSummaryMessage(summary, fromId, timestamp)`**;`generateBranchSummary`(branch-summarization.ts:287)产出摘要文本后交给它,并包上 `BRANCH_SUMMARY_PREFIX`(03 已有)由 convertToLlm 翻译。
- 教学用 mock 生成 5 section(Goal / Constraints / Progress / Key Decisions / Next Steps,**无** Critical Context);`maxTokens=2048` 写死(它只是辅助上下文)。

> 依赖答案再强调:分支摘要**只产出 03 定义好的 `BranchSummaryMessage`**;注入方式/时机(会话树切换)是后续 Tier；本章先落地 LCA 算法与生成函数。

---

## 八、全景链路(教学闭环)：read 一次文件

```
用户"读取 auth.ts" → [1] buildSystemPrompt(系统提示词,§五) → [2-3] loop 开始,mock toolCall read
→ [5] 执行 read → [6] truncateHead(2000 行/50KB,UTF-8 安全,§四) → [7] toolResult 进 context
→ [8] agent_end(turn) → [9] emit 的 agent_end 分支 shouldCompact? 否→照常;是→compact()→createCompactionSummaryMessage、写会话态(§六,走 03 翻译),下一轮 `[summary, ...recent]`
   (切分支时 → collectEntriesForBranchSummary LCA → createBranchSummaryMessage,§七,走 03 翻译)
```
四层组合成一漏斗:**①单条体积 → ②提示词内容 → ③长对话总长 → ④多分支信息**。

---

## 九、测试设计(`coding-agent/test/context-engine.test.ts`)

| 用例 | 断言 |
|---|---|
| truncateTail 保留末尾 | 8000 行输入 → 输出 ≤ 2000 行且**以原文件末尾几行结尾**、`truncated: true` |
| truncateHead 保留开头 | 3000 行 → 以开头 import 行开头、`truncatedBy` 是 "lines"/"bytes" 之一 |
| 双限制先触者胜 | 超字节不超行(每行 10KB × 10 行)→ `truncatedBy: "bytes"` |
| 多字节安全 | emoji 行不被切坏(逐码点) |
| findCutPoint 跳过 toolResult | 尾部连续 toolResult → 切割后最近的 toolResult 保留 |
| shouldCompact 阈值 | tokens > window−reserve → true |
| collectEntriesForBranchSummary | 两叶子路径 → 返回被放弃 entries + commonAncestorId(不含公共祖先),纯函数 |
| buildSystemPrompt 分层 | 输出含 角色/工具列表/date/cwd;有 projectContext 时含 `<project_instructions path=...>` |
| Skills 懒加载清单 | 只含 name/description/location + "Use the read tool..." 指令,无全文 |
| read 截断集成 | read 工具对长文件返回 `details.truncated` + 逃生提示 |

**现有 23 测试不回归**:read 截断只加在有 `truncate` 时才生效(小文件原样),其余新增是纯函数/新文件。

---

## 十、实施步骤(分 Tier)

**Tier 1：①截断 + ②系统提示词(✅ 已完成)**
1. `core/tools/truncate.ts`(双限制 + head/tail/line + XML 多字节安全)。
2. read 接 `truncateHead`,details 带截断信息。
3. `core/system-prompt.ts`(`buildSystemPrompt` 分层 + `loadProjectContextFiles` 注入 ops + `formatSkillsForPrompt`)。
4. 单测第 1-3、8-10 条。

**Tier 2：③Compaction(依赖 03)——逐步对齐生产 `core/compaction/{compaction,utils}.ts`**

**阶段 A(✅ 已完成,按生产名落地)**:`shouldCompact`(:225)/ `estimateTokens`(:256)/ `estimateContextTokens`(:192)/ `findValidCutPoints`/ `findTurnStartIndex`(:350)/ `findCutPoint`(:392)/ `prepareCompaction`(:652)+ `CompactionPreparation`(:634)/ `generateSummary`(:565)+ `SUMMARIZATION_PROMPT`(:460)+ `UPDATE_SUMMARIZATION_PROMPT`(:493)/ `serializeConversation`(utils:109)/ 工厂 `createCompactionSummaryMessage`(messages:109)。

**阶段 B(⏳ 按序补齐,每步标注生产参照与验证)**:
1. **`formatFileOperations`**(生产 `utils.ts:72`):由 `FileOperations` 输出 `<read-files>…</read-files>` / `<modified-files>…</modified-files>` 文本。**验证**:单测 `read={a}, edited={b}` → 两段标签,只读未改的进 read、改过的进 modified。
2. **`CompactionResult`**(生产 `compaction.ts:103`):按生产形态定义(含 `entry: CompactionEntry` 与 kept 信息)。**验证**:typecheck。
3. **`TURN_PREFIX_SUMMARIZATION_PROMPT`**(生产 `compaction.ts:737`)+ turnPrefix 摘要生成(生产 :855 区域,`maxTokens = min(0.5 × reserveTokens, model.maxTokens)`、3 段格式 Request/Progress/Context)。**验证**:`prepareCompaction` 产出 `isSplitTurn=true` 时能生成前缀摘要。
4. **`compact()`**(生产 `compaction.ts:759` 编排):`prepareCompaction → 无则 return undefined → generateSummary(主摘要)+ turnPrefix 并行(Promise.all,生产 :784-813)→ createCompactionSummaryMessage → 返回 CompactionResult`。**验证**:单测"切割+摘要 → 产物含 summary/tokensBefore/firstKeptEntryId"。
5. **会话写入**:`compact()` 结果作为 `CompactionEntry` 追加(对齐 session-manager 形状);`buildSessionContext` 已支持重建(session-manager.ts:220 已用 `createCompactionSummaryMessage`)。**验证**:构造含 compaction entry 的路径 → buildSessionContext 出 `[CompactionSummaryMessage, ...kept]`。
6. **agent 侧集成**:04 的 emit 在 `agent_end` 分支:`estimateContextTokens` → `shouldCompact` → `compact()`;产物写会话态;发 `compaction_start / compaction_end`(管道 B,reason "threshold")。**不再走 transformContext**。**验证**:端到端——两次 `runAgentLoop`,第二轮 context 以 `compactionSummary` 开头,`convertToLlm` 后 LLM 只见 `<summary>` user。
7. **单测**:`findCutPoint`(尾部连续 toolResult 不切)/ `prepareCompaction`(isSplitTurn 判定)/ `generateSummary`(mock 出 6-section)/ 端到端(见上)。

**Tier 3：④分支摘要(依赖 03;会话树后续)——对齐生产 `core/compaction/branch-summarization.ts`**
1. `collectEntriesForBranchSummary(session, oldLeafId, targetId): CollectEntriesResult`(生产 :102)——依赖会话 `getBranch`;若 session-manager 暂无 `getBranch`,先按"两路径找公共祖先(LCA)"的纯函数落地,**签名保持生产形**,会话树齐了再对齐入参。
2. `prepareBranchEntries(entries, tokenBudget)`(生产 :189)。
3. `generateBranchSummary(...)`(生产 :287,5-section 无 Critical Context、`maxTokens=2048`)+ 03 工厂 `createBranchSummaryMessage(summary, fromId, timestamp)`(messages:134)。
4. **单测**:`collectEntriesForBranchSummary` 返回被放弃 entries + `commonAncestorId`(不含公共祖先)。

---

## 十一、常见坑

| 坑 | 症状 | 解法 |
|---|---|---|
| 只限行数/只限字节 | 单行爆炸 / 200 行被切一半 | 双限制先触者胜 |
| 按字节 slice 截断 | `�` 乱码 | 逐码点 + `Buffer.byteLength` 量;代理对整体保留/整体丢弃 |
| 截断不告知 LLM | LLM 以为看到全文 | 追加 `[Showing ... Full output: ...]` / 让 details 带 truncated |
| 摘要产物不是 AgentMessage | 编译报错 | 复用 03 的 `CompactionSummaryMessage`/`BranchSummaryMessage`(声明合并后已含) |
| 只靠压缩不管单条 | 单条 80KB 撑不过一轮 | 截断在前,压缩在后,层层兜底 |
| Skills 全文塞系统提示词 | 50K token 大部分无关 | 只放清单,LLM 用 read 按需拉 |