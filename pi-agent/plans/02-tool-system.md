# pi agent 工具系统：原理详解 + Step by Step 实现

> 项目最终目标：实现生产版 pi agent（源码参考 `/Users/zhouzhou/Program/AICoding/pi/packages`）。
> 本方案：**工具系统**——三层类型、五步管道、并行/串行、Operations 抽象。
> 教学版**分两阶段**：**阶段一**（Read/Write/Edit/Ls + 基础执行）、**阶段二**（五步管道）。
> 前置：mock model + 文本版 agent loop 已就绪（见 `01-mock-model-agent-loop.md`）。

## 当前进度（2026-08-19）

- ✅ 前置：mock + 文本版 agent loop + 工具系统**阶段一工具本体**全部就绪：`read_file` / `write_note` / `list_files` / `edit_file` 已实现；`bash` / `find` / `grep` 为接口桩；`operations.ts` 已删（各工具自包含接口）；mock 关键词 → toolCall 规则已落地（Step 1.2）
- ⏳ 待完成：Step 1.3 `executeToolCalls`（agent-loop 当前还是空 stub）、Step 1.4 集成测试、阶段二五步管道

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

#### Step 1.1：四个真实工具 + 桩工具（`packages/coding-agent/src/tools/`）

> 结构调整（2026-08-19）：原方案打算集中到 `packages/agent/src/tools/operations.ts` 定义接口，实际落地改为**每个工具文件自包含**——接口 + 默认实现 + 工厂 + 单例都放在同一 `.ts`，并**删掉了 `operations.ts`**；`bash.ts` / `find.ts` / `grep.ts` 为纯接口桩（暂无工具对象）。

目录结构（现状）：

```
packages/coding-agent/src/
  utils/paths.ts        // WORKSPACE_ROOT 唯一出口
  tools/path-utils.ts   // pathExists 帮助函数
  tools/read.ts         // read_file     → Step 1.1a
  tools/write.ts        // write_note    → Step 1.1b（逃逸守卫 + 自动建父目录）
  tools/ls.ts           // list_files    → Step 1.1c
  tools/edit.ts         // edit_file     → Step 1.1d
  tools/bash.ts         // 桩：仅 BashOperations 接口
  tools/find.ts         // 桩：仅 FindOperations 接口
  tools/grep.ts         // 桩：仅 GrepOperations 接口
  index.ts              // export * 全部 7 个工具模块
```

> **四工具的通用模式**（每个文件自包含同构）：
> - Operations 接口 + 默认实现 + 工厂 `createXxxTool(workspaceRoot, ops)` + 单例 `xxxTool`——测试可注入临时目录 / 委托远程 fs；
> - 工作区根统一来自 `utils/paths.ts` 的 `WORKSPACE_ROOT`；`pathExists` 在 `tools/path-utils.ts`；
> - 工具名（`read_file` / `write_note` / `list_files` / `edit_file`）**必须与 mock 的 toolCall.name 一致**（非生产版 `read` / `write` / `ls` / `edit`）；
> - `bash.ts` / `find.ts` / `grep.ts` 仅为接口桩（无工具对象）。
>
> 四工具各自实现（代码 + 要点 + 验证）见 Step 1.1a–1.1d。

**验证**：`npm run typecheck` → exit 0。

#### Step 1.1a：read.ts —— read_file 工具（✅ 已实现）

**文件**：`packages/coding-agent/src/tools/read.ts`

只读工具模板：access 存在性检查 + `details` 附加文件总行数。

```ts
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { text } from "pi-ai";
import type { AgentTool } from "pi-agent-core";
import { WORKSPACE_ROOT } from "../utils/paths.ts";

export interface ReadOperations {
    readFile: (path: string) => Promise<string>;
    access: (path: string) => Promise<void>;
}
const defaultReadOperations: ReadOperations = {
  readFile: (path) => fsReadFile(path, "utf-8"),
  access: (path) => fsAccess(path),
};

/** details 里携带的信息（仿生产 read.ts:275：附加文件总行数） */
export interface ReadToolDetails { totalFileLines: number; }

export function createReadTool(
  workspaceRoot: string = WORKSPACE_ROOT,
  ops: ReadOperations = defaultReadOperations,
): AgentTool {
  return {
    name: "read_file",
    label: "读取文件",
    description: "读取工作区文件内容。",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: async (_toolCallId, params) => {
      const path = params.path as string;
      const absolute = join(workspaceRoot, path);
      await ops.access(absolute);                 // 存在性检查
      const content = await ops.readFile(absolute);
      return {
        content: [text(content)],
        details: { totalFileLines: content.split("\n").length } satisfies ReadToolDetails,
      };
    },
  };
}

export const readTool: AgentTool = createReadTool();
```

**实现要点**：
- `ops.access` 失败即 throw → loop catch 成 isError（失败即抛约定）。
- `details.totalFileLines` 仿生产 read.ts:275——LLM 可据此判断是否要分页/继续读。

**验证**：`npm run typecheck` → exit 0。

#### Step 1.1b：write.ts —— write_note 工具（✅ 已实现）

**文件**：`packages/coding-agent/src/tools/write.ts`

写类工具模板：含 **逃逸守卫** + **自动建父目录**（read/ls 没有这两步）。

```ts
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { text } from "pi-ai";
import type { AgentTool } from "pi-agent-core";
import { WORKSPACE_ROOT } from "../utils/paths.ts";

export interface WriteOperations {
    writeFile: (path: string, content: string) => Promise<void>;
    mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
    writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
    mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
}

export function createWriteTool(
    workspaceRoot: string = WORKSPACE_ROOT,
    operates: WriteOperations = defaultWriteOperations,
): AgentTool {
    return {
        name: "write_note",   // ⚠️ 必须与 mock 的 toolCall.name 一致
        label: "写入文件",
        description: "写入文件内容，自动创建父目录。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" },
                content: { type: "string" },
            },
        },
        execute: async (_toolCallId, params) => {
            const path = params.path as string;
            const content = params.content as string;

            // ① 路径安全：解析 + 阻止逃逸出 workspace（写工具最危险的洞）
            const absolutePath = resolve(workspaceRoot, path);
            const relativePath = relative(workspaceRoot, absolutePath);
            if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
                throw new Error(`Write path escapes workspace: ${path}`);
            }

            // ② 自动创建父目录（仿生产：先 mkdir 再 write）
            await operates.mkdir(dirname(absolutePath))

            // ③ 写入（失败会 throw → 由 loop 第 4 步 catch 成 isError）
            await operates.writeFile(absolutePath, content);

            return {
                content: [text(`Successfully wrote ${content.length} bytes to ${path}`)],
                details: {},
            }
        }
    }
}

export const writeTool: AgentTool = createWriteTool()
```

**实现要点**：
- 逃逸守卫最危险（`resolve` / `relative` / `isAbsolute` 三行）——写类工具必须挡住 `../` 越出 workspace。
- 自动建父目录（先 mkdir 再 write，`{ recursive: true }`）。
- 失败即抛（`throw` → loop catch 成 isError）；`name` 必须是 `write_note`（与 mock 一致）。

**验证**：单测确认「写→读回、父目录自动创建、逃逸拒绝」（`coding-agent/test/tools/write.test.ts`）；`npm run typecheck` → exit 0。

#### Step 1.1c：ls.ts —— list_files 工具（✅ 已实现）

**文件**：`packages/coding-agent/src/tools/ls.ts`

前置：`WORKSPACE_ROOT` 从 `../utils/paths.ts` 导入；`pathExists` 从 `./path-utils.ts` 导入。

```ts
import { pathExists } from "./path-utils.ts";
import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { text } from "pi-ai";
import type { AgentTool } from "pi-agent-core";
import { WORKSPACE_ROOT } from "../utils/paths.ts";

const DEFAULT_LIMIT = 500;

export interface LsOperations {
    exists: (path: string) => Promise<boolean>;
    stat: (path: string) => Promise<{ isDirectory(): boolean }>;
    readdir: (path: string) => Promise<string[]>;
}
const defaultLsOperations: LsOperations = {
    exists: pathExists,
    stat: fsStat,
    readdir: fsReaddir,
};

/** 返回给 LLM 的附加信息：目录条目数限制是否触发 */
export interface LsToolDetails {
    entryLimitReached?: number;   // 命中 limit 时记录条目总数
}

export function createLsTool(
    workspaceRoot: string = WORKSPACE_ROOT,
    ops: LsOperations = defaultLsOperations,
): AgentTool {
    return {
        name: "list_files",   // ⚠️ 必须与 mock 的 toolCall.name 一致（不是生产版的 "ls"）
        label: "列出文件",
        description: "列出目录内容，目录名带 / 后缀，默认最多 500 条。",
        parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } } },
        execute: async (_toolCallId, params) => {
            // ① 解析路径，缺省 "."
            const dirPath = join(workspaceRoot, (params.path as string) || ".");
            // ② 存在性检查
            if (!(await ops.exists(dirPath))) throw new Error(`Path not found: ${dirPath}`);
            // ③ 必须是目录
            const stat = await ops.stat(dirPath);
            if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);
            // ④ 读取 + 大小写不敏感排序
            let entries = await ops.readdir(dirPath);
            entries = entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            // ⑤ 截断：目录加 "/" 后缀，limit 触发时记 entryLimitReached
            const effectiveLimit = (params.limit as number) ?? DEFAULT_LIMIT;
            const results: string[] = [];
            let entryLimitReached = 0;
            for (const entry of entries) {
                if (results.length >= effectiveLimit) { entryLimitReached = entries.length; break; }
                let suffix = "";
                try {
                    const entryStat = await ops.stat(join(dirPath, entry));
                    if (entryStat.isDirectory()) suffix = "/";
                } catch { continue; }   // stat 不了就跳过该条
                results.push(entry + suffix);
            }
            const output = results.length === 0 ? "(empty directory)" : results.join("\n");
            return { content: [text(output)], details: entryLimitReached > 0 ? { entryLimitReached } : {} };
        },
    };
}

export const lsTool: AgentTool = createLsTool();
```

**实现要点**（对齐生产 `ls.ts` 顺序）：
- 六步顺序：解析 → exists → isDirectory → readdir → 排序 → 逐条 stat 标 "/" + limit 截断。
- 失败即抛：`Path not found` / `Not a directory` 由 loop 第 4 步 catch 成 isError。
- `entryLimitReached` 记录**条目总数**（非布尔），LLM 可判断还剩多少没列。
- 生产用 abort `reject(new Error(...))` 双路径（启动前检查 + 运行中监听）；教学版可只做 `if (signal?.aborted) throw`（路径①）。

**验证**：临时单测确认「a.txt/b.txt/subdir/ 排序 + 后缀、limit:1 → entryLimitReached=3、missing → throw」；`npm run typecheck` → exit 0。

#### Step 1.1d：edit.ts —— edit_file 工具（✅ 已实现）

> 已于 2026-08-19 实现并按下方代码核对（实现时清理了多余的 `node:fs` 同步 import）。

**文件**：`packages/coding-agent/src/tools/edit.ts`

生产版 edit 很重（`edits[]` 数组 + 非重叠校验、diff 渲染、unified patch、行尾规范化），教学版收敛为**单次精确替换**：参数 `{ path, oldText, newText }`。

```ts
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { text } from "pi-ai";
import type { AgentTool } from "pi-agent-core";
import { WORKSPACE_ROOT } from "../utils/paths.ts";

export interface EditOperations {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
    access: (path: string) => Promise<void>;
}
const defaultEditOperations: EditOperations = {
    readFile: (path) => fsReadFile(path, "utf-8"),
    writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
    access: (path) => fsAccess(path),
};

export function createEditTool(
    workspaceRoot: string = WORKSPACE_ROOT,
    ops: EditOperations = defaultEditOperations,
): AgentTool {
    return {
        name: "edit_file",
        label: "编辑文件",
        description: "用精确文本替换修改文件（oldText 必须在文件中唯一）。",
        parameters: {
            type: "object",
            properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } },
            required: ["path", "oldText", "newText"],
        },
        execute: async (_toolCallId, params) => {
            const path = params.path as string;
            const oldText = params.oldText as string;
            const newText = (params.newText as string) ?? "";

            // ① 解析绝对路径
            const absolute = join(workspaceRoot, path);
            // ② 逃逸守卫（写类工具最危险：挡住 ../ 越出 workspace，照抄 write.ts 三行）
            const rel = relative(workspaceRoot, absolute);
            if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Edit path escapes workspace: ${path}`);
            // ③ 存在性检查（access 失败会 throw → loop catch 成 isError）
            await ops.access(absolute);
            // ④ 读原文 + 匹配校验
            const content = await ops.readFile(absolute);
            if (!oldText) throw new Error("oldText must not be empty");
            const index = content.indexOf(oldText);
            if (index === -1) throw new Error(`oldText not found in ${path}`);
            if (content.indexOf(oldText, index + 1) !== -1) throw new Error(`oldText is not unique in ${path}`);
            // ⑤ 替换 + 写回
            const newContent = content.slice(0, index) + newText + content.slice(index + oldText.length);
            await ops.writeFile(absolute, newContent);
            // ⑥ 返回（仿生产 edit.ts:330：错误信息带路径）
            return { content: [text(`Successfully replaced 1 block in ${path}`)], details: {} };
        },
    };
}

export const editTool: AgentTool = createEditTool();
```

**实现要点**：
- 第 ④ 步两个检查是灵魂：oldText 不存在 / 出现多处 → **拒绝执行而不是猜**，替换错位置比不替换更糟。
- 逃逸守卫比 ls 更必要（读+写，能覆盖工作区外文件）。
- mock 目前无 edit 关键词规则 → `edit_file` 暂不会被触发；需要时在 `mock.ts` 加「修改/替换 → edit_file」。

**验证（✅ 已通过）**：临时单测断言四件事——正常替换读回、oldText 缺失抛错且**文件未改动**、oldText 重复抛 not unique、`../` 逃逸抛错；`npm run typecheck` → exit 0。

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
