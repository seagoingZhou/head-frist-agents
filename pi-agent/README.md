# pi-agent

> 深入浅出学习 AI Agent（head-frist-agents）—— pi-agent 学习项目

一个从零搭建 AI Agent 的教学项目。核心思路：**前端、后端、Agent Loop、工具系统、会话存储围绕同一组共享类型工作**——先定协议地基，再在其上逐层构建。

## 目录结构

```
pi-agent/
├── packages/
│   ├── ai/              # pi-ai：共享模块（Step 1：共享协议）
│   │   ├── package.json     # 模块名 pi-ai
│   │   ├── src/
│   │   │   ├── index.ts     # 公共入口：对外暴露协议类型
│   │   │   └── types.ts     # 协议类型定义
│   │   └── test/
│   │       └── protocol.test.ts  # 协议冒烟测试
│   └── agent/           # 规划中：Agent Loop（占位）
│       └── src/agent-loop.ts
├── workspace/           # 学习笔记（Agent Loop 等）
├── vitest.base.ts       # vitest 基底配置（react 插件、端口 5174、/api → 4317）
├── vitest.config.ts     # 继承 base 的 vitest 配置
├── tsconfig.json        # 严格类型检查（strict、noEmit）
└── package.json         # npm workspaces 根，typecheck / test 脚本
```

> 根目录通过 npm workspaces 管理各包，`packages/*` 均注册为工作区。共享模块以 `pi-ai` 名义对外提供，各模块通过 `import { ... } from "pi-ai"` 引用。


## Step 1：共享协议 ✅

共享协议是整个教学项目的地基。前端、后端、Agent Loop、工具系统和会话存储都要围绕同一组类型工作，一处定义、各处复用，避免各模块各自为政导致类型漂移。

**实现位置**：`packages/ai/src/types.ts`（模块 `pi-ai`，公共入口 `packages/ai/src/index.ts`）

### 协议类型清单

| 类型 | 作用 |
|---|---|
| `TextContent` | 文本内容 `{ type: "text", text }` |
| `ToolCallContent` | 工具调用内容 `{ type: "toolCall", id, name, arguments }` |
| `Usage` | token 用量 `{ input, output, totalTokens }` |
| `UserMessage` | 用户消息（role: user） |
| `AssistantMessage` | 助手消息（文本 / 工具调用，`stopReason`/`usage` 必填，可带 `errorMessage`） |
| `ToolResultMessage` | 工具结果消息（绑定 `toolCallId` / `toolName`，`isError` 必填） |
| `AgentMessage` | 三种消息的联合类型，Agent Loop 中流转的消息载体 |
| `ToolDefinition` | 工具定义 `{ name, description, parameters }` |
| `ToolResult` | 工具执行结果（`content` + `details?` + `terminate?`） |
| `SessionEntry` | 会话存储条目（session / message / compaction 三种） |
| `AgentEvent` | Agent 运行事件（agent / turn / message / tool 各阶段开始与结束、消息增量） |
| `SessionResponse` | 一次会话的完整响应（sessionId + messages + events + tools + entries） |

### 生产源码映射

本项目协议是对生产版 `@earendil-works/pi`（本地源码 `/Users/zhouzhou/Program/AICoding/pi`）的教学化简化。类型对应关系如下（行号以生产仓库当前代码为准）：

| 本项目 types.ts | 生产源码对应 | 位置 |
|---|---|---|
| `TextContent` | `TextContent`（同名；生产多可选 `textSignature`） | `packages/ai/src/types.ts:322` |
| `ToolCallContent` | `ToolCall`（名不同；`type: "toolCall"` 已与生产一致） | `packages/ai/src/types.ts:344` |
| `Usage` | `Usage`（同名；生产多缓存/成本统计 `cacheRead`/`cacheWrite`/`cost`） | `packages/ai/src/types.ts:352` |
| `UserMessage` | `UserMessage`（同名；生产 `content` 还收 `string` / `ImageContent`） | `packages/ai/src/types.ts:371` |
| `AssistantMessage` | `AssistantMessage`（同名；生产含 `api`/`provider`/`model`，`usage`/`stopReason` 必填） | `packages/ai/src/types.ts:377` |
| `ToolResultMessage` | `ToolResultMessage<TDetails>`（同名泛型；`isError` 必填） | `packages/ai/src/types.ts:392` |
| `AgentMessage` | 基础联合 `Message`；扩展 `AgentMessage = Message \| CustomAgentMessages` | `packages/ai/src/types.ts:402`；`packages/agent/src/types.ts:314` |
| `ToolDefinition` | `Tool<TParameters>`（typebox schema 泛型） | `packages/ai/src/types.ts:427` |
| `ToolResult` | `AgentToolResult<T>`（同构：content / details / terminate） | `packages/agent/src/types.ts:350` |
| `SessionEntry` | `SessionHeader` / `SessionMessageEntry` / `CompactionEntry` + 其他 7 种条目 | `packages/coding-agent/src/core/session-manager.ts:32/53/69/140` |
| `AgentEvent` | `AgentEvent`（同名，事件在 `agent-loop.ts` 发射、`agent.ts` 消费） | `packages/agent/src/types.ts:413` |
| `SessionResponse` | 无同名类型，生产分布在会话读取 / 导出逻辑中 | — |

> 生产 monorepo 分包：`@earendil-works/pi-ai`（协议核心）、`@earendil-works/pi-agent-core`（Agent 事件/扩展）、`@earendil-works/pi-coding-agent`（会话存储）。

### 设计要点

- **对齐 Agent Loop**：`context -> model -> tools -> toolResult -> next turn`（见 `workspace/agent-notes.md`）。`AgentMessage` 的三种角色（user / assistant / toolResult）正是这条环路的三种消息载体。
- **前后端共用**：同一份类型同时被前端、后端和 Agent 循环引用，保证请求 / 响应结构一致，天然契约。
- **为会话存储预留**：`SessionEntry` 的 `compaction` 条目支持上下文压缩（记录 `summary`、`tokensBefore`），为长会话的继续/恢复做铺垫。

### 进展状态

- [x] 定义共享协议类型（`packages/ai/src/types.ts`）
- [x] 协议冒烟测试：`npm test` → 1 个测试文件、3 个用例全部通过
- [x] 严格类型检查：`npm run typecheck` → 通过
- [ ] 下一步：基于协议搭建前端 / 后端 / Agent Loop / 工具系统

## 常用命令

```bash
npm run typecheck   # 严格类型检查（tsc --noEmit）
npm test            # 跑一次测试（vitest run）
npm run test:watch  # 监听模式跑测试
```
