import { describe, expect, it } from "vitest";
import { createUserMessage, type EventStream, type Message, type Model } from "pi-ai";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentMessage } from "../src/types.ts";

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

/** 把事件压成一行可读文本（只打关键字段，避免刷屏） */
function summarize(event: AgentEvent): string {
  switch (event.type) {
    case "message_start":
    case "message_end":
      return `${event.type}(${event.message.role})`;
    case "message_update":
      return `message_update(${event.message.role})`;
    case "turn_end":
      return `turn_end(toolResults=${event.toolResults.length})`;
    case "agent_end":
      return `agent_end(messages=${event.messages.length})`;
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return `${event.type}(${event.toolName})`;
    default:
      return event.type;
  }
}

/** 消费整个事件流并打印轨迹，最后返回 result()（即 newMessages） */
async function consumeWithLogging(
  stream: EventStream<AgentEvent, AgentMessage[]>,
  label: string,
): Promise<AgentMessage[]> {
  console.log(`\n===== ${label} =====`);
  for await (const event of stream) {
    console.log(`  [event] ${summarize(event)}`);
  }

  const newMessages = await stream.result();
  console.log(`  [roles] ${JSON.stringify(newMessages.map((m) => m.role))}`);
  for (const m of newMessages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      console.log(`  [assistant] ${text}`);
    }
  }
  return newMessages;
}

function buildStream(prompt: string, history?: { messages: AgentMessage[] }) {
  return agentLoop(
    [createUserMessage(prompt)],
    {
      systemPrompt: "你是教学 Agent。",
      messages: history?.messages ?? [],
      tools: [],
    },
    { model: mockModel, convertToLlm: (messages) => messages as Message[] },
  );
}

describe("agent loop with mock model —— provider 分发（Level 2）", () => {
  it("普通文本 → 返回 assistant 文本，roles=[user, assistant]", async () => {
    const newMessages = await consumeWithLogging(buildStream("你好"), "普通文本：你好");
    expect(newMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(newMessages[1].content[0].type).toBe("text");
  });

  it("带历史的 context → 正常追加回复", async () => {
    const newMessages = await consumeWithLogging(
      buildStream("再来一次", {
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
      }),
      "带历史：再来一次",
    );
    expect(newMessages.at(-1)?.role).toBe("assistant");
  });
});
