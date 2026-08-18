# Mock Model + 基本 Agent Loop 实现方案

> 项目最终目标：实现生产版 pi agent（源码参考 `/Users/zhouzhou/Program/AICoding/pi/packages`）。
> 本方案用 **mock model**（不调用真实 LLM API）先跑通基本 Agent Loop。
> 当前版本：**Level 2（provider 分发）** + **先只做文本回复**（工具闭环留到后续步骤）。

---

## 当前进度（2026-08-18）

- ✅ **已完成**：Step 0-8 + 第一批集成测试（文本回复的 mock 端到端链路 + assistant 流式事件转发，typecheck exit 0、8/8 测试通过）
- ⏳ 待完成：工具闭环（关键词→toolCall、`executeToolCalls`、`AgentTool`）

---

## 一、方案概述

```
agentLoop(prompts, context, config, signal?, streamFn?)
   └─ streamFn || streamSimple          ← streamFn 不传时走 pi-ai 分发
        └─ streamSimple(model, ctx, options)
             └─ stream()  →  switch(model.api)
                  ├─ case "openai-completions" → streamOpenAICompletions
                  └─ case "mock"              → streamMock   ← 新增
                       └─ 返回 AssistantMessageEventStream
                            （start → text_* → done，end() resolve result）
```

**第一版最小目标**：用户发一条文本 → mock 返回一条文本回复 → 结束。
`agentLoop(...).result()` 返回 `newMessages`，roles 期望：`['user', 'assistant']`。

---

## 二、已确定的关键决策

| 决策点 | 结论 |
|---|---|
| mock 集成方式 | **Level 2**：注册为 provider，走 `streamSimple` 分发（对齐生产） |
| 第一版范围 | **只做文本回复**，工具调用分支留注释占位 |
| mock 接口 | 按生产契约写 **StreamFunction**（产出事件流），不是教学的 `complete()` |
| 参考逻辑 | `how-pi-agent-works/examples/teaching-agent/src/server/agent/mockModel.ts` 的关键词规则（后续复用） |

---

## 三、实施步骤

> ✅ Step 0-8 均已实施并通过验证（Step 8 由本人实现：`streamAssistantResponse` 改为 `for await` 转发流式事件）。

### Step 0：基线检查

先确认当前是干净的基线：

```bash
npm run typecheck && npm test
```

预期：typecheck exit 0；测试 1 文件 / 3 用例通过。
（若这一步就报错，先修好再往下。）

---

### Step 1：实现 `EventStream`（最大阻塞项）

**文件**：`packages/ai/src/utils/event-stream.ts`

**原因**：当前 `push`/`end`/`[Symbol.asyncIterator]` 全是空壳，`result()` 的 promise 永远不 resolve。
不实现它，`agentLoop` 会永久挂死在 `await response.result()`。

以下代码 = 当前 `event-stream.ts` 的**实际实现**（`waiting` 字段类型保持骨架原样）：

```ts
async *[Symbol.asyncIterator](): AsyncIterator<T> {
  while (true) {
    if (this.queue.length > 0) {
      yield this.queue.shift()!;
    } else if (this.done) {
      return;
    } else {
      // 队列空且未结束 → 挂起一个等待者，由 push/end 唤醒并直接传入结果
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
      if (result.done) {
        return;                          // 被 end() 唤醒 → 退出迭代
      }
      yield result.value;
    }
  }
}

push(event: T): void {
  if (this.done) return;
  if (this.isComplete(event)) {          // ① 完成事件优先：标记结束 + resolve result()
    this.done = true;
    this.resolveFinalResult(this.extractResult(event));
  }
  const waiter = this.waiting.shift();
  if (waiter) {
    waiter({ value: event, done: false });  // ② 有等待者 → 直接把事件交给它
  } else {
    this.queue.push(event);                 // ③ 无等待者 → 入队
  }
}

end(result?: R): void {
  this.done = true;
  if (result !== undefined) {
    this.resolveFinalResult(result);        // 兜底 resolve（幂等，与完成事件 resolve 不冲突）
  }
  while (this.waiting.length > 0) {
    const waiter = this.waiting.shift()!;
    waiter({ value: undefined as any, done: true });   // 唤醒所有等待者并标记结束
  }
}

result(): Promise<R> {
  return this.finalResultPromise;
}
```

**实现要点**（对齐实际代码）：
- `push` 的顺序：**先**判 `isComplete`（done/error 事件 → 置 `done=true` + `resolveFinalResult(extractResult(event))`），**再**把事件交给等待者（`waiter({ value: event, done: false })`）或入队。
- `[Symbol.asyncIterator]`：队列有货 yield；没货且未结束 → `new Promise<IteratorResult<T>>` 挂起，等 push / end 唤醒；被唤醒后若 `result.done` 则 `return` 退出迭代。
- `end`：置 `done=true`，若传入 `result` 则兜底 resolve（Promise 重复 resolve 是 no-op，与完成事件 resolve 不冲突），再唤醒所有等待者（`{ value: undefined, done: true }`）让迭代器退出。

> ✅ 初版的两个隐患已修复：迭代器被 `end()` 唤醒时正确 `return`（不再多吐 `undefined`）；`end(result?)` 会兜底 resolve `result()`。

**验证**：
```bash
npm run typecheck && npm test
```
预期：仍全绿（现有测试还没消费流，不应受影响）。

---

### Step 2：`types.ts` 加入 `"mock"`

**文件**：`packages/ai/src/types.ts`

1. `Api` 加字面量：

```ts
export type Api =
	| "openai-completions"
	| "mock"
	;
```

2. `ApiOptionsMap` 加条目（**值取 `StreamOptions` 本身**，否则下方 exhaustiveness 检查会编译失败）：

```ts
export interface ApiOptionsMap {
	"openai-completions": OpenAICompletionsOptions;
	"mock": StreamOptions;
}
```

**验证**：
```bash
npm run typecheck
```
预期：exit 0。若报 `_CheckExhaustive` 相关的 tuple 错误，说明 `"mock"` 的 options 类型比 `StreamOptions` 窄，改回 `StreamOptions`。

---

### Step 3：`stream.ts` 分发 mock + 绕过 apiKey 门槛

**文件**：`packages/ai/src/stream.ts`

1. 顶部加 import（**用 `.ts` 后缀**，与 `types.ts` 等一致；早期 `.js` 后缀是笔误，不要用）：

```ts
import { streamMock } from "./providers/mock.ts";
```

2. 让 mock 通过 key 检查——**不改 `streamSimple` / `stream` 的分发处**（不要硬编码 `model.api !== "mock"`），而是**改 `getEnvApiKey`**：给 mock provider 返回一个占位 key，下游通用的 `if (!apiKey) throw` 就自然放行：

```ts
export function getEnvApiKey(provider: any): string | undefined {
	// mock provider 不需要真实 key，但要让下游通用的 key 检查通过
	if (provider === "mock") {
		return "mock-key";
	}

	// ...其余逻辑保持不动
}
```

这样 `streamSimple` / `stream` 里现有的 key 检查**一行不用改**，mock 也能过。

3. `switch` 加 case：

```ts
switch (api) {
	case "mock":
		return streamMock(model as Model<"mock">, context, providerOptions as OptionsForApi<"mock">);

	case "openai-completions":
		return streamOpenAICompletions(model as Model<"openai-completions">, context, providerOptions as any);

	// ...其余 case 保持不动
}
```

**验证**：
```bash
npm run typecheck
```
预期：exit 0（此时 `streamMock` 还不存在会报错——下一步先建出来即可，或按顺序先做 Step 5）。

> 提示：如果先做本步，`streamMock` 未定义会报 TS2305。**建议 Step 3 和 Step 5 一起做完再验证。**

---

### Step 4：`model.ts` 定义 `mockModel`

**文件**：`packages/ai/src/model.ts`（当前是空文件）

```ts
import type { Model } from "./types.ts";

export const mockModel: Model<"mock"> = {
  id: "mock",
  name: "Mock Model",
  api: "mock",
  provider: "mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};
```

若 `provider` 字段报错，说明 `Provider` 类型是封闭的，把 `"mock"` 加进 `KnownProvider` 或 `Provider` 联合即可。

**验证**：`npm run typecheck` → exit 0。

---

### Step 5：新建 `providers/mock.ts`

**文件**：`packages/ai/src/providers/mock.ts`（新建）

```ts
import type { AssistantMessage, Context, StreamFunction } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { createAssistantMessage, messageText, text } from "../message.ts";

// 规则：第一版只做文本回复；工具调用分支留作后续（参考 how-pi-agent-works 的 MockModel）
function mockReply(context: Context): AssistantMessage {
  const last = context.messages[context.messages.length - 1];
  const input = last && last.role === "user" ? messageText(last) : "";
  // TODO(后续)：
  //   包含"列出"/"文件" → list_files toolCall
  //   包含"读取"/"打开" → read_file toolCall
  //   包含"笔记"/"写"   → write_note toolCall
  //   最后一条是 toolResult → 返回最终回答
  return createAssistantMessage([text(`（mock 回复）你说：${input}`)]);
}

export const streamMock: StreamFunction<"mock"> = (model, context, options) => {
  const finalMessage = mockReply(context);
  const stream = new AssistantMessageEventStream();

  // 事件序列：start → text_start → text_delta → text_end → done
  stream.push({ type: "start", partial: finalMessage });
  finalMessage.content.forEach((block, contentIndex) => {
    if (block.type === "text") {
      stream.push({ type: "text_start", contentIndex, partial: finalMessage });
      stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: finalMessage });
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: finalMessage });
    }
  });
  stream.push({ type: "done", reason: "stop", message: finalMessage });
  stream.end(finalMessage); // 兜底 resolve .result()

  return stream;
};
```

要点：
- `StreamFunction<"mock">` 的类型签名来自 `types.ts`，写法参照现有 `openai-completions.ts`。
- `createAssistantMessage` / `messageText` / `text` 来自 `message.ts`，现成可用。
- mock 忽略 `model` 和 `options`（不真正联网）。

**验证**：
```bash
npm run typecheck
```
预期：exit 0。

---

### Step 6：新建 agent 测试

**文件**：`packages/agent/test/agent-loop.test.ts`（新建，含 `packages/agent/test/` 目录）

```ts
import { describe, expect, it } from "vitest";
import { createUserMessage, type Message } from "pi-ai";
import { agentLoop } from "../src/agent-loop.ts";
import { mockModel } from "../../ai/src/model.ts";
import { streamMock } from "../../ai/src/providers/mock.ts";

describe("agent loop with mock model", () => {
  it("runs a text-only turn and returns user + assistant", async () => {
    const stream = agentLoop(
      [createUserMessage("你好")],
      {
        systemPrompt: "你是教学 Agent。",
        messages: [],
        tools: [],
      },
      {
        model: mockModel,
        convertToLlm: (messages) => messages as Message[],
      },
      undefined,          // signal
      streamMock,         // streamFn：显式传入 mock，绕过分发（先验证链路）
    );

    const newMessages = await stream.result();
    expect(newMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});
```

**验证**：
```bash
npm test
```
预期：4 个用例通过（原有 3 + 新增 1）。

> 若要验证 **provider 分发路径**（不传 `streamFn`，走 `streamSimple` → `case "mock"`），把第 5 个参数删掉再跑一次：
> `agentLoop(prompts, ctx, config)`——此时 `config.model` 必须是 `mockModel`（`api:"mock"`）。

---

### Step 7：整体验证

```bash
npm run typecheck   # exit 0
npm test            # 全部通过
```

**完整验收清单**：
- [x] `npm run typecheck` → exit 0
- [x] `npm test` → 5/5 通过（types.test.ts 3 + agent-loop.test.ts 2）
- [x] 新测试断言 `['user', 'assistant']` 成立
- [x] 走 `streamSimple` → `case "mock"` 分发路径（测试不传 `streamFn`）

---

### Step 8（✅ 已完成）：转发 assistant 流式事件（message_update）

> 已于 2026-08-18 实现并通过验证：`npm run typecheck` exit 0、`npm test` 8/8 通过。实现与下方改法一致，验证输出见本节末尾。

**目标**：让 agent 事件流能看到 assistant 的**产生过程**——`message_start` → `message_update`（每次增量）→ `message_end`，而不仅是最终结果。当前集成测试只看到 `message_start/end(user)`，assistant 是「凭空出现」的。

**文件**：`packages/agent/src/agent-loop.ts`（`streamAssistantResponse`）

**现状**：拿到 `response` 后直接 `await response.result()`，mock 事件流被丢弃。

**改法**（参照生产 `pi/packages/agent/src/agent-loop.ts:187`）：改为 `for await` 遍历事件流并转发：

```ts
const response = await streamFunction(config.model, llmContext);

let partialMessage: AssistantMessage | null = null;
let addedPartial = false;

for await (const event of response) {
    switch (event.type) {
        case "start":
            partialMessage = event.partial;
            context.messages.push(partialMessage);
            addedPartial = true;
            stream.push({ type: "message_start", message: { ...partialMessage } });
            break;

        case "text_start":
        case "text_delta":
        case "text_end":
        case "thinking_start":
        case "thinking_delta":
        case "thinking_end":
        case "toolcall_start":
        case "toolcall_delta":
            if (partialMessage) {
                partialMessage = event.partial;
                context.messages[context.messages.length - 1] = partialMessage;
                stream.push({
                    type: "message_update",
                    assistantMessageEvent: event,
                    message: { ...partialMessage },
                });
            }
            break;

        case "done":
        case "error": {
            const finalMessage = await response.result();
            if (addedPartial) {
                context.messages[context.messages.length - 1] = finalMessage;
            } else {
                context.messages.push(finalMessage);
            }
            if (!addedPartial) {
                stream.push({ type: "message_start", message: { ...finalMessage } });
            }
            stream.push({ type: "message_end", message: finalMessage });
            return finalMessage;
        }
    }
}

return await response.result();
```

**要点**：
- 事件类型来自 `types.ts` 的 `AssistantMessageEvent`（`start` / `text_*` / `thinking_*` / `toolcall_*` / `done` / `error`）。**没有 `toolcall_end`**（生产有，我们的类型还没加）——switch 里别写这个 case。
- `message_update` 要求 `assistantMessageEvent: event`（原始流事件）+ `message: { ...partialMessage }`（快照拷贝，避免共享同一对象引用）。
- `context.messages` 就地更新（最后一条替换成 partial）；`runLoop` 仍用返回的 `finalMessage` push 到 `newMessages`，对外行为不变。
- `event.partial` 始终是**截至当前的完整 assistant 消息**，所以每次 delta 都整份转发。
- 注意：mock 发出 `text_start → text_delta → text_end` 三个独立事件，每个各触发一次转发，所以实际会看到 **3 次 `message_update`**（早期预期轨迹把这里略写成了 1 次，是文档笔误，实现行为正确）。

**验证（✅ 已通过）**：`npm run typecheck` exit 0 + `npm test` 8/8。集成测试输出从：
```
  [event] message_end(user)
  [event] turn_end(toolResults=0)     ← assistant 凭空出现
```
变为（assistant 不再凭空出现）：
```
  [event] message_end(user)
  [event] message_start(assistant)    ← 新增
  [event] message_update(assistant)   ← 新增 ×1（text_start）
  [event] message_update(assistant)   ← 新增 ×2（text_delta）
  [event] message_update(assistant)   ← 新增 ×3（text_end）
  [event] message_end(assistant)      ← 新增
  [event] turn_end(toolResults=0)
```

---

## 四、预期运行轨迹（文本版）

```
agentLoop(["你好"], ctx, {model: mockModel, ...})
  agent_start
  turn_start
  message_start/end(user)
  streamSimple(mockModel, ctx) → case "mock" → streamMock
    事件流: start → text_start → text_delta("（mock 回复）你说：你好") → text_end → done
  response.result() → assistant(文本, stopReason:"stop")
  message_start/end(assistant)
  turn_end
  agent_end
  stream.end(newMessages)
result() → ['user', 'assistant']
```

---

## 五、Mock 模型集成测试用例

> mock 的集成测试通过 `agentLoop` 驱动（真实走 loop → `streamSimple` → `case "mock"` → `streamMock`），**不依赖任何真实 API / API key**。
> 分两批：**第一批（文本回复）✅ 已落地**；**第二批（工具闭环）⏳ 待落地**。

### 第一批：文本回复（✅ 已落地）

测试文件 `packages/agent/test/agent-loop.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createUserMessage, type Message } from "pi-ai";
import { agentLoop } from "../src/agent-loop.ts";
import { mockModel } from "../../ai/src/model.ts";
import { streamMock } from "../../ai/src/providers/mock.ts";

function run(prompt: string) {
  return agentLoop(
    [createUserMessage(prompt)],
    { systemPrompt: "你是教学 Agent。", messages: [], tools: [] },
    { model: mockModel, convertToLlm: (m) => m as Message[] },
    undefined, // signal
    streamMock, // streamFn
  ).result();
}

describe("agent loop with mock model —— 文本回复", () => {
  it("普通文本 → 返回 assistant 文本，roles=[user, assistant]", async () => {
    const newMessages = await run("你好");
    expect(newMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(newMessages[1].content[0].type).toBe("text");
  });

  it("带历史的 context → 正常追加回复", async () => {
    const stream = agentLoop(
      [createUserMessage("再来一次")],
      {
        systemPrompt: "你是教学 Agent。",
        messages: [
          createUserMessage("第一次"),
          {
            role: "assistant",
            content: [{ type: "text", text: "第一次回复" }],
            stopReason: "stop",
            usage: { input: 0, output: 0, totalTokens: 0 },
            timestamp: 0,
          },
        ],
        tools: [],
      },
      { model: mockModel, convertToLlm: (m) => m as Message[] },
      undefined,
      streamMock,
    );
    const newMessages = await stream.result();
    expect(newMessages.at(-1)?.role).toBe("assistant");
  });
});
```

### 第二批：工具闭环（⏳ 待落地）

前提：`mockReply` 已加关键词→toolCall 规则；`executeToolCalls` 已实现；3 个 `AgentTool` 已定义。

```ts
import { text } from "pi-ai";
import type { AgentTool } from "../src/types.ts";

const tools: AgentTool[] = [
  {
    name: "list_files", description: "列出文件。", parameters: { type: "object" }, label: "列出文件",
    execute: async () => ({ content: [text("README.md")], details: {} }),
  },
  {
    name: "read_file", description: "读取文件。", parameters: { type: "object" }, label: "读取文件",
    execute: async () => ({ content: [text("# 标题\n内容")], details: {} }),
  },
  {
    name: "write_note", description: "写笔记。", parameters: { type: "object" }, label: "写笔记",
    execute: async () => ({ content: [text("已写入 agent-loop-note.md")], details: {} }),
  },
];

function runWithTools(prompt: string) {
  return agentLoop(
    [createUserMessage(prompt)],
    { systemPrompt: "你是教学 Agent。", messages: [], tools },
    { model: mockModel, convertToLlm: (m) => m as Message[] },
    undefined,
    streamMock,
  ).result();
}

describe("agent loop with mock model —— 工具闭环", () => {
  it("列出工作区文件 → turn1 toolCall(list_files) → turn2 最终回答", async () => {
    const newMessages = await runWithTools("列出工作区文件");
    // 生产版 newMessages 含 prompts，所以是 ['user','assistant','toolResult','assistant']，
    // 包含你期望的 ['assistant','toolResult','assistant'] 子序列
    expect(newMessages.map((m) => m.role)).toEqual([
      "user", "assistant", "toolResult", "assistant",
    ]);
    const [, assistant1, toolResult, assistant2] = newMessages;
    expect(assistant1.content[0]).toMatchObject({ type: "toolCall", name: "list_files" });
    expect(toolResult.toolName).toBe("list_files");
    expect(assistant2.content[0]).toMatchObject({ type: "text" });
  });

  it("读取文件 → read_file 工具调用闭环", async () => {
    const newMessages = await runWithTools("读取文件");
    const [, assistant1] = newMessages;
    expect(assistant1.content[0]).toMatchObject({ type: "toolCall", name: "read_file" });
  });

  it("写笔记 → write_note 工具调用闭环", async () => {
    const newMessages = await runWithTools("写笔记");
    const [, assistant1] = newMessages;
    expect(assistant1.content[0]).toMatchObject({ type: "toolCall", name: "write_note" });
  });
});
```

**「列出」用例的期望事件序列**：
```
turn1:  agent_start, turn_start, message_start/end(user)
        assistant toolCall(list_files) → message_start/end
        tool_execution_start → tool_execution_end → message_start/end(toolResult)
turn2:  turn_start → assistant(文本最终回答) → message_start/end
        turn_end → agent_end → stream.end(newMessages)
```

---

## 六、后续步骤（工具闭环，下一轮）

1. `mockReply` 补上关键词 → toolCall 规则（list_files / read_file / write_note，参考 how-pi-agent-works 的 `MockModel`）。
2. `agent-loop.ts` 实现 `executeToolCalls`（当前是注释掉的空 stub；生产实现参考 `/Users/zhouzhou/Program/AICoding/pi/packages/agent/src/agent-loop.ts:277`）。
3. 定义 3 个 `AgentTool`（`list_files`/`read_file`/`write_note`，类型 `AgentTool extends Tool { label, execute }`）。
4. 启用「五、第二批」的集成测试（工具闭环），断言 roles `['user', 'assistant', 'toolResult', 'assistant']`。

---

## 七、常见坑

| 坑 | 症状 | 解法 |
|---|---|---|
| `result()` 永久不返回 | 测试超时 | `EventStream` 没实现 / 没推 `done` 事件 / 没调 `end()` |
| mock 被拦 | `No API key for provider: mock` | `stream.ts` 的 key 检查要 `model.api !== "mock"` 才执行 |
| exhaustiveness 编译失败 | `_CheckExhaustive` 相关报错 | `ApiOptionsMap["mock"]` 必须是 `StreamOptions`（或其超类型），别用更窄的类型 |
| `convertToLlm` 缺失 | config 类型报错 | `AgentLoopConfig.convertToLlm` 是必填，测试里要提供 |
| `mockModel` 缺字段 | `Model` 类型报错 | 按 `Model<"mock">` 补全必填字段（typecheck 会列出缺哪些） |
