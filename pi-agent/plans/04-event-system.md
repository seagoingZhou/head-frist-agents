# 事件驱动设计：两条管道（session.subscribe vs 扩展 pi.on）

> 项目最终目标：实现生产版 pi agent。本方案为**事件驱动**——统一事件源 + 两条监听管道：管道 A（只读观察，Agent 不等）vs 管道 B（能拦截改写，Agent 等你）。
> 生产参考：`agent.ts:173/243`（listeners Set + subscribe）、`agent.ts:520-576`(processEvents 同步屏障)、`agent-session.ts:548-552`(_emit 同步不等)、`agent-session.ts:595-666`(_handleAgentEvent 两管分叉)、`agent-session.ts:712-793`(_emitExtensionEvent 翻译)、`extensions/runner.ts:796-828`(emit 通知型 try-catch)、`runner.ts:927-948`(emitToolCall 决策型无 catch)、`runner.ts:979-1010`(emitContext 链式)。

---

## 一、一句话：Pi 有两套监听,分水岭是「Agent 等不等你」

**管道 A `subscribe`**:只读观察。Agent 发完事件**不等**你的 listener,返回值丢弃。
**管道 B `pi.on`**:能拦截/改写。Agent **等** handler 返回,**读**返回值(如 `{ block: true }` 就拦)。

为什么有这个差别——因果直接:**要读返回值 → 所以必须等**。"能改 Agent 行为"是"等 + 读返回值"的结果,不是单独赋予的能力。

| | 管道 A subscribe | 管道 B pi.on |
|---|---|---|
| Agent 态度 | ✗ 不等,通知一声就走 | ✓ 等,读完返回值才走 |
| 返回值 | 丢弃(类型上 `void`) | 读取(block / 新消息 / 新上下文) |
| 异常 | async listener 错误被静默吞掉 | 多数 try-catch 隔离;tool_call 例外**
**（**在块内扩展崩了 → fail-closed,宁拦不放行**） |
| 用途 | 渲染、日志、SSE、统计 | 拦截危险工具、审计、注入上下文 |

---

## 二、现状清点(我们已有 vs 待建)

| 位置 | 现状 | 待建 |
|---|---|---|
| `agent/src/types.ts` | `AgentEvent` **已有 10 种生命周期事件**(agent/turn/message/tool_execution 各 start/update/end 配对 + compaction)——**事件源就绪** | 无 |
| `agent/src/types.ts:23` | `AgentEventSink = (event) => Promise<void> \| void` **已有**(emit 签名) | 无 |
| `agent/src/agent-loop.ts` | 事件全部 `stream.push(event)` 进 `EventStream`(拉取式输出) | 加**管道 A 的 push 订阅** + **管道 B 的 await 派发** |
| `agent` | 无 `Agent` 类 / `listeners Set` / `processEvents` | ●(教学版改用 EventStream + emitter 达成"等/不等") |
| `coding-agent` | 无 session 层、无扩展 runner | ✳ 新建 `core/extensions/runner.ts`(最小版)+ 事件桥 |
| 决策钩子 | **已有** `beforeToolCall`(tool_call 拦)、`afterToolCall`(tool_result 改)、`transformContext`(context 改) | 管道 B 决策事件直接挂在它们上 |

> 关键洞察:**管道 B 的 5 个决策点里,3 个我们五步管道已经实现了**(beforeToolCall / afterToolCall / transformContext)。所以教学版管道 B 不用重写执行系统,只需做一个「扩展 handler 注册 + 派发」runner,把这些钩子变成 pi.on 的落点。

---

## 三、事件源：10 种 AgentEvent(已有,不用改)

```
Agent ── agent_start/end
Turn  ── turn_start/end
Message ── message_start / message_update×N / message_end
ToolExec ── tool_execution_start / tool_execution_update×N / tool_execution_end
```
每层「开始 → 更新(×N) → 结束」配对 = 10 种。这是**两条管道的共同水源**——A 直接收、B 收翻译版。

**扩展独占的决策事件(不在 10 种里,管道 A 收不到)**：
| 事件 | 时机 | 挂哪个已有 hook |
|---|---|---|
| `tool_call` | 执行前,能 `block` | `beforeToolCall` |
| `tool_result` | 执行后,能改结果 | `afterToolCall` |
| `context` | 发 LLM 前,能改消息 | `transformContext` |
| `input` / `before_agent_start` | 后续阶段(本轮不做) | — |

---

## 四、管道 A：subscribe(只读观察,Agent 不等)

### 4.1 注册 / 注销 / 签名

```ts
const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_end") {
        console.log(`[LOG] ${event.toolName} ${event.isError ? "失败" : "成功"}`);
    }
});
unsubscribe();     // 注销
```

签名 `(event: AgentEvent) => void` —— **返回 void**:你 return 什么 Agent 都不读。类型层面就写死"只能看"。

### 4.2 在我们 repo 的落点：EventStream 是主通道,subscribe 是 push 旁路

教学版没有 `Agent` 类,`agentLoop()` 已返回 `EventStream<AgentEvent, AgentMessage[]>`(拉取式,消费方 `for await`)。管道 A 补两件事:

1. **保留 EventStream 为拉取通道**(消费者 `for await` / `result()`)。
2. **加 push 订阅**:`AgentLoopConfig` 增可选 `eventSink?: AgentEventSink`;loop 每次事件先 `stream.push(event)`(进拉取通道),再 `eventSink?.(event)`(**不等**、`void` 丢弃、`try/catch` 兜在调用方)——这就是管道 A。

```ts
// agent-loop.ts —— 每个 push 点旁（不等）
stream.push(event);
try { config.eventSink?.(event); } catch {}   // 管道 A：返回丢弃，不见 await
```

> "不等"立住:**把 eventSink 放在 `async` loop 里但不 `await` 它的返回**,listener 里干重活不拖慢 Agent。

### 4.3 管道 A 能收到的事件

10 种内核事件。`agent_settled / compaction_* / auto_retry_* / queue_update / session_info_changed / thinking_level_changed` 等产品级事件(压缩/重试/队列)属 session 层,教学版**本轮不做**——后续加 session 时再补。

---

## 五、管道 B：扩展系统 pi.on(能拦截改写,Agent 等你)

### 5.1 注册:`on` 只是往 Map push(对齐 loader.ts:238-243)

```ts
// 扩展：框架启动时调,把 pi 传进来
function myGuard(pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName === "delete_table") return { block: true, reason: "生产环境禁删" };
        return undefined;                         // 放行
    });
}
```

runner 里:

```ts
const handlers = new Map<string, Handler[]>();
function on(event: string, handler: Handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
}
```

### 5.2 三条派发路径(对齐 runner.ts)

**路径 1：通知型 `emit`(try-catch 隔离,返回值忽略但**仍 await**)**
处理 10 种事件 → 遍历 handler 串行 `await h(event, ctx)`,单个抛错 `catch` 转 `emitError` 不连累其它。**即使忽略返回值也 await**——这是"同步屏障"：等扩展处理完才发下一个事件,保证状态一致。

```ts
async emit(event) {
    for (const ext of this.extensions)
        for (const h of ext.handlers.get(event.type) ?? [])
            try { await h(event, this.ctx); } catch (e) { this.emitError(e); }
}
```

**路径 2：决策型 `emitToolCall`(读返回值,block 短路,★无 try-catch)**
```ts
async emitToolCall(event): Promise<ToolCallEventResult | undefined> {
    for (const ext of this.extensions)
        for (const h of ext.handlers.get("tool_call") ?? []) {
            const r = await h(event, ctx);
            if (r) { result = r; if (r.block) return r; }   // block 立即短路
        }
    return result;
}
```
无 try-catch 是刻意的 **fail-closed**：扩展在 tool_call 里崩了,宁可拦掉工具也不放行。

**路径 3：链式 transform(`emitContext` 等)**
每个 handler 拿上一个的输出继续改,最后一个的输出即真值(如 `AgentMessage[]` 发给 LLM)。`context` 走这个。

### 5.3 决策事件接到已有钩子上(不重写执行系统)

| pi.on 事件 | 落点 | 我们在五步管道已有 |
|---|---|---|
| `tool_call` | `beforeToolCall` 里 `await runner.emitToolCall(...)`,block → hook 返回 block | ✅ `prepareToolCall` 第 3 步 |
| `tool_result` | `afterToolCall` 里 `await runner.emitToolResult(...)`,返回覆盖 | ✅ `finalizeExecutedToolCall` 第 5 步 |
| `context` | `transformContext` 里 `await runner.emitContext(...)` 链式改消息 | ✅ `streamAssistantResponse` 前置 |

所以管道 B 的"干预能力" = **已实现的五步管道钩子 + 一个扩展 runner 把 pi.on handler 汇聚进去逐个 await**。

### 5.4 通知型事件到管道 B

10 种生命周期事件经 runner `emit`(路径 1)也喂给扩展(翻译版,await)。loop 的 `eventSink` 处:`await runner.emit(event)`(**等 B**)→ 再 `eventSink?.(event)`(不等 A)。这就是 `_handleAgentEvent` 的分叉。

---

## 六、分叉点：`_handleAgentEvent` 等价(两管在同一个事件上分流)

```ts
// agent-loop 里 emit 一个事件时：
async function emitEvent(emitter, event) {
    // ① 管道 B：等扩展（通知型 await / 决策型读返回值）
    await emitter.emitExtensionEvent(event);   // == 生产 agent-session.ts:619
    // ② 管道 A：不等
    stream.push(event);
    try { config.eventSink?.(event); } catch {} // == 生产 _emit:622
}
```

- 决策事件(tool_call/context/tool_result)不在这个循环里——它们在已有钩子里 await,见 5.3。
- **高频更新例外**(生产 executePreparedToolCall:666-707):`tool_execution_update` 攒着最后一次性 `Promise.all`——原则"越重要等得越严格"。教学版可先全部 await,留注释说明。

---

## 七、实战：两条管道各一例

**管道 A——日志**:
```ts
const stream = agentLoop(prompts, ctx, { model: mockModel, convertToLlm: (m) => m as Message[],
  eventSink: (e) => { if (e.type === "tool_execution_end") console.log(`[LOG] ${e.toolName} ${e.isError ? "失败" : "成功"}`); } });
```
**管道 B——拦截 delete_table**:
```ts
function guard(pi) { pi.on("tool_call", async (e) => e.toolName === "delete_table" ? { block: true, reason: "禁删" } : undefined); }
// beforeToolCall 里 await emitter.emitToolCall(...) → block → isError toolResult
```

**选管道一句话**:你的代码要不要改 Agent 行为——要,走 B(pi.on);不要,走 A(subscribe/eventSink)。

---

## 八、测试设计(`packages/agent/test/event-system.test.ts`)

| 用例 | 断言 |
|---|---|
| 管道 A：eventSink 收到 10 种事件 | 跑一次 mock 文本循环,eventSink 里收集 `agent_start/turn_start/message_*/turn_end/agent_end` ≥ 覆盖 |
| 管道 A 不等 | eventSink 里 `await` 一个延迟,断言 Agent 总耗时**不**因此变长(时序口径:事件顺序完整即可) |
| 管道 B：tool_call 拦截 | 扩展 `tool_call` return block → toolResult isError 含 reason,工具不执行 |
| 管道 B：context 改写 | `context` 里注入一条 user 消息 → LLM 收到(断言 mock 回复变化 / convertToLlm 输入) |
| 管道 B 通知型隔离 | 某 handler 抛错 → 其余 handler 仍执行、循环不崩 |
| tool_call 独占比对 | `subscribe`/eventSink **收不到** `tool_call`(两种管道事件集合不同) |

**现有 15+6=21 测试不回归**:改造只在 loop 内加 emit/eventSink/runner,不改既有 EventStream 语义、不改工具/消息类型。

---

## 九、实施步骤(分 Tier)

**Tier 1：管道 A + 管道 B 决策点(推荐先做这颗)**
1. `agent/types.ts`:无新事件类型;确认 `AgentEventSink` 已导出。
2. `agent-loop.ts`:加 `emitEvent` 封装——`stream.push` 后 `try { config.eventSink?.(event) } catch {}`;`AgentLoopConfig` 增 `eventSink?`。
3. `coding-agent/src/core/extensions/runner.ts`(新建):`ExtensionAPI`(`on`) + `ExtensionRunner`(`emit` 通知型 / `emitToolCall` 决策型 / `emitContext` 链式 / `emitError`)。
4. 桥:在 `agentLoop` 调用处用一个 adapter,把 runner 的 `tool_call` → `beforeToolCall`、`tool_result` → `afterToolCall`、`context` → `transformContext` 接上(测试里直接构造)。
5. 测试 event-system.test.ts 六条。

**Tier 2(后续)**:`input`/`before_agent_start` 决策点、产品级 session 事件、`tool_execution_update` 攒批、真实 session/扩展 loader(从工厂数组挂载,对齐 `DefaultResourceLoader`)。

---

## 十、常见坑

| 坑 | 症状 | 解法 |
|---|---|---|
| 在 eventSink 里 return 想拦 | 拦不住 | 管道 A 返回值丢弃;拦截必须走管道 B |
| async eventSink 里 await 失败 | 错误被静默吞 | 管道 A 自己 try-catch(Agent 不兜) |
| 把 `tool_call` 写进 eventSink | 分支永不命中 | `tool_call` 是管道 B 独占,管道 A 收不到 |
| 重活放 beforeToolCall 日志 | Agent 卡 | `beforeToolCall` 是决策钩子,会被 await——日志走管道 A |
| handler 抛错中断其它 handler | 一个崩全崩 | 通知型用 try-catch 隔离;tool_call 故意不隔离(fail-closed) |