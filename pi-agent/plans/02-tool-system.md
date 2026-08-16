# pi agent 工具系统：原理详解 + Step by Step 实现

> 项目最终目标：实现生产版 pi agent（源码参考 `/Users/zhouzhou/Program/AICoding/pi/packages`）。
> 本方案：**工具系统**——三层类型、五步管道、并行/串行、Operations 抽象。
> 教学版**分两阶段**：**阶段一**（Read/Write/Edit/Ls + 基础执行）、**阶段二**（五步管道）。
> 前置：mock model + 文本版 agent loop 已就绪（见 `01-mock-model-agent-loop.md`）。

## 当前进度（2026-08-16）

- ✅ 前置：mock + 文本版 agent loop（`01-mock-model-agent-loop.md` 的 Step 0-7）
- ⏳ 待完成：工具系统——阶段一（工具 + 基础执行）、阶段二（五步管道）

---

## 一、原理详解

### 1.1 三层类型：Tool → AgentTool → ToolDefinition

生产源码把「工具」拆成三层，各司其职：

| 层 | 类型 | 生产位置 | 职责 |
|---|---|---|---|
| **第一层** | `Tool` | `pi/packages/ai/src/types.ts:427` | **通用工具契约**——`name` / `description` / `parameters`（TypeBox schema）。所有层共用这一个基础形状 |
| **第二层** | `AgentTool` | `pi/packages/agent/src/types.ts:371` | **运行时工具**——在 Tool 上加 `label`（UI 名）、`execute()`（执行函数）、`prepareArguments?`（参数预处理钩子）、`executionMode?`（串行/并行） |
| **第三层** | `ToolDefinition` | `pi/packages/coding-agent/src/core/extensions/types.ts:435` | **产品层工具**——在 AgentTool 基础上再加 `promptSnippet` / `promptGuidelines`（进 system prompt）、`renderCall` / `renderResult`（UI 渲染）、`execute` 带 `ctx`（扩展上下文） |
| **适配器** | `wrapToolDefinition` | `pi/packages/coding-agent/src/core/tools/tool-definition-wrapper.ts:5` | **ToolDefinition → AgentTool**：把产品层定义包装成核心运行时能执行的形式（`execute` 注入 `ctx`） |

**为什么要三层**（教学重点）：
- `Tool` 是最小共同契约——LLM 只关心「名字 + 描述 + 参数 schema」，**不关心工具怎么实现**。
- `AgentTool` 是核心 loop **实际执行**的对象（有 `execute`）。
- `ToolDefinition` 是**产品/扩展层**的完整定义（渲染、prompt、权限），通过 `wrapToolDefinition` 降级成 AgentTool 交给 loop。
- 这样：核心（pi-agent-core）只依赖 `AgentTool`，产品（pi-coding-agent）持有完整 `ToolDefinition`，两者解耦。

### 1.2 五步管道：从 LLM 的 ToolCall 到 ToolResultMessage

生产 `agent-loop.ts` 把工具执行拆成 **5 个可插拔步骤**：

```
LLM 输出 ToolCall
    │
    ▼
┌──────────────────────────────────────────────────┐
│ 第 1 步：prepareArguments（参数预处理）           │
│   处理 LLM 的参数怪癖                            │
│   如：把字符串化的数组解析回真正的数组             │
├──────────────────────────────────────────────────┤
│ 第 2 步：validateToolArguments（Schema 验证）     │
│   用 TypeBox Schema 做运行时类型检查              │
│   如：path 是 string，不是 number                │
├──────────────────────────────────────────────────┤
│ 第 3 步：beforeToolCall（前置钩子）              │
│   产品层的权限拦截，可以阻止执行                   │
│   返回 { block: true, reason: "危险命令"}         │
├──────────────────────────────────────────────────┤
│ 第 4 步：tool.execute（实际执行）                 │
│   调用工具的 execute 函数                         │
│   支持 onUpdate 流式进度回调                      │
├──────────────────────────────────────────────────┤
│ 第 5 步：afterToolCall（后置钩子）               │
│   产品层的结果后处理，可以修改返回值               │
│   可以替换 content、details、isError              │
└──────────────────────────────────────────────────┘
    │
    ▼
ToolResultMessage
```

**每一步的落点**（生产源码）：

| 步 | 函数 | 位置 | 产出 |
|---|---|---|---|
| 1 | `prepareToolCallArguments` | `agent-loop.ts:555` | 预处理后的参数（工具 `prepareArguments` 可选） |
| 2 | `validateToolArguments` | `pi/packages/ai/src/utils/validation.ts:292` | 校验+coerce 后的参数；失败抛错 |
| 1+2+3 | `prepareToolCall` | `agent-loop.ts:562-626` | `{ kind: "prepared", tool, args }` 或 `{ kind: "immediate", result }`（未找到工具 / 被 block / 校验失败 → 立即产出错误结果） |
| 4 | `executePreparedToolCall` | `agent-loop.ts:628-669` | 调 `tool.execute(id, args, signal, onUpdate)`；`onUpdate` 发 `tool_execution_update`；异常 catch 成错误结果 |
| 5 | `finalizeExecutedToolCall` | `agent-loop.ts:671-714` | `afterToolCall` 钩子可替换 `content/details/isError` |
| 兜底 | `createErrorToolResult` | `agent-loop.ts:716-721` | 统一错误消息搬运：`{ content: [text(msg)], details: {} }` |

**设计要点**：
- **第 3 步是"产品层权限"**（`config.beforeToolCall`），**第 5 步是"产品层后处理"**（`config.afterToolCall`）——都是 `AgentLoopConfig` 上的可选钩子，核心 loop 不关心产品逻辑。
- `prepareToolCall` 返回 `immediate`（未找到工具、aborted、block、校验失败）→ 直接产出错误 ToolResult，**不进入 execute**。
- 第 4 步的 `onUpdate` 是**流式进度**：工具执行过程中可以多次回调，loop 转发成 `tool_execution_update` 事件。回调被 `acceptingUpdates` 标志保护，工具 resolve 后的调用被忽略。

### 1.3 并行 vs 串行

一个 assistant 消息里可能有**多个 toolCall**，生产支持两种执行模式（`agent-loop.ts:381-391`）：

```ts
const hasSequentialToolCall = toolCalls.some(
    (tc) => tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
);
if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(...);   // 逐个执行
}
return executeToolCallsParallel(...);          // Promise.all 并发
```

- **串行触发**：`config.toolExecution === "sequential"`（全局强制）**或**任一工具 `executionMode: "sequential"`（按工具声明）。
- 顺序保证：并行模式仍按原 toolCall 顺序汇总结果（`orderedFinalizedCalls`），只是并发执行。
- **终止语义**：`shouldTerminateToolBatch`——若**所有**已完成的工具都返回 `result.terminate === true`，则整批结束后终止 agent loop。

### 1.4 Operations 抽象（接口可插拔）

每个工具把自己的文件系统操作抽象成一个 `Operations` 接口，默认实现走本地 fs，**可通过覆盖委托给远程系统**（如 SSH）。

| 工具 | 接口 | 方法 |
|---|---|---|
| Read | `ReadOperations` | `readFile`, `access`（另含可选 `detectImageMimeType`） |
| Write | `WriteOperations` | `writeFile`, `mkdir` |
| Edit | `EditOperations` | `readFile`, `writeFile`, `access` |
| Bash | `BashOperations` | `exec` |
| Grep | `GrepOperations` | `isDirectory`, `readFile` |
| Find | `FindOperations` | `exists`, `glob` |
| Ls | `LsOperations` | `exists`, `stat`, `readdir` |

范例（`read.ts:43-50`）：
```ts
export interface ReadOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	access: (absolutePath: string) => Promise<void>;
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}
const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	...
};
```

### 1.5 工具实现要点（生产范例）

- **Read 附加文件总行数**（`read.ts:275`）：读完文本后 `totalFileLines = content.split("\n").length`，放进 `details`，方便 LLM 判断「要不要分页读」。
- **Edit 附加文件路径**（`edit.ts:330`）：出错消息里带上路径 + 错误码。
- **Bash 主动识别错误**（`bash.ts:390-407`）：**工具内部判断** `exitCode !== 0` 就 `throw new Error(...)`——而不是把错误码塞进 content。**约定：失败就 throw**，由第 4 步 catch 成 isError 的 ToolResultMessage。

---

## 二、教学版实现（两阶段）

> 总目标：跑通「读取/写入 agent-notes.md → 工具调用 → toolResult → 最终回答」的完整工具闭环。
> **阶段一先跑通闭环（简单执行），阶段二再把执行升级为完整管道**——避免一步到位引入太多概念。

### 阶段一：工具 + 基础执行（Read / Write / Edit / Ls）

> **目标**：4 个工具能真实读写 `workspace/`，跑通**简单工具闭环**（仅 find→execute，不引入完整管道）。**验收 = 集成测试用例 1**。

#### Step 1.1：Operations 接口 + 四个真实工具（`packages/agent/src/tools/`）

新建 `packages/agent/src/tools/operations.ts`：

```ts
// 与生产对齐的接口（教学版只留核心方法；Grep/Find/Bash 为桩）
export interface ReadOperations {
    readFile: (path: string) => Promise<string>;
    access: (path: string) => Promise<void>;
}
export interface WriteOperations {
    writeFile: (path: string, content: string) => Promise<void>;
    mkdir: (path: string) => Promise<void>;
}
export interface EditOperations {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
    access: (path: string) => Promise<void>;
}
export interface LsOperations {
    exists: (path: string) => Promise<boolean>;
    stat: (path: string) => Promise<{ isDirectory(): boolean }>;
    readdir: (path: string) => Promise<string[]>;
}
export interface GrepOperations { isDirectory: () => Promise<boolean>; readFile: () => Promise<string> } // 桩
export interface FindOperations { exists: () => Promise<boolean>; glob: () => Promise<string[]> }        // 桩
export interface BashOperations { exec: () => Promise<{ stdout: string; exitCode: number }> }            // 桩
```

新建 `packages/agent/src/tools/read.ts`（**以 `pi-agent/workspace/` 为工作区根**）：

```ts
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { text } from "pi-ai";
import type { AgentTool } from "../types.ts";

const WORKSPACE = join(import.meta.dirname, "../../../../workspace");

export const readTool: AgentTool = {
  name: "read_file",
  label: "读取文件",
  description: "读取工作区文件内容。",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  execute: async (_id, params) => {
    const path = params.path as string;
    const absolute = join(WORKSPACE, path);
    await access(absolute);                       // 存在性检查
    const content = await readFile(absolute, "utf-8");
    return {
      content: [text(content)],
      details: { totalFileLines: content.split("\n").length },  // 仿生产 read.ts:275
    };
  },
};
```

> `Write` / `Edit` / `Ls` 照同一模式（`node:fs/promises` + Operations），各自实现 `write_file` / `edit_file` / `list_files`；`Grep` / `Find` / `Bash` 只留桩（`execute` 抛「未实现」）。

**验证**：`npm run typecheck` → exit 0。

#### Step 1.2：mock 规则 → toolCall（`packages/ai/src/providers/mock.ts`）

给 `mockReply` 补关键词规则 + 「看到 toolResult → 最终回答」：

```ts
function mockReply(context: Context): AssistantMessage {
  const last = context.messages[context.messages.length - 1];
  if (last && last.role === "toolResult") {
    // 已经看到 toolResult → 最终回答
    const output = messageText(last);
    if (last.toolName === "read_file") {
      return createAssistantMessage([text(`我读取到了文件内容。关键内容如下：\n${output}`)]);
    }
    if (last.toolName === "write_note") {
      return createAssistantMessage([text(`笔记已经写入：${output}`)]);
    }
    return createAssistantMessage([text(`工具结果：${output}`)]);
  }
  if (last && last.role === "user") {
    const input = messageText(last).toLowerCase();
    if (input.includes("列出") || input.includes("文件")) {
      return createAssistantMessage(
        [{ type: "toolCall", id: `call_${Date.now()}_list`, name: "list_files", arguments: { path: "." } }],
        "toolUse",
      );
    }
    if (input.includes("读取") || input.includes("打开")) {
      return createAssistantMessage(
        [{ type: "toolCall", id: `call_${Date.now()}_read`, name: "read_file", arguments: { path: pickFile(input) } }],
        "toolUse",
      );
    }
    if (input.includes("笔记") || input.includes("写")) {
      return createAssistantMessage(
        [{ type: "toolCall", id: `call_${Date.now()}_write`, name: "write_note", arguments: { path: "agent-loop-note.md" } }],
        "toolUse",
      );
    }
  }
  return createAssistantMessage([text(`（mock 回复）你说：${last && last.role === "user" ? messageText(last) : ""}`)]);
}

function pickFile(input: string): string {
  if (input.includes("agent")) return "agent-notes.md";
  return "README.md";
}
```

> `streamMock` 需要支持 toolCall 事件的转发——toolCall 内容走 `toolcall_start` → `done(reason: "toolUse")`（文本内容仍走 `text_start/delta/end`）。

**验证**：`npm run typecheck` → exit 0。

#### Step 1.3：agent-loop 基础执行（替换空 stub）

> 阶段一**不引入完整管道**，先用「找到工具 → 直接 execute → ToolResultMessage」的最小执行：

```ts
// agent/src/agent-loop.ts
function createErrorToolResult(message: string): AgentToolResult {
  return { content: [text(message)], details: {} };
}

async function executeToolCalls(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<ToolResultMessage[]> {
  const toolCalls = assistantMessage.content.filter((c): c is ToolCall => c.type === "toolCall");
  const toolResults: ToolResultMessage[] = [];

  for (const toolCall of toolCalls) {
    const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
    stream.push({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });

    let result: AgentToolResult;
    let isError = false;
    try {
      if (!tool) throw new Error(`Tool ${toolCall.name} not found`);
      result = await tool.execute(toolCall.id, toolCall.arguments, signal);
    } catch (error) {
      result = createErrorToolResult(error instanceof Error ? error.message : String(error));
      isError = true;
    }

    stream.push({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result, partialResult: result });
    const toolResultMessage: ToolResultMessage = {
      role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name,
      content: result.content, details: result.details, isError, timestamp: Date.now(),
    };
    stream.push({ type: "message_start", message: toolResultMessage });
    stream.push({ type: "message_end", message: toolResultMessage });
    toolResults.push(toolResultMessage);
  }
  return toolResults;
}
```

在 `runLoop` 里替换对 `excuteToolCalls` 的调用：

```ts
if (hasMoreToolCalls) {
    const toolResults = await executeToolCalls(currentAgentContext, assistantMessage, signal, stream);
    for (const result of toolResults) {
        currentAgentContext.messages.push(result);
        newMessages.push(result);
    }
}
```

**验证**：`npm run typecheck` → exit 0。

#### Step 1.4：集成测试用例 1

见「三、集成测试用例 · 用例 1」。跑通后进入阶段二。

---

### 阶段二：五步管道

> **目标**：把阶段一的简单执行升级为生产式**五步管道**（prepareArguments / validate / beforeToolCall / execute / afterToolCall），支持串行/并行与流式进度。**验收 = 集成测试用例 2**。

#### Step 2.1：类型增强（`packages/agent/src/types.ts`）

`AgentTool` 补 `prepareArguments?` / `executionMode?` / `onUpdate`，`AgentToolResult` 加 `terminate?`：

```ts
// agent/src/types.ts —— 替换现有 AgentToolResult / AgentTool 部分

export type ToolExecutionMode = "sequential" | "parallel";

export interface AgentToolResult {
    content: TextContent[];
    details: any;
    terminate?: boolean;      // true = 提示整批结束后终止 loop
}

export type AgentToolUpdateCallback = (partialResult: AgentToolResult) => void;

export interface AgentTool extends Tool {
    label: string;
    prepareArguments?: (args: unknown) => Record<string, unknown>;
    executionMode?: ToolExecutionMode;
    execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback,     // 流式进度
    ) => Promise<AgentToolResult>;
}
```

**验证**：`npm run typecheck` → exit 0。

#### Step 2.2：五步管道（`packages/agent/src/agent-loop.ts`）

把阶段一的 `executeToolCalls` 拆成生产式三函数（教学版先用 `Record<string, unknown>` 参数，TypeBox 留 TODO）：

```ts
async function prepareToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: ToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<{ tool: AgentTool; args: Record<string, unknown> } | { error: string }> {
  const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
  if (!tool) return { error: `Tool ${toolCall.name} not found` };

  // 第 1 步：prepareArguments（LLM 参数怪癖预处理）
  const args = tool.prepareArguments
    ? (tool.prepareArguments(toolCall.arguments) as Record<string, unknown>)
    : toolCall.arguments;

  // 第 2 步：validateToolArguments（教学版最小校验；生产用 TypeBox Value.Convert + Check）
  if (args === null || typeof args !== "object") {
    return { error: `Invalid arguments for tool ${toolCall.name}` };
  }

  // 第 3 步：beforeToolCall（产品层权限钩子）
  if (config.beforeToolCall) {
    const decision = await config.beforeToolCall(toolCall, args);
    if (decision?.block) {
      return { error: decision.reason ?? "Tool execution was blocked" };
    }
  }
  if (signal?.aborted) return { error: "Operation aborted" };

  return { tool, args };
}

async function executeToolCall(
  prepared: { tool: AgentTool; args: Record<string, unknown> },
  toolCall: ToolCall,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<{ result: AgentToolResult; isError: boolean }> {
  // 第 4 步：tool.execute（onUpdate 转发成 tool_execution_update）
  try {
    const result = await prepared.tool.execute(
      toolCall.id, prepared.args, signal,
      (partialResult) => {
        stream.push({ type: "tool_execution_update", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments, partialResult });
      },
    );
    return { result, isError: false };
  } catch (error) {
    return {
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  }
}

async function finalizeToolCall(
  result: AgentToolResult, isError: boolean, toolCall: ToolCall, config: AgentLoopConfig,
): Promise<AgentToolResult> {
  // 第 5 步：afterToolCall（产品层后处理，可改 content/details/isError）
  if (config.afterToolCall) {
    const override = await config.afterToolCall(toolCall, result, isError);
    if (override) {
      return {
        content: override.content ?? result.content,
        details: override.details ?? result.details,
        terminate: override.terminate ?? result.terminate,
      };
    }
  }
  return result;
}
```

**验证**：`npm run typecheck` → exit 0。

#### Step 2.3：串行/并行驱动（`packages/agent/src/agent-loop.ts`）

把阶段一的 `executeToolCalls` 改为「先判断模式再分派」：

```ts
async function executeToolCalls(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<ToolResultMessage[]> {
  const toolCalls = assistantMessage.content.filter((c): c is ToolCall => c.type === "toolCall");
  const hasSequential = toolCalls.some(
    (tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
  );
  if (config.toolExecution === "sequential" || hasSequential) {
    return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, stream);
  }
  return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, stream);
}
```

- **串行函数**（`executeToolCallsSequential`）：对每个 toolCall 依次走 Step 2.2 的 `prepareToolCall → executeToolCall → finalizeToolCall`，产出 `tool_execution_start/update/end` + `toolResult` 消息（即把阶段一 Step 1.3 的循环体换成管道三函数）。
- **并行函数**（`executeToolCallsParallel`）：`Promise.all(toolCalls.map(async (tc) => { ... 管道三函数 ... }))`，最后按原顺序汇总。**作为练习**。

**验证**：`npm run typecheck` → exit 0。

#### Step 2.4：集成测试用例 2

见「三、集成测试用例 · 用例 2」。

---

## 三、集成测试用例

### 用例 1（阶段一验收）：读取 + 写入 agent-notes.md

测试文件 `packages/agent/test/tool-loop.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createUserMessage, type Message } from "pi-ai";
import { agentLoop } from "../src/agent-loop.ts";
import { mockModel } from "../../ai/src/model.ts";
import { readTool, writeNoteTool } from "../src/tools/index.ts";

const tools = [readTool, writeNoteTool];

function run(prompt: string) {
  return agentLoop(
    [createUserMessage(prompt)],
    { systemPrompt: "你是教学 Agent。", messages: [], tools },
    { model: mockModel, convertToLlm: (m) => m as Message[] },
  );
}

describe("工具闭环 —— 阶段一", () => {
  it("读取 agent-notes.md → read_file → 最终回答含文件内容", async () => {
    const stream = run("读取 agent-notes.md");
    const events: string[] = [];
    for await (const event of stream) {
      if (event.type === "tool_execution_start") events.push(`tool_start:${event.toolName}`);
      if (event.type === "tool_execution_end") events.push(`tool_end:${event.toolName}`);
    }
    expect(events).toContain("tool_start:read_file");
    expect(events).toContain("tool_end:read_file");

    const newMessages = await stream.result();
    expect(newMessages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);

    const finalText = newMessages.at(-1)!.content
      .filter((b) => b.type === "text").map((b) => b.text).join("");
    expect(finalText).toContain("我读取到了文件内容");
    expect(finalText).toContain("Agent Loop");   // agent-notes.md 内容
  });

  it("写笔记 → write_note → 文件已写入 workspace", async () => {
    const newMessages = await run("写笔记").result();
    const finalText = newMessages.at(-1)!.content
      .filter((b) => b.type === "text").map((b) => b.text).join("");
    expect(finalText).toContain("笔记已经写入");

    // 从磁盘读回验证（mock 的 write_note 写入 workspace/agent-loop-note.md）
    const { readFile } = await import("node:fs/promises");
    const written = await readFile(joinWorkspace("agent-loop-note.md"), "utf-8");
    expect(written).toContain("Agent Loop");
  });
});
```

> ⚠️ 写测试会真实创建 `workspace/agent-loop-note.md`——测试后自行清理，或改用其他文件名。

**事件序列（读取）**：
```
turn1: message_start/end(user) → assistant toolCall(read_file)
       → tool_execution_start(read_file) → tool_execution_end(read_file)
       → message_start/end(toolResult)
turn2: assistant 最终回答（含 agent-notes.md 内容摘要）
```

**验收**：`npm run typecheck && npm test` → 新增用例通过。

---

### 用例 2（阶段二验收）：五步管道行为

在 `packages/agent/test/tool-loop.test.ts` 追加 `describe("五步管道 —— 阶段二")`：

```ts
import { messageText } from "pi-ai";

describe("五步管道 —— 阶段二", () => {
  it("beforeToolCall 拦截 → toolResult isError，内容含 reason", async () => {
    const stream = agentLoop(
      [createUserMessage("读取 agent-notes.md")],
      { systemPrompt: "你是教学 Agent。", messages: [], tools },
      {
        model: mockModel,
        convertToLlm: (m) => m as Message[],
        beforeToolCall: async () => ({ block: true, reason: "危险命令" }),
      },
    );
    const newMessages = await stream.result();
    const toolResult = newMessages.find((m) => m.role === "toolResult");
    expect(toolResult.isError).toBe(true);
    expect(messageText(toolResult)).toContain("危险命令");
  });

  it("afterToolCall 改写 content", async () => {
    const stream = agentLoop(
      [createUserMessage("读取 agent-notes.md")],
      { systemPrompt: "你是教学 Agent。", messages: [], tools },
      {
        model: mockModel,
        convertToLlm: (m) => m as Message[],
        afterToolCall: async () => ({ content: [{ type: "text", text: "改写结果" }] }),
      },
    );
    const newMessages = await stream.result();
    const toolResult = newMessages.find((m) => m.role === "toolResult");
    expect(messageText(toolResult)).toBe("改写结果");
  });

  it("onUpdate → tool_execution_update 事件", async () => {
    // 让某个工具在 execute 里调用 onUpdate({ content: [text("进度…")], details: {} })
    // 断言事件序列含 tool_execution_update
  });

  it("prepareArguments 规范化参数", async () => {
    // 让某个工具定义 prepareArguments，把字符串化数组解析回数组
    // 断言 execute 收到的 params 是数组
  });
});
```

**验收**：`npm run typecheck && npm test` → 用例 2 全过。

---

## 四、常见坑

| 坑 | 症状 | 解法 |
|---|---|---|
| 工具找不到 | `Tool xxx not found` | `context.tools` 里必须注册对应 `AgentTool`，且 `name` 与 mock 发出的 toolCall.name 一致 |
| 失败未抛错 | 错误被当成功 | 工具**失败要 throw**（生产约定），由执行层 catch 成 isError |
| 参数验证过严 | 真实调用被拒 | 阶段一直接透传参数（无校验）；阶段二才有 `validateToolArguments`（先最小校验，TypeBox 是生产目标） |
| 死循环 | turn 无限循环 | mock 的「看到 toolResult → 返回 stop 文本」规则不能漏；否则每次都是 toolCall |
| 文件读不到 | ENOENT | 工具路径相对 `workspace/` 解析；确认工作区根路径正确 |
| `message_update` 看不到 | 只有生命周期事件 | 需先完成 01 文档的 **Step 8（assistant 流式事件转发）**，再叠加本方案 |
