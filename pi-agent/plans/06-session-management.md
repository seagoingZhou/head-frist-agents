# 六、会话管理：Session Tree 与会话持久化

> 本章回答一个前几章反复出现、但一直没展开的概念——**Session Tree**。压缩时我们一直说"压缩结果（`CompactionEntry`）写在 Session Tree 上、`buildSessionContext()` 从树上构建 LLM 的上下文"(见 `05`)。本章把"会话数据怎么存"讲透,并**严格对齐生产代码**(行号均核对自 `/Users/zhouzhou/Program/AICoding/pi`)。

## 〇、关键源码索引

| 文件 | 内容 | 关键锚点 |
|---|---|---|
| `packages/agent/src/harness/types.ts` | 通用会话层:`SessionTreeEntry` 联合类型(11 种)、`SessionContext`、`SessionStorage` 接口 | `SessionTreeEntryBase`:334、`SessionTreeEntry` 联合:409、`SessionContext`:422、**`SessionStorage` 接口:440** |
| `packages/agent/src/harness/session/jsonl-storage.ts` | `JsonlSessionStorage`(文件实现的 `SessionStorage`) | **类定义:161** |
| `packages/agent/src/harness/session/memory-storage.ts` | `InMemorySessionStorage`(内存实现,测试用) | **类定义:40** |
| `packages/coding-agent/src/core/session-manager.ts` | coding-agent 的 `SessionManager`(1578 行);纯函数 `buildSessionContext`、entry 类型、JSONL 持久化 | `SessionEntry` 联合:140、**`buildSessionContext`:325**、`SessionStorage` 无关的**`SessionManager` 类:758**、`_persist`:909、`_appendEntry`:938、`appendCompaction`:991、`getBranch`:1152、`branch`:1244、**`branchWithSummary`:1265**、`createBranchedSession`:1289 |
| `packages/coding-agent/src/core/compaction/branch-summarization.ts` | 分支摘要生成(出入参参照 05) | `generateBranchSummary` |

行号核对日期:2026-09。生产参照仓库为 `pi`;本教学仓(coding-agent)已落地 **entry 类型 + 纯函数 `buildSessionContext`/`getLatestCompactionEntry` + 完整 `SessionManager` 类 + JSONL 存储**(对应 §九 Tier 1-3);agent 侧集成(`Agent` / `AgentSession`)为**骨架**(Tier 4 Phase 0/1)。⚠️ **命名纪律:禁止自造名**,教学任何字段/方法/类型名必须能在生产找到同名——历史自造名(`getBranchPath`/`getEntryById`、`CompatThinkingLevel`)均已消除。

---

## 一、问题：会话数据怎么存？

前几章我们一直在跟 `context.messages` 打交道——它是一个数组,存着当前轮的对话。但每次 Agent 启动时,这个数组从哪来?关闭后到哪去?

这引出一个最基础的工程问题:**会话数据怎么存?** 这个问题其实包含两个独立的子问题,必须拆开看:

- **子问题 A:存在哪里?**(存储介质)
- **子问题 B:长什么样?**(数据结构)

两个维度**正交**——你可以"用 mysql 存线性数组",也可以"用 JSONL 文件存一棵树"。混淆它们会让后续讨论糊成一团。

### 子问题 A:存在哪里?(介质)

做过后端的第一反应是 mysql / postgres——一张 `messages` 表,`user_id + role + content + timestamp`,按会话 id 分组。Pi 的 coding-agent 没走这条路,选的是**本地 JSONL 文件**:每个会话一个 `.jsonl` 文件,一行一个 entry,纯文本。为什么不选数据库?跟产品定位有关——单用户、本地跑、会话跟项目走、零运维、可 `cat`/`grep` 直接调试。数据库那套并发/索引/事务全是过度设计。

归档位置是 `~/.pi/agent/sessions/` 下的**按 cwd 编码的目录**(不是项目目录里的 `.pi/sessions`):
- `~/.pi` 来自 `config.ts:491` 的 `CONFIG_DIR_NAME`、`getAgentDir()` 返回 `~/.pi/agent`(`config.ts:515`);
- 每个工作目录对应 `~/.pi/agent/sessions/--{cwd 路径中的 / 和 : 换成 -}--/`(生产 `getDefaultSessionDirPath`,`session-manager.ts:439`);这样 `cd /project-a` 打开的就是项目 a 的会话档案。

但 Pi 没把这条路焊死。agent-core('`packages/agent/src/harness`')提供一个 **`SessionStorage` 接口**(`harness/types.ts:440`),自带两个实现:**`JsonlSessionStorage`**(文件,`jsonl-storage.ts:161`)和 **`InMemorySessionStorage`**(内存,测试用,`memory-storage.ts:40`),其他应用可以自己用数据库实现。

> ⚠️ 注意一份层次差异:agent-core 的 `SessionStorage` **不是** coding-agent 的 `SessionManager` 实现的接口——coding-agent 的 `SessionManager`(session-manager.ts:758)**完全没用这套抽象**,它自己同步读写 JSONL(见 §六/§七)。而且 coding-agent 连类型都是**自己定义的**:`SessionEntry` 联合定义在 `session-manager.ts:140`,只从 agent-core import 了 `AgentMessage` 与 `uuidv7`,没复用 `SessionTreeEntry`。这是 Pi 内部各包"接口存在但不强制复用"松散耦合的一个真实案例。

### 子问题 B:长什么样?(结构)

最直觉的答案是**线性数组**。但真实对话不总线性:你回退、你重试、你在某节点分叉比较两条路线。线性数组做"回退/分叉"意味着删后面的消息——删了就没了,两条分支的记录无法并存。

Pi 的答案是 **Session Tree**:把对话历史组织成一棵**只追加、不修改、不删除**的树。回退/分支不是"删数据",而是**移动一个指针**(`leafId`)。

| 维度 | 一般选择 | Pi 的选择 |
|---|---|---|
| 存哪里 | mysql 等数据库 | 本地 JSONL 文件(接口允许换) |
| 长什么样 | 线性数组 | 树(Session Tree) |

下面用一个完整会话把这棵树一步步"长"出来。

---

## 二、跟着一次真实会话看树怎么长

场景:调试一个认证 bug。8 步操作:① 切模型 → ② 问 "auth.ts 里 salt 验证为什么失败?" → ③ Agent 决定调 read 读 auth.ts → ④ read 返回内容 → ⑤ Agent 回复 "问题在 23 行,salt 没编码" → ⑥ 不满意,回退到 ② → ⑦ 换思路问 "先看 hash 函数" → ⑧ Agent 调 grep+read 出新分析。

**Step 1 切模型,首个节点上树。** 文件第一行是 Session Header(文件元信息,不是树节点)。切模型产生第一个树节点 `ModelChangeEntry`(生产字段是 `provider` + `modelId`,见 `appendModelChange`,`session-manager.ts:977`):

```json
{ "type": "model_change", "id": "e1", "parentId": null,
  "provider": "anthropic", "modelId": "claude-sonnet-4-6", "timestamp": "..." }
```

**Step 2 提问,`MessageEntry` 上树。** `e2.parentId = e1`,指向"上一个节点",不指向 header。

```
e1 (model_change)
 └── e2 (user: "auth.ts 里 salt 验证为什么失败?")
       ↑ leafId
```

**Step 3 Agent 调 read,一条 AssistantMessage 上树。** 文本和 ToolCall **在同一个 content 数组、同一个节点**里,`stopReason: "toolUse"`(不是"文本一个节点+工具调用一个节点"):

```
e2 (user)
 └── e3 (assistant: {text: "让我读一下 auth.ts", toolCall: read{path:"src/auth.ts"}}, stopReason: toolUse)
```

**Step 4 工具结果,`ToolResult` 上树。** `toolCallId: "call_001"` 精准关联回发起它的 ToolCall(02 工具系统里"工具结果必须关联回调用请求"在数据层的体现)。

**Step 5 Agent 出分析。** 至此 5 个节点一条直线 = **主分支**。注意每步只做两件事:创建新节点(带 parentId)+ 移动 `leafId`,没有任何旧节点被改——这就是"追加"。

**Step 6 回退——关键转折。** 你不满意,执行 `branch("e2")`。生产语义只有一行(`branch`,`session-manager.ts:1244`):

```ts
branch(branchFromId: string): void {
	if (!this.byId.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
	this.leafId = branchFromId;   // 核心就是这一行
}
```

e3/e4/e5 **一个都没删**——它们还在 `byId`、还在 `.jsonl` 文件里,只是不在当前路径上。为什么保留?因为你不知道以后会不会想回来看旧的"问题在 23 行"分析。回退不是删数据,是移动指针。

**Step 7 换思路问,新分支自然长出。** `e6.parentId = e2`,**和 e3 共享同一个父**——两个节点共享一个 parent 就是树上的两个分支(分支不是独立 API,是"回退+追加"的组合结果)。

**Step 8 新分支继续长。** 最终整棵树 9 个节点、两个分支,所有数据完好在册:

```
e1 (model_change)
 └── e2 (user: "salt 验证为什么失败?")
      ├── e3 (assistant: read auth.ts)
      │    └── e4 (toolResult: auth.ts 内容)
      │         └── e5 (assistant: "问题在 23 行")     ← 被抛弃分支,数据完整保留
      │
      └── e6 (user: "先看 hash 函数的实现")
           └── e7 (assistant: grep hash)
                └── e8 (toolResult: grep 结果)
                     └── e9 (assistant: 新分析)
                           ↑ leafId 在当前分支末端
```

**Session Tree 的状态变化:append-only**

三帧快照说明树的演化——① 当前在 A2 → ② 用户回退到 A1(只移 `leafId`,`O(1)`,A2/A3 仍在树上) → ③ 从 A1 长出新分支 B1→B2。所有"被抛弃"的分支**永不删除**,是 append-only 的铁律:

```
①当前 leafId=A2        ②回退到 A1             ③从 A1 长出新分支 B
root                  root                  root
A1                    A1 ←leafId            A1
A2 ←leafId            A2  A3(仍在树上)        A2  A3  B1
A3                                          B2 ←leafId
```

三种操作都是 O(1):**追加**(写新节点+移 leafId)、**回退**(只移 leafId)、**重试**(回退+追加)。走错路就分叉,不删数据,所有分支活在同一份文件里。

---

## 三、树上节点的解剖

### 3.1 一个完整的 `MessageEntry`

Step 3 那条 AssistantMessage 在 `.jsonl` 里是一行(展开便于读):

```json
{
  "type": "message", "id": "e3", "parentId": "e2",
  "timestamp": "2026-07-03T10:23:45.000Z",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "让我读一下 auth.ts" },
      { "type": "toolCall", "id": "call_001", "name": "read", "arguments": { "path": "src/auth.ts" } }
    ],
    "model": "claude-sonnet-4-6", "stopReason": "toolUse",
    "usage": { "input": 1250, "output": 80 }
  }
}
```

| 字段 | 干什么 | 设计动机 |
|---|---|---|
| `type: "message"` | 区分节点类型 | 树上不止消息,还有 model_change、compaction 等 |
| `id` | 节点唯一标识 | 别的节点通过 `parentId` 指向它;真实 id 是 8 位十六进制(`randomUUID().slice(0,8)`,见 `generateId`,`session-manager.ts:216`),会话头 id 是 `uuidv7()`(:203) |
| `parentId` | 指向父节点 | **认父不认子**——节点不知道自己有哪些子节点 |
| `timestamp` | 创建时间 | 排序、调试;也用于 JSONL 顺序 |
| `message` | 真正的消息载荷 | role + content + model 等(03 消息系统讲过) |

### 3.2 "认父不认子"是 append-only 的必要条件

关键点:`parentId` 是单向的。节点知道自己从哪来,父节点不知道自己有哪些孩子。这不是疏忽——如果父节点维护 `children` 列表,那么追加新子节点就得回去修改父节点,违反 append-only 铁律。所以结构上单向,但**反向可查**:内置 `byId` 映射表(`id → entry`)全量维护,`getChildren(parentId)`(`session-manager.ts:1102`)/`getTree()`(:1194)按需"算"出孩子/整棵树,从不落盘。

### 3.3 9 种 Entry 类型,按"对 LLM 的影响"分三组

coding-agent 的 `SessionEntry` 联合(`session-manager.ts:140`)共 9 种。看起来多,按三组分就清晰了:

**组① 进 LLM 上下文(4 种)——`buildSessionContext` 时 push 进 `messages` 数组:**

| 类型 | 产生什么消息 | 例子 |
|---|---|---|
| MessageEntry | User / Assistant / toolResult | 第 2-5 步的所有对话消息 |
| CustomMessageEntry | CustomMessage(03 的自定义消息) | 扩展注入的特殊消息 |
| CompactionEntry | CompactionSummaryMessage(替换旧消息) | 05 的压缩结果 |
| BranchSummaryEntry | BranchSummaryMessage(被弃分支的摘要) | §四 |

**组② 影响后续 LLM 调用(2 种)——不进 messages,但改 `buildSessionContext` 返回的状态变量:**

| 类型 | 改变什么 | 例子 |
|---|---|---|
| ModelChangeEntry | 后续用哪个模型(`model` 变量) | 第 1 步切模型 |
| ThinkingLevelChangeEntry | 后续的思考级别(`thinkingLevel` 变量) | 用户调思考强度 |

**组③ 纯元数据(3 种)——既不进 messages 也不改状态,只给 UI/扩展:**

| 类型 | 干什么 |
|---|---|
| LabelEntry | 给节点贴书签 |
| SessionInfoEntry | 会话元信息(显示名等) |
| CustomEntry | 扩展自己存的元数据 |

> ⚠️ 层间差异:agent-core 的 `SessionTreeEntry`(`harness/types.ts:409`)**比 coding-agent 多 2 种**,共 11 种——`ActiveToolsChangeEntry`(:357,工具集变更,进状态变量 `activeToolNames`)和 `LeafEntry`(:404,记录叶子指针的持久化节点)。这说明 harness 把"叶子在哪"也落盘成 entry,coding-agent 的 `leafId` 则只存在内存里。后面 §五/§七还会看到这两处差异互相呼应。

为什么类型分这么细?因为 `buildSessionContext()` 需要按类型**分派**——是消息就进数组、是状态变更就改变量、是元数据就跳过。全塞一种类型,分派逻辑就堆满 if-else。

---

## 四、三个核心操作 + 分支摘要

### 操作 1:追加——O(1),不改任何旧节点

追加分两步:构造 Entry → `_appendEntry`。生产没有泛型 `appendEntry`,而是一组**带类型的公开方法**:`appendMessage`(:951)、`appendThinkingLevelChange`(:964)、`appendModelChange`(:977)、`appendCompaction`(:991)、`appendCustomEntry`(:1014)、`appendSessionInfo`(:1028)、`appendCustomMessageEntry`(:1063)、`appendLabelChange`(:1124)。它们内部都收敛到私有 `_appendEntry`(session-manager.ts:938):

```ts
private _appendEntry(entry: SessionEntry): void {
	this.fileEntries.push(entry);   // 内存全量
	this.byId.set(entry.id, entry); // 反向索引
	this.leafId = entry.id;         // 移动叶子指针
	this._persist(entry);           // 落盘(§六,带 flush 策略)
}
```

追加**不修改 e2**——只是创建 e3 时让它的 `parentId` 指向 e2。e2 完全不知道自己多了个孩子。另外注意 `appendMessage` 的注释(`session-manager.ts:945-949`):它**不允许直接写 CompactionSummaryMessage / BranchSummaryMessage**——这两类必须是**顶层 entry** 以便检索,要走 `appendCompaction()` 和 `branchWithSummary()`。

### 操作 2:回退——只移动 leafId

```ts
branch(branchFromId: string): void {            // :1244
	if (!this.byId.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
	this.leafId = branchFromId;                 // 核心就这一行
}
```

没有删除任何人——被回退的分支还在 `byId`,还在 `.jsonl` 里。回退只是说"以后追加时 parentId 指向谁"。另有 `resetLeaf()`(:1256)把指针置 null(重新编辑第一条 user 消息)。

### 操作 3:分支——回退后追加的自然结果

回退到 e2 再追加 e6,e6 的 parentId 自动就是 e2。分支不是独立 API,是"回退 + 追加"的组合。

### 分支摘要 `BranchSummaryEntry`——回退的可选项

回到 Step 6。从 e5 回退到 e2,旧分支(e3-e5)成了"被抛弃的分支"。数据完整保留,但当前路径的 Agent 看不到它们。有时你希望新分支的 Agent**大概知道**之前试过什么,不必看完整对话。生产用两段式(branch-summarization 负责"生成",SessionManager 负责"存储"):

```ts
// ① 生成:在 agent-session 层,把被抛弃分支喂给 LLM(05 §七 的 generateBranchSummary,5-section)
const result = await generateBranchSummary(entries, { /* model, apiKey, ... */ });   // agent-session.ts:2811

// ② 存储:把摘要写进 SessionManager —— summary 是生成好的入参,SessionManager 不调 LLM
sessionManager.branchWithSummary(fromId, result.summary, { readFiles, modifiedFiles }); // :2866
```

`branchWithSummary(branchFromId: string | null, summary: string, details?, fromHook?)`(session-manager.ts:1265)的内部:

```ts
branchWithSummary(branchFromId, summary, details?, fromHook?): string {
	if (branchFromId !== null && !this.byId.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
	this.leafId = branchFromId;                 // 先回退
	const entry = { type: "branch_summary", id: generateId(this.byId),
		parentId: branchFromId,                  // 挂在分支点下,与旧分支同父
		fromId: branchFromId ?? "root", summary, details, fromHook };
	this._appendEntry(entry);                   // 追加一个 BranchSummaryEntry
	return entry.id;
}
```

挂上后树变成:

```
e2 (user)
 ├── e3 (assistant: read auth.ts)
 │    └── e4 (toolResult)
 │         └── e5 (assistant: "问题在 23 行")      ← 完整数据仍在,不进当前上下文
 │
 ├── e_bs (BranchSummaryEntry: "之前试过 read auth.ts,发现 salt 编码问题但未解决根因")
 │
 └── e6 (user: "先看 hash 函数") ...
```

`BranchSummaryEntry` 是回退时**可选**的。它是被弃分支的"遗言",不是真实对话;`buildSessionContext` 遇到它生成 `BranchSummaryMessage`(`createBranchSummaryMessage`,`session-manager.ts:397`),再由 03 的 `convertToLlm` 包成 `<summary>` user 消息。所以新分支的 Agent 看到"之前试过 X、结论是 Y",既知道历史、又不被旧分支细节淹没。不需要就只 `branch()`。

---

## 五、从树到 LLM 上下文：buildSessionContext

树长好了,但 LLM 不认识树——它的 API 只收线性 `messages` 数组。所以每次调用 LLM 前要把树"压扁"成数组,这就是 `buildSessionContext`(`session-manager.ts:325`)。

> 两个形态并存:纯函数 `buildSessionContext(entries, leafId?, byId?)`(:325,教学仓已按此落地)与 `SessionManager.buildSessionContext()` 方法(:1168,后者只是把内存里的 entries/leafId/byId 传给前者)。下面讲的是纯函数内部逻辑。

### 5.1 路径遍历——从 leaf 往回走到 root

当前 leaf 是 e9。先从 e9 沿 parentId 上溯到根,收集路径,再 reverse 成 root-first:

```ts
const path: SessionEntry[] = [];
let current = byId.get(leafId);              // e9
while (current) { path.push(current); current = current.parentId ? byId.get(current.parentId) : undefined; }
path.reverse();
// path = [e1, e2, e6, e7, e8, e9]
```

注意 **e3、e4、e5 不在 path 里**——它们不在当前分支上。"当前路径"只看 leaf 到 root 一条线;其他分支的数据不会发给 LLM。

### 5.2 按类型分派处理

path 上每个 entry 按类型处理:

```
e1 (model_change)  → 更新状态变量 model,不进 messages
e2 (user)          → 推入 messages
e6 (user)          → 推入 messages
e7 (assistant+toolCall) → 推入 messages
e8 (toolResult)    → 推入 messages
e9 (assistant)     → 推入 messages
```

> 注意 e2、e6 都是 user,可能出现"连续两条 user"。多数 Provider 允许,个别要求合并——03 的 `convertToLlm` 层处理这一点(见 03 文档)。

### 5.3 状态变量:覆盖式提取

`model` / `thinkingLevel` 不进 messages,但影响"用什么参数调 LLM"。提取方式是沿路径 root→leaf 覆盖式:遇到变更就覆盖,最后一次生效。`model` 初始值 `null`(`session-manager.ts:367`);若路径上没有 `model_change`(比如,"切换模型"发生在被回退掉的分支里),返回 `model: null`,由调用方(agent-session runtime)兜底回 session 启动时的配置。

这就是**"把切换模型也存成节点而不是全局状态"**的收益:`ModelChangeEntry` 完整记录"什么时候切的、在哪个位置切的",回退到切换之前的路径,`model` 自动回到切之前的值——**节点化的状态让回退天然正确**。

### 5.4 CompactionEntry 的特殊处理:选择性收集

05 说"压缩结果替换旧消息",具体替换就在这一步。假设路径上有压缩节点:

```
e1 (user)          ← 压缩区
e2 (assistant)     ← 压缩区
e3 (assistant)     ← 保留区第一条(firstKeptEntryId = "e3")
e4 (compaction)    ← 压缩节点
e5 (user)          ← 压缩后的近期消息
e6 (assistant)
```

`buildSessionContext` 遍历到 compaction 时(`session-manager.ts:401-424`):

1. 先 push 一条 `CompactionSummaryMessage`(`createCompactionSummaryMessage`,:403,来自 e4 的 `summary`/`tokensBefore`);
2. 在 e4 之前,只收集 `firstKeptEntryId`(e3)**及其之后**的——`foundFirstKept` 标志位(:409-418),e1/e2 被"跳过";
3. e4 之后的所有 entry 正常收集。

最终 `messages` = `[CompactionSummaryMessage, e3, e5, e6]`。这不是真删 e1/e2(append-only 不允许删),而是**遍历时按 firstKeptEntryId 跳过**。若回退到 e4 之前的位置,路径不含 e4,e1-e3 又作为正常消息出现——压缩是"当前路径上的视图",不是破坏性改写。`firstKeptEntryId` 是压缩发生时代理侧算好的(05 §六的"找切割点"就是在定它)。

---

## 六、JSONL 持久化的具体细节

### 6.1 格式:一行一个 Entry

那个会话落盘后(展开第一行 + 每一行简化):

```jsonl
{"type":"session","version":3,"id":"<uuidv7>","cwd":"/project","timestamp":"2026-07-03T10:00:00Z"}
{"type":"model_change","id":"e1","parentId":null,"provider":"anthropic","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"e2","parentId":"e1","message":{"role":"user","content":[{"type":"text","text":"auth.ts 里 salt 验证为什么失败?"}]},"timestamp":"..."}
{"type":"message","id":"e3","parentId":"e2","message":{"role":"assistant","content":[{"type":"text","text":"让我读一下 auth.ts"},{"type":"toolCall","id":"call_001","name":"read","arguments":{"path":"src/auth.ts"}}],"stopReason":"toolUse"},"timestamp":"..."}
{"type":"message","id":"e6","parentId":"e2","message":{"role":"user","content":[{"type":"text","text":"先看 hash 函数的实现"}]},"timestamp":"..."}
```

- 第一行 Session Header(`type:"session"`,`version: 3` = `CURRENT_SESSION_VERSION`,`session-manager.ts:30`、header 构造在 `newSession()` :831-838):记录 cwd、版本等元信息。
- 每行一个 Entry。`e6` 的 `parentId` 是 `e2`——`grep '"parentId":"e2"'` 就能在文件里找到所有从 e2 长出来的子节点,分支在文件里可读可查。
- 文件名 `${fileTimestamp}_${sessionId}.jsonl`,其中 fileTimestamp 是 timestamp 的 `:`/`.` 换成 `-`(:847):天然按时间排序、不会覆盖。
- **为什么 JSONL 而不是单个 JSON?** JSONL 是行级追加——新 entry `appendFileSync` 到末尾即可,不用"读入-修改-重写"整文件。这和 append-only 树完美契合:树只追加,文件也只追加。

### 6.2 id 生成

- **会话 id**:`uuidv7()`(createSessionId,:203),有合法性校验 `assertValidSessionId`(:207)。
- **entry id**:`randomUUID().slice(0, 8)`——8 位十六进制(如 `a1b2c3d4`),对 `byId` 查重 100 次,冲突就回退完整 UUID(`generateId`,:216)。会话内 8 位冲突概率足够低,还省空间。

### 6.3 延迟写入:避免"有问无答"的半截对话

落盘的真正入口是 `_persist`(`session-manager.ts:909-936`),它带一套"等到有 assistant 再写"的策略。规则按两个布尔分四种情况:

| 已有 assistant? | 已 flushed? | 行为 |
|---|---|---|
| 没有 | 已 flushed | 立即 append 当前 entry(:915) |
| 没有 | 未 flushed | **不写盘**,标记未 flushed,等 assistant(:918) |
| 有 | 未 flushed | **整文件重写**(`openSync(file,"wx")` + 逐个 `writeFileSync`,`:923-932`),置已 flushed |
| 有 | 已 flushed | 立即 append(:934) |

动机:避免"有问无答"的半截对话——用户问了一句但 Agent 没回(断网/API 报错)。如果每条 user 消息都立刻写盘,下次打开会话就看到一条孤零零的 user 悬着。延迟到首个 assistant 到达再批量落盘,保证**至少有一对完整的 user-assistant 往返**。之后一切 append,首次 flush 后机制不再起作用。

### 6.4 偶尔的全文件重写

日常追加走 `appendFileSync`,但三种情况会全文件重写(`_rewriteFile`,`session-manager.ts:873`——`openSync("w")` + 逐条 `writeFileSync`):

1. **加载到空/损坏文件**:文件没有合法 header 时重建并重写(:800-806);
2. **版本迁移**:v1→v2→v3 的 entry 结构迁移后重写(:812-813,迁移函数 `migrateSessionEntries`:289);
3. **首次 assistant flush** 的"补齐式整写"(上表第三种)。

另有一个**新建文件**的重写变体 `createBranchedSession(leafId)`(:1289):把从 root 到指定叶子的路径克隆成一个**新会话文件**(过滤 label 并重新链 父链,便于拿去独立复用)。以上都不破坏 append-only——重写产生的是新文件/新格式,原历史完整保留在重写后的内容里。

---

## 七、两层实现:接口允许换数据库

呼应 §一"存在哪里"的选择,Session Tree 有两层独立实现。它们**各自定义类型、各自实现持久化,并不互相继承**:

| | agent-core(`packages/agent/src/harness`) | coding-agent(`packages/coding-agent/src/core`) |
|---|---|---|
| API 风格 | **异步**(全部 `Promise`) | **同步**(方法直接返回) |
| Entry 类型 | `SessionTreeEntry` **11 种**(含 active_tools_change、leaf,:409) | `SessionEntry` **9 种**(:140) |
| 叶子指针 | **落盘为 `LeafEntry`** | 内存字段 `this.leafId` |
| 存储 | `SessionStorage` 接口(:440,可插拔)+ 两个实现 | 独立实现,直接同步操作 JSONL(`_persist`/`_rewriteFile`) |
| 用途 | 通用框架层(可换 mysql 等) | 编码 Agent 产品层 |

**agent-core 的 `SessionStorage` 接口**(`harness/types.ts:440`)共 10 个方法:`getMetadata` / `getLeafId` / `setLeafId` / `createEntryId` / `appendEntry` / `getEntry` / `findEntries(type)` / `getLabel` / `getPathToRoot(leafId)` / `getEntries`。参考实现:

- `JsonlSessionStorage`(jsonl-storage.ts:161,文件):实现这套接口,内部按 `version:3` 的 header + 逐行 entry 读写,并**把叶子指针也作为 `leaf` 类型 entry 落盘**;
- `InMemorySessionStorage`(memory-storage.ts:40,内存,测试用)。

**coding-agent 的 `SessionManager`**(session-manager.ts:758)没有实现这套接口——它 import agent-core 的只有 `AgentMessage` 和 `uuidv7`,`SessionEntry` 自行定义,JSONL 用 node `fs` 同步读写。它的公开 API 就是 §四那组 `appendXXX` + `branch`/`branchWithSummary`/`resetLeaf` + 查询(`getBranch`/`getEntries`/`getTree`/`getLeafId`) + 会话生命周期(`newSession`/`setSessionFile`/`createBranchedSession`)。

这两种安排的含义:(1) 想做 Web 版 Pi,可以自己用 mysql 实现 `SessionStorage`,agent-core 其余逻辑不动;(2) 但**不能**拿 coding-agent 的 `SessionManager` 去套 agent-core 的接口——签名不兼容。这就是"接口存在但不强制复用"的落地路径:**各自实现**,而非统一继承。

### 对照本教学仓(coding-agent 实现进度,2026-09)

| 组件 | 本仓库(coding-agent) | 生产(coding-agent) |
|---|---|---|
| `SessionEntry` 9 种类型 + `buildSessionContext` 纯函数 | ✅ 已落地(`session-manager.ts`) | 同构 |
| `branch-summarization.ts`(collect/prepare/generate) | ✅ 已落地(05 §七) | 同构 |
| `SessionManager` 类 + `_persist`/`_rewriteFile` + `appendXXX`/`branch`/`branchWithSummary` + JSONL 加载/迁移 | ✅ 已落地(Tier 2/3) | 完整 |
| 单测 `test/session-manager.test.ts` | ⏳ 未创建(Tier 2/3 的验证清单尚未落测) | — |
| `getSessionName` / `getLatestCompactionEntry` | ⏳ 缺(生产 `session-manager.ts:1042` / `:311`) | 有 |
| `Agent`(`packages/agent`)+ `AgentSession`(`core`) | ⏳ **骨架**(Tier 4 Phase 0/1;`Agent.prompt` 未接 `runAgentLoop`) | 完整 |
| harness `SessionStorage` + `JsonlSessionStorage`/`InMemorySessionStorage` | ⏳ 未落地(agent-core 通用会话层,与本仓库无关) | 完整 |

✅ **命名对齐已完成**:教学曾用纯函数 `getBranchPath`/`getEntryById`(自造名),现已删除;改用生产 `ReadonlySessionManager`(`session-manager.ts:186` = `Pick<SessionManager,… "getBranch" | "getEntry" …>`,方法实现 `:1152`/`:1095`,语义:含自己、root-first)。`collectEntriesForBranchSummary` 直接吃真实 `SessionManager`。

也就是说:**会话层(Tier 1-3)在本仓库已可运行**;agent 侧集成(Tier 4)是骨架,待 Phase 2 起填实。

---

## 八、总结

### 一条主线:会话存储的两个独立维度

| 维度 | 回答什么 | 一般做法 | Pi 的选择 |
|---|---|---|---|
| 存储介质 | 存哪里? | mysql 等数据库 | 本地 JSONL(接口允许换) |
| 数据结构 | 长什么样? | 线性数组 | 树(Session Tree) |

下次设计任何"历史持久化",先分别回答这两个问题,再组合方案——**别把它们粘成一团**("用了数据库就必须线性数组"是错觉)。

### Session Tree 的本质:用树形 + append-only 实现"不丢数据的回退"

- 为什么树?因为对话不线性——会回退、重试、分支。
- 为什么 append-only?删了找不回,历史分支可能有价值。
- 为什么认父不认子?append-only 要求节点不可变,父节点不能维护 children 列表;反向索引靠 `byId` 表。
- 为什么路径遍历?LLM 只认线性 `messages`;树形数据必须"压扁",压缩/分支摘要都在这个出口做"视图变换"。

这一连串选择是连贯的,每个都回应上一个带来的约束,最终自洽。

### 三个可迁移的思路

1. **拆开"存哪里"和"长什么样"两个维度**,各自独立决策再组合。
2. **append-only + 指针定位(leafId)做撤销/回退/分支**:不删旧数据,垫付的存储成本换来"历史无价"。
3. **节点化状态变量,让回退天然正确**:把"切模型/调思考级别"存成节点而非全局状态,回退时状态沿路径自动还原。

---

## 九、实施步骤(分 Tier):把会话层一步步"长"出来

> 参照 05 §十 的格式:每步 = **目标(生产 file:line)+ 教学落地文件 + 实现要点 + 验证**。生产全部集中在 `packages/coding-agent/src/core/session-manager.ts`(1578 行,本章行号一律指它)与 `agent/src/harness`。**命名严禁自造**,照抄生产。
> 教学仓现状:纯函数层(Tier 1)✅;**SessionManager 类、JSONL 落盘、agent 集成都还没做**(⏳)——本指南就是做这些的路线图。

### Tier 1:会话类型 + 纯函数层(✅ 已落地,复核清单)

> 已在教学仓 `packages/coding-agent/src/core/session-manager.ts` 落地,与生产纯函数部分同构。这里列出来是当"验收清单":实现 Tier 2 之前,这几块必须干净。

1. **9 种 `SessionEntry` 类型 + `SessionContext`**(生产 :46-186)。教学落地 ✅(`SessionEntryBase`/`SessionEntry` 联合 9 种,`buildSessionContext` 返回 `{messages, thinkingLevel, model}`)。**验证**:已随 compaction.test.ts 端到端覆盖;应补一条"9 种类型结构完整性"单测(每个 type 标签 + 必填字段齐备)。
2. **纯函数 `buildSessionContext(entries, leafId?, byId?)`**(生产 :325):路径遍历(parentId 上溯 → reverse)→ 按类型分派 → 状态覆盖式提取(`model` 初值 null,:367;`thinkingLevel` 默认 "off")→ compaction 选择性收集(:401-424,`firstKeptEntryId` 前跳过)。教学落地 ✅。**验证**:compaction.test.ts 已有端到端;建议补一份**纯分派遣型表**单测——9 种 entry 各放一条,断言各自的去处(进 messages / 改状态 / 跳过)。
3. **最小会话视图**:对齐生产 `ReadonlySessionManager`(`session-manager.ts:186` = `Pick<SessionManager,… "getBranch" | "getEntry" …>`)——方法名就是 **`getBranch`/`getEntry`**(方法实现 `:1152`/`:1095`;语义:含自己、root-first);`collectEntriesForBranchSummary` 吃这个视图。✅ 教学已落地该类型并从 `session-manager.ts` 导出;自造名 `getBranchPath`/`getEntryById` 已删除。**验证**:compaction.test.ts ④ 的 LCA 采集(测试里组装最小只读视图)。

### Tier 2:SessionManager 类与内存树(✅ 已完成,2026-09 复核)

> 落地文件:`packages/coding-agent/src/core/session-manager.ts`(追加,生产就是同文件)。类初始化所需状态:`sessionId/sessionFile/sessionDir/cwd/persist/flushed/fileEntries/byId/labelsById/labelTimestampsById/leafId`(:758-769)。

**阶段 A 骨架与核心追加(先让"内存里的树"可长可查,不碰磁盘)**

1. **构造 + `newSession()` + `setSessionFile()`**(生产 :771-850)。
   - `newSession(options?)`:校验 id(`assertValidSessionId`)、造 `SessionHeader{type:"session",version:3,id,timestamp,cwd,parentSession}`(:831-838)、清 `fileEntries=[header]`/`byId`/`leafId=null`/`flushed=false`;`persist` 时生成 `fileTimestamp_sessionId.jsonl` 文件名(:846-847)。
   - `setSessionFile()`(:793):有文件 `loadEntriesFromFile` → 空/损坏就重建重写(:800-806)→ 迁版本迁移重写(:812-813)→ `_buildIndex()` → `flushed=true`。
   - **验证**(单测,`test/session-manager.test.ts` ⏳ **尚未创建**):`newSession()` 后 `leafId=null`、header 版本=3;`setSessionFile` 指向不存在路径时重建 header。
2. **`_buildIndex()`**(生产 :852):清空索引后遍历 `fileEntries`,跳过 header,`byId.set` + 最后一条当 `leafId`,label 进 `labelsById`。**验证**:加载一段线性链 → leafId=最后一条、`getEntry` 全部可查。
3. **`_appendEntry(entry)`**(生产 :938):`fileEntries.push + byId.set + leafId=entry.id + _persist(entry)`——**这是所有 appendXXX 的唯一收敛点**。**验证**(配合 Tier 3 前先传 `persist:false` 只测内存):append 一条 → leafId 前移、`getEntries()` 长度 +1、旧节点未被改动(append-only 断言)。

**阶段 B 写入 API(`appendXXX` 组,平铺生产同名方法)**

4. **`appendMessage(message)`**(生产 :951):`Message | CustomMessage | BashExecutionMessage` 入参,**内部** `generateId` + `leafId` 当 parentId + 组装 `SessionMessageEntry`;**不允许直接塞 CompactionSummary/BranchSummary 消息**(:945-949 注释:它们要是顶层 entry,走 appendCompaction/branchWithSummary)。
5. **`appendThinkingLevelChange(thinkingLevel)`**(:964)/**`appendModelChange(provider, modelId)`**(:977):payload 字段照抄生产(`provider`+`modelId`,不是 `model`)。
6. **`appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?)`**(:991):05 压缩结果落库的唯一入口。**验证**:append 后 `getBranch()` 的路径能走 `buildSessionContext` 出 `[CompactionSummaryMessage, ...kept]`。
7. **`appendCustomEntry`/`appendSessionInfo`/`appendCustomMessageEntry`**(:1014/:1028/:1063):扩展数据 / 显示名(须先 `sanitizedName` 过滤换行,:1029)/ 注入 LLM 上下文的自定义消息。
8. **`appendLabelChange(targetId, label)`**(:1124):`label` 为 undefined/空 = 清除;联动更新 `labelsById`/`labelTimestampsById`(:1137-1143)。**验证**:打标 → `getLabel` 取到;清标 → 删除。

**阶段 C 查询与遍历**

9. **基础查询**:`getLeafId`/`getLeafEntry`/`getEntry`/`getChildren`/`getLabel`(:1087-1117)。`getChildren` 是"认父不认子"的反向查询——遍历 `byId.values()` 找 parentId 匹配,**不落盘、不缓存**。⚠️ 另缺 **`getSessionName`**(生产 `:1042`),须补。
10. **`getBranch(fromId?)`**(:1152):从 leaf(或指定 id)沿 parentId 上溯到根,`reverse` 成 root-first,含全部类型。**验证**:建两分支树,`getBranch("e9")` 返回 [e1,e2,e6,e7,e8,e9],不含被弃分支。
11. **`getTree()`**(:1194):把 `fileEntries` 排成 `SessionTreeNode[]`,孤儿当根、children 按 timestamp 排序(迭代式,防深树爆栈)。**验证**:两分支 → 两个 root 子树,children 有序。
12. **`buildSessionContext()` 方法**(:1168):一行委托纯函数(§五)。**验证**:与 Tier 1 纯函数结果一致。

**阶段 D 分支与克隆**

13. **`branch(branchFromId)`**(:1244):存在性校验后 `leafId=branchFromId`——回退就是这一行。**`resetLeaf()`**(:1256):指针置 null,下一次 append 产生新根(`parentId=null`,重编首条 user)。
14. **`branchWithSummary(branchFromId, summary, details?, fromHook?)`**(:1265):先 `leafId=branchFromId`,再 append 一条 `BranchSummaryEntry{parentId:分支点, fromId, summary, details, fromHook}`——**summary 是入参,SessionManager 不调 LLM**;生成在 agent-session(:2811 `generateBranchSummary` → :2866 调它)。**验证**(端到端):collect→generate→branchWithSummary→buildSessionContext 见 `<summary>` 包裹的 branchSummary user(05 §十 Tier-3 已有同款,套到类上)。
15. **`createBranchedSession(leafId)`**(:1289):克隆"root→leaf"到**新文件**,过滤 label 并重链 parentId(:1296-1305)。**验证**:克隆后新文件路径不含被弃分支,仅当前路径。

### Tier 3:JSONL 落盘(✅ 已完成,2026-09 复核)

> 教学仓测试写法参考现有 `test/tools/write.test.ts`:用 `mkdtemp` 临时目录 + 注入 workspace。SessionManager 落盘用 node fs,单测就指向临时目录,跑完 `rm`。

1. **会话目录与文件名**(生产 :439 / :846-847):`getDefaultSessionDirPath(cwd)` = `~/.pi/agent/sessions/--{cwd 编码}--`;文件名 `${timestamp 的:/:. 换 -}_${sessionId}.jsonl`。**验证**:`getDefaultSessionDir` 会自建目录(`mkdirSync recursive`)。
2. **id 生成三件套**:`createSessionId()` = `uuidv7()`(:203);`assertValidSessionId` 正则(:207);`generateId(byId)` = `randomUUID().slice(0,8)`,查重 100 次、冲突回退完整 UUID(:216)。**验证**:连续生成不冲突、合法字符。
3. **`_persist(entry)` 延迟写入**(:909-936)——**教学重点**。四情况表(§6.3):无 assistant+已 flushed → append;无+未 → 不写等 assistant;有+未 → `openSync("wx")` 整写 + `flushed=true`;有+已 → append。**验证**:`persist:true` 指向临时文件——先 append 两条 user(不写盘,文件仅 header),再 append 一条 assistant → 文件一次补全 header+3 条;中途"无 assistant 关掉"→ 文件只有 header。
4. **`_rewriteFile()`**(:873)+ 触发点:空/损坏重建(:800)、版本迁移(:812)。**验证**:改坏第一行 → `setSessionFile` 重建 header。
5. **加载与迁移**:`loadEntriesFromFile`(:467)/`parseSessionEntries`(:294)/`migrateSessionEntries`(:289,v1→v2→v3)。**验证**:v1 无 id/parentId 的旧文件 → 迁移后补齐树结构、`firstKeptEntryIndex` 换 `firstKeptEntryId`(:240-250)。

### Tier 4:agent 侧集成(骨架 Phase 0/1 ✅,Phase 2-6 ⏳,代码逻辑见 4.3;生产 `agent-session.ts` / `packages/agent/src/agent.ts`,2026-09 重构)

> 目标:**把已有的 compaction / SessionManager / emit / convertToLlm 五件套,用生产 `AgentSession` 类收编成一个完整闭环——能跑、能压缩、能跨轮恢复。** 所有 public / private 方法**严格对齐生产命名与行号**,不发明名字。
>
> ✅ 现状(2026-09):`agent-session.ts` 教学骨架已落盘(类型/字段/生命周期/持久化已实写,余为桩);协作者(Agent/SettingsManager/ModelRegistry)+ pi-ai compat 桩就位,typecheck 绿。**`Agent` 当前是骨架桩**(`prompt` 仅 `state.messages.push`,未接 `runAgentLoop`)——Phase 2 把它填实即"能跑"。
> ⚠️ 纪律:本小节描述"要实现的确切代码逻辑",**本轮只落骨架/注释/桩,不写生逻辑**;落成时逐 Phase 按生产锚点照抄。

#### 4.1 生产 API 面概述(`packages/coding-agent/src/core/agent-session.ts`,3159 行;教学骨架已按此表落盘)

| 分组 | public / private 方法(生产行号) |
|---|---|
| 发消息 | `sendUserMessage(:1354)` → `prompt(:997)` → `_runAgentPrompt(:947)` → `_handlePostAgentRun(:958)`;流式旁路 `steer(:1218)`/`followUp(:1238)` |
| 订阅/生命周期 | `subscribe(:691)`/`dispose(:728)`/`reload`;`_emit(:469)`/`_handleAgentEvent(:487)`:`_{disconnect,reconnect}ToAgent(:708/:719)` |
| 模型/思考 | `cycleModel`/`setModel`/`cycleThinkingLevel`/`setThinkingLevel`/`_clampThinkingLevel`/`supportsThinking`/`setScopedModels` + getters(`model`/`thinkingLevel`/`isStreaming`/`systemPrompt`/`messages` 等) |
| 压缩 | `compact(customInstructions?)(:1652 手动)`/`_checkCompaction(:1816)`/`_runAutoCompaction(:1910)`/`setAutoCompactionEnabled`/`abortCompaction`/`isCompacting`/`getContextUsage` |
| 重试 | `_prepareRetry`/`_isRetryableError`/`_isNonRetryableProviderLimitError`/`_willRetryAfterAgentEnd(:560)`/`abortRetry`/`setAutoRetryEnabled`/`retryAttempt` |
| 分支导航 | `navigateTree(targetId,{summarize?})(:2724)`/`abortBranchSummary`/`getUserMessagesForForking`/`createReplacedSessionContext` |
| 队列 | `clearQueue`/`getSteeringMessages`/`getFollowUpMessages`/`setSteeringMode`/`setFollowUpMode`/`_emitQueueUpdate(:475)` |
| 工具/系统提示 | `_buildRuntime`/`_rebuildSystemPrompt(:907)`/`_refreshToolRegistry`/`setActiveToolsByName`/`getAllTools`/`getToolDefinition`/`_installAgentToolHooks(:414)` |
| 会话 | `setSessionName`/`getSessionStats` + `sessionFile`/`sessionId`/`sessionName` |
| 外围(子系统) | `executeBash`/`abortBash`/`recordBashResult`、`bindExtensions` 全家、`exportToHtml`/`exportToJsonl` |

#### 4.2 协作者边界与现状(✅ 骨架/桩,Phase 2+ 填实)

生产 `constructor(agent-session.ts:334)` 要求 4 个协作者。教学仓:`SessionManager` ✅ 就绪(Tier 2/3);其余 **Phase-0 骨架已落盘**(方法名对齐生产,体为 TODO 桩):

1. ✅ **`packages/agent/src/agent.ts` — `class Agent`**(从 `pi-agent-core` 导入):目前只有 `subscribe`/`prompt`(stub)/`continue`(stub)/`hasQueuedMessages`(stub)/`state.messages`/`model`/`streamFn`/`isStreaming`/`beforeToolCall`/`afterToolCall`;**生产完整接口面(`PendingMessageQueue`、steer/followUp 队列、waitForIdle/signal/abort/reset、runPromptMessages/runContinuation/runWithLifecycle)待 Phase 2 加桩 + 实装**(4.4 管线给出对接点)。
2. ✅ **`settings-manager.ts`**:`getCompactionSettings()`(默认 `DEFAULT_COMPACTION_SETTINGS`)/`getRetrySettings()`;写口留 TODO。
3. ✅ **`model-registry.ts`**:`getApiKeyAndHeaders(model)`/`isUsingOAuth(model)`;env 取 key 留 TODO。

跨包依赖 ✅ 已对齐:原 `packages/ai/src/compat.ts` 桩(自造模块名 + 自造类型 `CompatThinkingLevel`)已删除,按生产拆到各自的家——`ai/src/types.ts` 新增 `ThinkingLevel`/`ModelThinkingLevel`/`ThinkingLevelMap`(生产 :74-76)+ `Model.thinkingLevelMap`;**`ai/src/models.ts` 新建**,落 `getSupportedThinkingLevels`/`clampThinkingLevel`/`modelsAreEqual`(生产 models.ts:399/410/435,model-aware 泛型签名);**`ai/src/utils/overflow.ts` 新建**,落 `isContextOverflow`(生产 :126)。测试 `packages/ai/test/models.test.ts` 8 例。`ResourceLoader`/`ExtensionRunner` 缺席 → `_emitExtensionEvent` 空、`_installAgentToolHooks` 空钩子。

#### 4.3 逐 Phase 实施细节(每步:目标 / 要实现的代码逻辑 / 验证)

**Phase 1 — agent-session.ts 骨架(✅ 已落盘,补单测即可)**
- 目标:AgentSession 类型/字段/生命周期在,listener 能收到转发事件。
- 已写:事件联合(:125-149)/config/PromptOptions;全字段(:270-332+`_lastAssistantMessage`:484);`constructor`(:334,内部 `agent.subscribe(_handleAgentEvent)`);`subscribe`/`dispose`/`_emit`/`_emitQueueUpdate`/`_{disconnect,reconnect}ToAgent`;`_handleAgentEvent`(message_end 持久化**已实写**)、prompt 族/压缩/分支/getter 桩(注释钉生产行号)。
- 待做:**补单测**——构造成功、`subscribe` 收 `_emit` 转发、`_handleAgentEvent` 对 message_end 持久化到 SessionManager。

**Phase 2 — 每轮闭环「能跑」(⏳,核心缺口)**
- 目标:Agent.prompt 真接 `runAgentLoop`,`sendUserMessage("...")` 能跑完整一轮;树、事件、状态三方同步。
- 要实现的代码逻辑(全部在 `packages/agent/src/agent.ts`,方法名照生产 `packages/agent/src/agent.ts:166-557`):
  1. **`PendingMessageQueue`**(生产 `agent.ts:118-153`):字段 `public mode: QueueMode` + `constructor(mode)` + `enqueue`/`hasItems`/`drain`/`clear`——**`drain()` 是模式感知的**(`"all"` 全取;`"one-at-a-time"` 只取最旧一条,其余留队);`Agent` 上建 `steeringQueue`/`followUpQueue` 两个实例,mode 取自 `AgentOptions.steeringMode`/`followUpMode`(:110-111);
  2. **`steer`/`followUp`/`clear{Steering,FollowUp,All}Queues`/`hasQueuedMessages`**(:264-292)——置入选区/排队,`hasQueuedMessages` 供 `_handlePostAgentRun` 判断续跑;
  3. **`prompt`**(:325):guard `activeRun` → `normalizePromptInput`(:367)→ `runPromptMessages`;
  4. **`continue`**(:338):guard → 末条 assistant 时先 drain steering→followUp 各跑一轮,否则 `runContinuation`;
  5. **`runPromptMessages`**(:386)/**`runContinuation`**(:402):`runWithLifecycle(() => runAgentLoop(messages, createContextSnapshot(), createLoopConfig(), e⇒processEvents(e,signal), signal, streamFn))`;`newMessages` 并入 `state.messages`。⚠️ `runContinuation` 须调生产 **`runAgentLoopContinue`**(`agent-loop.ts:120`,`(context, config, emit, signal?, streamFn?)`;守卫:无消息/末条 assistant → throw)——教学 `agent-loop.ts` 现只导出 `agentLoop`/`runAgentLoop`,**须补该同名函数**(不得用自造等价);
  6. **`createContextSnapshot`**(:414):`systemPrompt + messages.slice() + tools.slice()`(快照副本,防 loop 在已合并数组上追加);
  7. **`createLoopConfig`**(:422):`model/convertToLlm/beforeToolCall/afterToolCall`,并装配队列两口 **`getSteeringMessages`/`getFollowUpMessages`**(生产 `agent.ts:440/447`),`skipInitialSteeringPoll` 走入口分支。⚠️ **`AgentLoopConfig` 队列字段须对齐生产改名**——教学现为自造的单口 `getQueuedMessages`(`packages/agent/src/types.ts:145`;用点 `agent-loop.ts:131/202`、`agent.ts:25/77`),须替换为 **`getSteeringMessages` + `getFollowUpMessages`**(`agent/src/types.ts:235/248`);
  8. **`runWithLifecycle`**(:451):guard activeRun、建 AbortController+promise、置 `isStreaming`,executor 跑 loop,finally `finishRun`;
  9. **`handleRunFailure`**(:476):loop 抛错时补 error/aborted assistant 消息并广播三角色事件;`finishRun`(:494)清流式态并 resolve;
  10. **`signal`/`abort`/`waitForIdle`**(:294-311)/**`reset`**(:314);`processEvents` await 每个 listener(`(event, signal)`)。
- 工程输入:构造 Agent 时**必须**喂 `convertToLlm`(03 的)、`systemPrompt`(05 `buildSystemPrompt`)、`model`、`streamFn`(mock;缺省会回落 `streamSimple` 真打 API)。
- 验证:发一段 user → `SessionManager` 树长出 user/assistant/toolResult;listener 依次收到 `message_start/end`、`turn_start/end`、工具诸事件、`agent_end`;`buildSessionContext` 压扁正确、`convertToLlm` 后 LLM 只见标准三角色。

**Phase 3 — 压缩「能压」(⏳,骨架已大半)**
- 目标:agent_end 后自动压;手动 `compact` 等效。
- 代码逻辑:`_checkCompaction(:1816)` **overflow + threshold 两条路径均已落地**——`getLatestCompactionEntry`(生产 session-manager.ts:311,防"刚压完被旧 usage 顶起"的边界)已落进 `session-manager.ts`;Case 1 overflow 走 `sameModel` + `isContextOverflow` + `_overflowRecoveryAttempted` 单次"压缩+重试"守卫(生产 :1823-1874);`_runAutoCompaction(:1910 已写,:1736-1739 三行生效)`、`compact(:1652 手动已写)`、`setAutoCompactionEnabled`/`abortCompaction`/`isCompacting`/`getContextUsage` 桩;`_getCompactionRequestAuth` 走 ModelRegistry 桩。
- 验证(闭合 05 端到端):塞超阈值上下文 → `agent_end` → 自动压 → 下一轮 `convertToLlm` 第一条是 `<summary>` user、树出现 compaction entry;`compact()` 手动等效。

**Phase 4 — 跨轮恢复「能恢复」(⏳,桩)**
- 代码逻辑:retry 家族——`_isRetryableError`/`_isNonRetryableProviderLimitError`/`_prepareRetry`(延迟+`agent.continue`)/`_willRetryAfterAgentEnd(:560)`/`abortRetry`/`setAutoRetryEnabled`/`retryAttempt`;`reload`(`sessionManager.setSessionFile`→`_buildIndex`→`buildSessionContext`);`setSessionName`/`getSessionStats`。
- 验证:落盘后 `new AgentSession` 同 sessionFile → 上下文恢复;压缩后不因旧 usage 二次触发。

**Phase 5 — 分支导航 / 模型思考(⏳)**
- 代码逻辑:`navigateTree`(骨架已写,含只读 view 垫片)+`abortBranchSummary`/`getUserMessagesForForking`;`setModel`/`cycleModel`/`setThinkingLevel`/`cycleThinkingLevel`/`supportsThinking`(生产 :1453/:1476/:1546/:1574/:1598)。
- 验证:两分支树 navigate → 新路径上下文带 `<summary>` 分支摘要;换模型后 `model_change` 节点上树。

**Phase 6 — 外围逐一对齐(⏳,依赖子系统)**
- `executeBash`/`recordBashResult`/`abortBash`(`bash-executor`)、`exportToHtml`/`exportToJsonl`(`export-html`)、`bindExtensions` + `ContextUsage`/`SessionStats`/`ReplacedSessionContext`/`BashResult` 占位删除改 import。逐个移植子系统后对齐,不混进 Phase 2-4。

#### 4.4 Agent(骨架)↔ AgentSession 整合联动管线(详细)

**装配(唯一对接点)**
```
driver: new Agent({ model, systemPrompt, convertToLlm, streamFn, tools })
      → new AgentSession({ agent, sessionManager, settingsManager, modelRegistry, cwd })
      → AgentSession.constructor 自动: this._unsubscribeAgent = agent.subscribe(this._handleAgentEvent)   # agent-session.ts:352
      → (可选) session.subscribe(listener)    # 管道A:UI/测试收 AgentSessionEvent(含 compaction_start/end)
```

**一轮「能跑」的消息级管线**
```
sendUserMessage("你好")                                        # :1354
 └→ prompt(text) → _runAgentPrompt([userMsg])                 # :997/:947
     └→ agent.prompt(userMsg)                                 # Agent 真入口(Phase 2 实装)
         └→ runAgentLoop(prompts, snapshot, cfg, e⇒processEvents(e,signal), signal, streamFn)
             ├─ agent_start / turn_start
             ├─ message_start/end(userMsg)  ─┐
             ├─ message_end(assistant 流式)  ├→ Agent.processEvents → await 每个 listener
             ├─ tool_execution_*             │       └─ AgentSession._handleAgentEvent(:487)
             ├─ message_start/end(toolResult)│            └─ message_end:按类型 appendMessage /
             └─ turn_end / agent_end(带 willRetry)          appendCustomMessageEntry → SessionManager 树
         └→ 返回 newMessages → agent.state.messages 并入              (生产持久化在 :517-534)
     └→ agent.prompt 结束后, while(await _handlePostAgentRun())   # :950/_handlePostAgentRun:958
         ├─ _isRetryableError? → _prepareRetry(续跑)              (Phase 4)
         ├─ _checkCompaction(最后 assistant) → _runAutoCompaction  (Phase 3)
         │    └→ appendCompaction(:1736) → buildSessionContext(:1738) → agent.state.messages=ctx(:1739)  ← 跨轮生效点
         └─ agent.continue()                                      (有排队队列才续)
```

**关键交互表(AgentSession 调 Agent 的真实面 ↔ 走教学 runAgentLoop 的什么)**
| AgentSession | Agent 提供 | 教学 loop 落点 |
|---|---|---|
| `sendUserMessage`/`prompt` | `prompt(input)` | `runAgentLoop(prompts, …)` 的 prompts |
| `_runAgentPrompt` 里的循环 `continue` | `continue()` | `steeringQueue`/`followUpQueue` drain → 下一轮 |
| `_handlePostAgentRun` | `hasQueuedMessages()` | 两队列 `hasItems()` |
| `_handleAgentEvent` 持久化 | `subscribe`/`processEvents` | loop 逐事件 `emit` → 摊给 listener |
| `_runAutoCompaction`/`compact` 覆盖上下文 | `state.messages`(直接赋值) | loop 外替换,下一轮 snapshot 即新上下文 |
| `_installAgentToolHooks`(:414) | `beforeToolCall`/`afterToolCall` | `createLoopConfig` 透传 |

**两个状态同步点(必须对齐)**
1. **事件落树**:每个 `message_end` → `_handleAgentEvent` → `sessionManager.appendMessage`(AgentSession 侧);
2. **轮末转录**:`runAgentLoop` 返回 `newMessages` → `agent.state.messages.push(...)`(Agent 侧);压缩后 `agent.state.messages = sessionContext.messages`(两处都对齐树里压缩节点后的路径)。

**时序要点**:压缩不在事件回调里做——`_handleAgentEvent` 对 agent_end 只广播;真正 `_checkCompaction` 是在 `agent.prompt` **返回之后**,由 `_runAgentPrompt` 的 `while(_handlePostAgentRun())` 判断,拿 `_lastAssistantMessage` 做判定;这就是"压缩在两轮之间、prompt 提交前"的精确位置。

#### 4.5 纪律与验收

- **不发明名字**:每步方法名 = 生产 `agent-session.ts` 或 `agent.ts` 原名 + 行号锚点;注释注明"教学版裁掉哪个子系统"。
- **本轮代码纪律**:只落骨架/注释/桩,不写生逻辑;每个 TODO 都标 Phase 与生产行号。
- 闭环验收(Phase 4 终态):**发消息能跑 → 超窗自动压 → 重启能续上**,三件事全由生产方法名串联。

### Tier 5(进阶,了解即可):harness 的 `SessionStorage` 抽象(与本教学仓无关)

生产 `packages/agent/src/harness` 是通用会话层(本仓没有):`SessionTreeEntry` 11 种(:409,多 `active_tools_change`/`leaf`)、`SessionStorage` 接口 10 个**异步**方法(types.ts:440)、`JsonlSessionStorage`(:161)实现文件存储、`InMemorySessionStorage`(:40)测试用。coding-agent 的 `SessionManager` **不实现**它(§七)。**不落地,仅作对照**——若未来做 Web 版/换数据库,在这一层开花即可。

---

## 附:与 `05-context-engineering.md` 的衔接

- **05 §六 ⑥结果生效**与 **05 §十 阶段 B-5/6(会话写入 + agent 集成)**:原来标"不在当前实现、顺延会话层"——本章的 `appendCompaction`(:991)、`_persist`(:909)、`buildSessionContext`(:325)就是那两节"将来做"的**完整生产形态**,可直接引用。
- **05 §七 分支摘要**的产物 `BranchSummaryMessage`,消费链在**本章 §四 branchWithSummary** + **§五 buildSessionContext**——算法在 05,存储/重建在本章。
- 教学仓当前把纯函数部分(entry 类型 + buildSessionContext + 分支摘要算法)已做齐,类与落盘留给会话层。