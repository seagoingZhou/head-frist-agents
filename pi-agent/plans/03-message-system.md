# 消息系统设计：内富外严的双层消息（AgentMessage → Message）

> 项目最终目标：实现生产版 pi agent。本方案为**消息系统**——两层消息 + `convertToLlm` 翻译边界 + 自定义消息类型扩展。
> 生产参考索引：`pi/packages/coding-agent/src/core/messages.ts`（声明合并 70-77 / 转换规则 82-195 / excludeFromContext 38-39）、`pi/packages/agent/src/agent-loop.ts:275-308`（transformContext → convertToLlm 管道）、`pi/packages/agent/src/types.ts:305-314`（CustomAgentMessages / AgentMessage）。

## 当前进度（2026-08-24）

- ✅ **核心机制已落地**：`coding-agent/src/core/messages.ts`（4 自定义消息 + 声明合并 + `convertToLlm` + `excludeFromContext` 过滤 + `bashExecutionToText` + 摘要包裹）；`agent/types.ts` 加 `transformContext?`；`agent-loop.ts` 接成「transformContext → convertToLlm」管道
- ✅ **验收测试已建**：`packages/agent/test/message-system.test.ts` 6 用例（翻译 / 过滤 / 摘要包裹 / 标准透传 / 声明合并 / 端到端）—— `npm run typecheck` exit 0、`npm test` 21/21
- ⏳ 待做：`coding-agent/src/index.ts` 导出 `core/messages`（让 `convertToLlm` 成为包入口可达 API）
- ⏳ 留后续：真实 Bash 工具、Compaction / BranchSummary 实际触发

---

## 一、背景与核心设计思想

消息系统只有两个「读者」，需求天然分裂：

| 读者 | 关心 | 数据形式 |
|---|---|---|
| **模型（LLM）** | 只要 3 种标准消息（User / Assistant / ToolResult）——LLM API 协议强制 | 字段精简 |
| **功能层（UI / 持久化 / 可见性）** | 需要丰富结构化字段 | 字段丰富 |

**核心设计（内富外严）**：Agent 内部用 `AgentMessage`（7 种：3 标准 + 4 自定义）自由表达；到 LLM 边界用 `convertToLlm` 一次性翻译成 `Message`（3 种标准）。翻译是**有损、单向、最后一刻**发生的——结构字段早在 UI 用完了，无所谓丢。

**本轮范围**：
- ✅ 建 `coding-agent/src/core/messages.ts`：4 种自定义消息 + 声明合并 + `convertToLlm` 默认转换器
- ✅ `agent-loop.ts`：加 `transformContext` 可选钩子（同层变换），改造 `streamAssistantResponse` 为「transformContext → convertToLlm」管道
- ✅ 测试：翻译规则、excludeFromContext 过滤、声明合并类型安全
- ⏳ 不做：真实 Bash 工具（仍是桩）、Compaction / BranchSummary 的实际触发（仅建类型与转换规则）

---

## 二、现状清点（我们已有 vs 待建）

| 位置 | 现状 | 待建 |
|---|---|---|
| `packages/ai/src/types.ts:59-84` | `UserMessage` / `AssistantMessage` / `ToolResultMessage` / `Message` 联合 **已具备**（第 1 层） | 无（ThinkingContent/ImageContent/signature 本轮不做，留补丁点） |
| `packages/agent/src/types.ts:39` | `CustomAgentMessages` **空接口**（扩展点已留） | 由 coding-agent 声明合并注入 |
| `packages/agent/src/types.ts:48` | `AgentMessage = Message \| CustomAgentMessages[keyof CustomAgentMessages]` **已具备** | 无 |
| `packages/agent/src/types.ts:120` | `convertToLlm` **必填**、无 `transformContext` | 改：`transformContext?` 新增；`convertToLlm` 改可选 + 默认 |
| `packages/agent/src/agent-loop.ts:617` | `const llmMessages = await config.convertToLlm(messages)`（无 transformContext） | 加 transformContext 前置步骤 |
| `packages/coding-agent/src/` | 无 messages 文件 | **新建 `core/messages.ts`**（本轮核心） |
| `packages/coding-agent/src/index.ts` | 导出 tools/core | 追加 `export * from "./core/messages"` |

**声明合并前提已满足**：coding-agent 已按包名 `import ... from "pi-agent-core"` / `"pi-ai"`（`tools/read.ts:3-4`），package `exports` 指向 `src/index.ts`，`CustomAgentMessages` 已从 core 导出 → `declare module "pi-agent-core"` 能正确定向增强。

---

## 三、目标结构（对齐生产，落到我们 repo）

```
packages/coding-agent/src/
  core/messages.ts              // ★ 新增：4 种自定义消息 + 声明合并 + convertToLlm
packages/agent/src/
  types.ts                      // ★ 改：AgentLoopConfig 加 transformContext?；convertToLlm 改可选+默认
  agent-loop.ts                 // ★ 改：streamAssistantResponse 管道加 transformContext
packages/agent/test/
  message-system.test.ts        // ★ 新增：翻译 + 过滤 + 声明合并测试
```

管道（每次 LLM 调用前）：

```
context.messages: AgentMessage[]      ← Agent 内部（7 种）
    │  [1] transformContext?（可选，同层）   AgentMessage[] → AgentMessage[]（裁剪/注入/压缩）
    ▼
    │  [2] convertToLlm（跨层翻译）          AgentMessage[] → Message[]
    ▼
llmContext.messages: Message[]        ← LLM 只看到 3 种标准
    │  （排除 excludeFromContext=true 的自定义消息）
    ▼
streamFunction(model, llmContext)     ← 调用 LLM
```

---

## 四、第一层：Message（`ai/types.ts`，已具备，不改）

`Message = UserMessage | AssistantMessage | ToolResultMessage`。

- `UserMessage`：`{ role:"user", content: TextContent[], timestamp }`（生产支持 `TextContent|ImageContent` 或字符串，我们保持 TextContent[] 够用）
- `AssistantMessage`：`{ role, content: TextContent[]|ToolCall[], stopReason, usage, timestamp, errorMessage? }`
- `ToolResultMessage`：`{ role:"toolResult", toolCallId, toolName, content, details?, isError, timestamp }` —— 靠 `toolCallId` 与 assistant 的 `ToolCall.id` 对应

> 补丁点（本轮不做）：`ThinkingContent`、`ImageContent`、`*Signature` 字段——对应 `AssistantMessageEvent` 里已有的 `thinking_*` 事件，等用到思考块/图片时再进。

---

## 五、第二层：AgentMessage 扩展点（`agent/types.ts`，已具备）

```ts
export interface CustomAgentMessages {
  // Empty by default - apps extend via declaration merging
}
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

**声明合并（coding-agent 注入）**——核心包零依赖、应用层全栈类型安全：

```ts
declare module "pi-agent-core" {
  interface CustomAgentMessages {
    bashExecution: BashExecutionMessage;
    custom: CustomMessage;
    branchSummary: BranchSummaryMessage;
    compactionSummary: CompactionSummaryMessage;
  }
}
```

效果：coding-agent 视野里 `AgentMessage` = 7 种联合，TS 全类型检查；pi-agent-core 完全不知道扩展的存在。

---

## 六、`coding-agent/src/core/messages.ts`（本轮核心）

### 6.1 四种自定义消息接口（对齐生产 messages.ts:29-67）

```ts
export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  /** true = 对 LLM 隐身（!! 前缀），UI 照常渲染 */
  excludeFromContext?: boolean;
}

export interface CustomMessage {            // 扩展注入的通用消息
  role: "custom";
  customType: string;
  content: string | TextContent[];
  display: boolean;
  details?: unknown;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary"; summary: string; fromId: string; timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary"; summary: string; tokensBefore: number; timestamp: number;
}
```

### 6.2 转换器 `convertToLlm(messages: AgentMessage[]): Message[]`（对齐生产 148-195）

按 `role` 分派的 switch，**所有自定义消息都翻译成 `user`**（LLM 协议要求 user/assistant 交替，自定义消息是「系统注入信息」，放 user 最安全）：

```ts
export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages
    .map((m): Message | undefined => {
      switch (m.role) {
        case "bashExecution":
          if (m.excludeFromContext) return undefined;        // 过滤：LLM 不可见
          return { role: "user", content: [{ type: "text", text: bashExecutionToText(m) }], timestamp: m.timestamp };
        case "custom":
          return { role: "user", content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content, timestamp: m.timestamp };
        case "branchSummary":
          return { role: "user", content: [{ type: "text", text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }], timestamp: m.timestamp };
        case "compactionSummary":
          return { role: "user", content: [{ type: "text", text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX }], timestamp: m.timestamp };
        case "user": case "assistant": case "toolResult":
          return m;                                           // 标准消息透传
        default:
          const _never: never = m;                            // 穷举检查
          return undefined;
      }
    })
    .filter((m) => m !== undefined);
}
```

- `bashExecutionToText`：`Ran \`ls -la\`\n\`\`\`\n{output}\n\`\`\`` + 取消/退出码/截断的附加说明（生产 82-98）
- 摘要类前缀/后缀：`COMPACTION_SUMMARY_PREFIX` / `BRANCH_SUMMARY_PREFIX`（`<summary>` 标签包裹，生产 11-24）
- 剪贴工厂：`createBashExecutionMessage`（或仅 `bashExecutionToText`）、`createCustomMessage`、`createCompactionSummaryMessage`、`createBranchSummaryMessage`

### 6.3 `user` 的取舍说明

自定义消息**不翻译成 `assistant`**：连续两个 assistant 违反 LLM 角色交替；且翻译时机「关键词 → 下一轮 user 注入」，放 user 语义最稳。

---

## 七、`agent-loop.ts` 改造：transformContext + convertToLlm 管道（对齐生产 agent-loop.ts:275-289）

### 7.1 `AgentLoopConfig` 类型（`agent/types.ts`）

```ts
convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;   // 保留必填（显式契约）
transformContext?:                                                              // 新增（可选）
  (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
```

> 设计取舍：`convertToLlm` **保持必填**（生产即显式契约）。coding-agent 提供 `convertToLlm` 默认实现供接入；只用标准消息的应用可传恒等 `(m) => m as Message[]`（现有测试正是如此）。`transformContext` 可选——不配置则跳过。

### 7.2 `streamAssistantResponse`（`agent-loop.ts`）

```ts
let messages = context.messages;

// [1] 同层变换（可选）：裁剪 / 注入 / 压缩，类型仍是 AgentMessage[]
if (config.transformContext) {
  messages = await config.transformContext(messages, signal);
}

// [2] 跨层翻译（必填）：AgentMessage[] → Message[]，自定义转 user / 过滤 excludeFromContext
const llmMessages = await config.convertToLlm(messages);

const llmContext = { systemPrompt: context.systemPrompt, messages: llmMessages, tools: context.tools };
```

**为什么分两步**：`transformContext` 是 Agent 自己的事（操作 7 种类型，类型不变），`convertToLlm` 是 LLM 边界的事（输出 3 种类型，类型变了）。换上下文管理只改前者、换应用只改后者，互不干扰。

---

## 八、excludeFromContext 过滤 + 三档可见性（对齐生产 messages.ts:38-39）

`excludeFromContext = true` 的自定义消息：**仍在 `context.messages` 里**（UI 可渲染、可持久化），只在 `convertToLlm` 边界 `return undefined` 被 filter 掉 → 对 LLM 隐身。

| 可见性级别 | LLM | UI | 实现 | 典型消息 |
|---|---|---|---|---|
| 全可见 | ✅ | ✅ | convertToLlm 正常转换 | 普通 BashExecution / User / Assistant |
| LLM 不可见 | ❌ | ✅ | `excludeFromContext = true` | `!!` 前缀 Bash 执行 |
| 仅持久化 | ❌ | ❌ | UI 渲染跳过 + convert 过滤 | Web UI Artifact（本轮不管） |

---

## 九、测试设计（`packages/agent/test/message-system.test.ts`）

| 用例 | 断言 |
|---|---|
| 声明合并 | `AgentMessage` 类型接受 `BashExecutionMessage` / `CompactionSummaryMessage` 等（编译期 + 运行时构造） |
| bashExecution → user | `convertToLlm([bashMsg])` 产出 `{ role:"user", content:[{type:"text", text: 含 "Ran `ls`" 和 output}] }` |
| excludeFromContext | `bashMsg.excludeFromContext=true` → `convertToLlm` 输出**不含**该条 |
| 摘要类 | `compactionSummary` / `branchSummary` → user 且文本被 `<summary>` 包裹 |
| 标准透传 | user/assistant/toolResult 三标准原样通过 |
| 端到端代理 | `agentLoop` 带含自定义消息的 context + `config.convertToLlm = coding-agent 的默认` → mock 只看到标准消息、闭环照跑 |

**现有 15/15 不回归**：现测试传 `convertToLlm: (m) => m as Message[]`，新增 `transformContext?` 可选不影响。

**验收**：`npm run typecheck` exit 0；`npm test` 全绿（15 + 新增 6 左右）。

---

## 十、实施步骤

1. ✅ **声明合并接地**：`coding-agent/src/core/messages.ts` 建 4 种消息接口 + `declare module "pi-agent-core"` + `convertToLlm` + `bashExecutionToText` + 摘要前缀/工厂 → `typecheck` exit 0（此时 `AgentMessage` 变 7 种）。
2. ✅ **`agent/types.ts`**：`AgentLoopConfig` 加 `transformContext?`（`convertToLlm` 保持必填）。
3. ✅ **`agent-loop.ts`**：`streamAssistantResponse` 顶部加 transformContext 前置步骤。
4. ⏳ **`coding-agent/src/index.ts`**：`export * from "./core/messages"`（暂无——测试走相对路径 import 亦可）。
5. ✅ **测试**：`packages/agent/test/message-system.test.ts` 落地第九节用例（6 条，`npm test` 21/21）。
6. ✅ **文档**：`plans/03-message-system.md` 标记 ✅；顶部进度更新。
7. ✅ `npm run typecheck && npm test` 全绿。

---

## 十一、常见坑

| 坑 | 症状 | 解法 |
|---|---|---|
| 声明合并不生效 | `AgentMessage` 不认识自定义 role | `declare module "pi-agent-core"` 的模块名与 package `name` 一致（我们正是 `pi-agent-core`），且 `CustomAgentMessages` 已从 core `export * from "./types"` |
| 穷举检查报错 | `never` 分支接不住 | 新自定义 role 忘了加 `case`（TS 会要求 `_never` 分支成立） |
| 自定义消息漏翻译 | LLM 收到未知 role | 所有自定义角色必须在 `convertToLlm` 里映射到 user/assistant/toolResult 或 `undefined` |
| 连续两个 assistant | LLM API 报角色顺序错 | 自定义消息一律翻成 `user`，不翻 `assistant` |
| `convertToLlm` 未配置就传自定义消息 | 类型逃逸/运行时 break | 保持 `convertToLlm` 必填；接入方必须给（可用 coding-agent 默认实现） |