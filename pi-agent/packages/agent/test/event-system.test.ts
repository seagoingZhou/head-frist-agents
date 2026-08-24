import { describe, expect, it } from "vitest";
import { createUserMessage, type Message, type Model } from "pi-ai";
import { runAgentLoop, type AgentEventSink } from "../src/agent-loop.ts";
import type { AgentEvent } from "../src/types.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 教学/测试专用 mock model（config.model 用）。生产 src 不依赖它，故就地定义于测试。 */
const mockModel: Model<"mock"> = {
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

describe("事件驱动 —— 两条管道（emit 注入版）", () => {
  it("两管分叉 emit：同一事件源分流——管道 B 被 await、管道 A 不被等、两者都收到", async () => {
    const bHandlers = new Map<AgentEvent["type"], Array<(e: AgentEvent) => Promise<void> | void>>();
    const aListeners: Array<(e: AgentEvent) => void> = [];
    const bSeen: string[] = [];
    const aSeen: string[] = [];

    // 两管分叉 emit（== 生产 _handleAgentEvent:619/622）：
    // ① 管道 B：await（Agent 等扩展，返回值要读）
    // ② 管道 A：同步调、返回丢弃（Agent 不等）
    const emit: AgentEventSink = async (event) => {
      for (const handler of bHandlers.get(event.type) ?? []) {
        await handler(event);
        bSeen.push(event.type);
      }
      for (const listener of aListeners) {
        listener(event);
        aSeen.push(event.type);
      }
    };

    // 管道 B：agent_end 注册一个 40ms 的慢 handler
    const B_SLEEP = 40;
    bHandlers.set("agent_end", [async () => { await sleep(B_SLEEP); }]);
    // 管道 A：纯观察监听器
    aListeners.push(() => {});

    const t0 = performance.now();
    await runAgentLoop(
      [createUserMessage("你好")],
      { systemPrompt: "你是教学 Agent。", messages: [], tools: [] },
      { model: mockModel, convertToLlm: (m) => m as Message[] },
      emit,
    );
    const elapsed = performance.now() - t0;

    expect(bSeen).toContain("agent_end"); // 管道 B 收到
    expect(aSeen).toContain("agent_end"); // 管道 A 收到同一事件源
    expect(aSeen).toContain("turn_end");  // 管道 A 收到的是一整条流，不只收尾
    // ★ 等 B：agent_end 的 40ms 计入了 run 耗时（loop await 了两管分叉 emit）
    expect(elapsed).toBeGreaterThanOrEqual(B_SLEEP);
  });

  it("管道 A 不被等：慢的只读监听器（fire-and-forget）不拖慢 run 完成", async () => {
    const aListeners: Array<(e: AgentEvent) => void> = [];
    // 只走管道 A 的 emit：同步调、不等
    const emit: AgentEventSink = (event) => {
      for (const listener of aListeners) listener(event);
    };
    // 慢监听器：每次事件 fire-and-forget 一个 60ms 的异步操作
    aListeners.push(() => { void (async () => { await sleep(60); })(); });

    const t0 = performance.now();
    await runAgentLoop(
      [createUserMessage("你好")],
      { systemPrompt: "你是教学 Agent。", messages: [], tools: [] },
      { model: mockModel, convertToLlm: (m) => m as Message[] },
      emit,
    );
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(50); // 60ms 未被等 → run 秒回
  });
});