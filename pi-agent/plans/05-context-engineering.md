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
| coding-agent `core/` | types/messages/tool-definition-wrapper | `tools/truncate.ts`、`system-prompt.ts`、`compaction.ts`、`branch-summary.ts` |
| 系统提示词 | 目前 loop 用 `context.systemPrompt` 字符串 | `buildSystemPrompt` 组装器(分层 + XML + Skills 清单 + date/cwd) |

---

## 三、目标结构

```
packages/coding-agent/src/core/
  tools/truncate.ts         ★ 新建：DEFAULT_MAX_LINES/BYTES + truncateHead/Tail/Line + TruncationResult
  system-prompt.ts          ★ 新建：buildSystemPrompt + project-context 向上递归 + skills 清单
  compaction.ts             ★ 新建：shouldCompact + findCutPoint + makeCompactionSummaryMessage
  branch-summary.ts         ★ 新建：collectEntriesForBranchSummary(LCA) + makeBranchSummaryMessage
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

## 六、③ Compaction(`compaction.ts`)—— 依赖 03 消息体系

### 6.1 三件套(教学版)

```ts
// 1) 触发判定：contextTokens > window - reserve
export function shouldCompact(contextTokens, window = 8192, reserve = 2000): boolean
// 2) 切割点：从后往前累积 token，跳过 toolResult（保留"最近 N token 的完整消息"）
export function findCutPoint(messages: AgentMessage[], keepTokens: number): number
// 3) 产物：老前缀 → 一条 CompactionSummaryMessage（复用 03 的类型 + convert 规则）
export function makeCompactionSummaryMessage(summary, tokensBefore): CompactionSummaryMessage
```

- **token 估算代理**:无真实 tokenizer,用 `chars/4`(或 `messages` 加权)做代理,注释明示"生产用 tokenizer,教学用代理"。
- `findCutPoint` 从后往前,遇 `toolResult` **跳过**(它紧贴 toolCall,留近段);`CompactionSummaryMessage` 有 `tokensBefore`。

### 6.2 触发与接入（对齐生产：agent_end 事件 + 会话层写状态）

- **默认摘要**:`summarize(messages)` 走 `streamMock` 截一段模板摘要(`Goal / Constraints / 关键决定 / read-files`)——mock 返回固定文本,足以驱动闭环。
- **触发点 = 04 的 agent_end**:loop `await emit({type:"agent_end", messages})`(04 已实现),Compactor 在 emit 的 `agent_end` 分支决策,结果写会话态。
- **拾取器**:6.1 三个纯函数喂给一个持有 pending 的 `Compactor`(`onAgentEnd` 决策 / `drain` 取走)。

```ts
// 04 的两管分叉 emit 里挂压缩（agent_end 时决策，await = 生产同步屏障）
const compactor = new Compactor({ summarize: mockSummarize });

const emit: AgentEventSink = async (event) => {
    await compactor.onAgentEnd(event);                 // ① agent_end：shouldCompact→findCutPoint→生成 summary（等）
    for (const listener of listeners) listener(event); // ② 管道 A（不等）
};

// 会话 wrapper：下一轮从压缩后上下文开跑（[summary, ...recent]）
async function runWithCompaction(prompts, config) {
    const newMessages = await runAgentLoop(prompts, { ...ctx, messages: sessionMessages }, config, emit);
    const compacted = compactor.drain();
    if (compacted) sessionMessages = compacted;
    return newMessages;
}
```
- `Compactor.onAgentEnd`:`shouldCompact(estimateTokens(event.messages))` → `findCutPoint`(跳过 toolResult)→ `makeCompactionSummaryMessage(mockSummarize(oldPrefix), cut)`。
- **不再走 `transformContext`**——生产里那是扩展 `context` 事件的落点(04 runner 未实现),与压缩无关。

> CompactionSummaryMessage 一旦进 context,就由 03 的 convertToLlm 自动翻成 `<summary>` user 消息——**你只生产消息,边界翻译不归本章管**。

---

## 七、③④ 分支摘要(`branch-summary.ts`)—— 纯算法,依赖 03

### 7.1 LCA 找分叉点(对齐生产 branch-summarization.ts:67-96)

```ts
// 旧路径 root→…→leafA，新路径 root→…→leafB
export function collectEntriesForBranchSummary(oldPath: string[], newPath: string[]): string[] {
    const inNew = new Set(newPath);
    // 新路径上从后往前,第一个也在旧路径里的节点 = LCA(分叉点)
    let lcaIndex = -1;
    for (let i = newPath.length - 1; i >= 0; i--) {
        if (oldPath.includes(newPath[i])) { lcaIndex = i; break; }
    }
    // 从旧路径末尾(leafA)向上爬到 LCA(不含 LCA),收集被放弃的分支
    const abandoned: string[] = [];
    for (let i = oldPath.length - 1; i >= 0; i--) {
        if (oldPath[i] === newPath[lcaIndex ?? -1]) break;
        abandoned.unshift(oldPath[i]);
    }
    return abandoned;
}
```
纯函数,拿两条 path 数组即测,不依赖会话基础设施。

### 7.2 摘要产物(依赖 03)

`generateBranchSummary(abandoned) → BranchSummaryMessage`——教学用 mock 生成(5 section:Goal/Constraints/Progress/Key Decisions/Next Steps,**无** Critical Context),`maxTokens=2048` 写死(更精简,它只是辅助上下文)。包上 BRANCH_SUMMARY_PREFIX(03 已定义)由 convertToLlm 翻译。

> 依赖答案再强调:分支摘要**只产出 03 定义好的 `BranchSummaryMessage`**,注入方式/时机(会话树切换)是后续 Tier；本章先落地 LCA 算法与生成函数。

---

## 八、全景链路(教学闭环)：read 一次文件

```
用户"读取 auth.ts" → [1] buildSystemPrompt(系统提示词,§五) → [2-3] loop 开始,mock toolCall read
→ [5] 执行 read → [6] truncateHead(2000 行/50KB,UTF-8 安全,§四) → [7] toolResult 进 context
→ [8] agent_end(turn) → [9] emit 的 agent_end 分支 shouldCompact? 否→照常;是→makeCompactionSummaryMessage、写会话态(§六,走 03 翻译),下一轮 `[summary, ...recent]`
   (切分支时 → collectEntriesForBranchSummary LCA → makeBranchSummaryMessage,§七,走 03 翻译)
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
| 分支 LCA | 旧路径 A/新路径 B → 返回被放弃段(不含 LCA),纯函数 |
| buildSystemPrompt 分层 | 输出含 角色/工具列表/date/cwd;有 projectContext 时含 `<project_instructions path=...>` |
| Skills 懒加载清单 | 只含 name/description/location + "Use the read tool..." 指令,无全文 |
| read 截断集成 | read 工具对长文件返回 `details.truncated` + 逃生提示 |

**现有 23 测试不回归**:read 截断只加在有 `truncate` 时才生效(小文件原样),其余新增是纯函数/新文件。

---

## 十、实施步骤(分 Tier)

**Tier 1：①截断 + ②系统提示词(独立,零外部依赖)**
1. `core/tools/truncate.ts`(双限制 + head/tail/line + XML 多字节安全)。
2. read 接 `truncateHead`,details 带截断信息。
3. `core/system-prompt.ts`(`buildSystemPrompt` 分层 + `loadProjectContextFiles` 注入 ops + `formatSkillsForPrompt`)。
4. 单测第 1-3、8-10 条。

**Tier 2：③Compaction(依赖 03)**
5. `core/compaction.ts`(shouldCompact/findCutPoint/makeCompactionSummaryMessage)+ mock 摘要。
6. agent 侧接入:04 的 emit 在 `agent_end` 分支 `compactor.onAgentEnd(event)` + 会话 wrapper `drain()` 喂下一轮(**不再走 transformContext**)。
7. 单测 4-6 条。

**Tier 3：④分支摘要(依赖 03;会话树后续)**
8. `core/branch-summary.ts`(LCA 纯函数 + makeBranchSummaryMessage)。
9. 单测第 7 条。

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