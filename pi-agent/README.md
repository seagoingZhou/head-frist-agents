# pi-agent

> 深入浅出学习 AI Agent（head-frist-agents）—— pi-agent 学习项目

一个从零搭建 AI Agent 的教学项目。核心思路：**前端、后端、Agent Loop、工具系统、会话存储围绕同一组共享类型工作**——先定协议地基，再在其上逐层构建。

## 目录结构

```
pi-agent/
├── packages/
│   └── protocol/        # Step 1：共享协议
│       ├── protocol.ts      # 协议类型定义
│       └── protocol.test.ts # 协议冒烟测试
├── workspace/           # 学习笔记（Agent Loop 等）
├── vitest.base.ts       # vitest 基底配置（react 插件、端口 5174、/api → 4317）
├── vitest.config.ts     # 继承 base 的 vitest 配置
├── tsconfig.json        # 严格类型检查（strict、noEmit）
└── package.json         # typecheck / test 脚本
```

## Step 1：共享协议 ✅

共享协议是整个教学项目的地基。前端、后端、Agent Loop、工具系统和会话存储都要围绕同一组类型工作，一处定义、各处复用，避免各模块各自为政导致类型漂移。

**实现位置**：`packages/protocol/protocol.ts`

### 协议类型清单

| 类型 | 作用 |
|---|---|
| `TextContent` | 文本内容 `{ type: "text", text }` |
| `ToolCallContent` | 工具调用内容 `{ type: "tool_call", id, name, arguments }` |
| `Usage` | token 用量 `{ input, output, totalTokens }` |
| `UserMessage` | 用户消息（role: user） |
| `AssistantMessage` | 助手消息（文本 / 工具调用，可带 `stopReason`、`usage`、`errorMessage`） |
| `ToolResultMessage` | 工具结果消息（绑定 `toolCallId` / `toolName`，可带 `isError`） |
| `AgentMessage` | 三种消息的联合类型，Agent Loop 中流转的消息载体 |
| `ToolDefinition` | 工具定义 `{ name, description, parameters }` |
| `SessionEntry` | 会话存储条目（session / message / compact 三种） |

### 设计要点

- **对齐 Agent Loop**：`context -> model -> tools -> toolResult -> next turn`（见 `workspace/agent-notes.md`）。`AgentMessage` 的三种角色（user / assistant / toolResult）正是这条环路的三种消息载体。
- **前后端共用**：同一份类型同时被前端、后端和 Agent 循环引用，保证请求 / 响应结构一致，天然契约。
- **为会话存储预留**：`SessionEntry` 的 `compact` 条目支持上下文压缩（记录 `summary`、`tokensBefore`），为长会话的继续/恢复做铺垫。

### 进展状态

- [x] 定义共享协议类型（`packages/protocol/protocol.ts`）
- [x] 协议冒烟测试：`npm test` → 1 个测试文件、3 个用例全部通过
- [x] 严格类型检查：`npm run typecheck` → 通过
- [ ] 下一步：基于协议搭建前端 / 后端 / Agent Loop / 工具系统

## 常用命令

```bash
npm run typecheck   # 严格类型检查（tsc --noEmit）
npm test            # 跑一次测试（vitest run）
npm run test:watch  # 监听模式跑测试
```
