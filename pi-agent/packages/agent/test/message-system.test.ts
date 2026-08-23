import { describe, expect, it } from "vitest";
import { createUserMessage, type AssistantMessage, type Message, type Model, type TextContent, type UserMessage } from "pi-ai";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentMessage } from "../src/types.ts";
import { convertToLlm } from "../../coding-agent/src/core/messages.ts";

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

describe("消息系统 —— 内富外严（AgentMessage → Message）", () => {
  it("声明合并：AgentMessage 已纳入自定义消息（编译期 + 运行时构造）", () => {
    const bash: AgentMessage = {
      role: "bashExecution", command: "ls -la", output: "a.txt", exitCode: 0,
      cancelled: false, truncated: false, timestamp: 0,
    };
    const compact: AgentMessage = {
      role: "compactionSummary", summary: "旧对话摘要", tokensBefore: 100, timestamp: 0,
    };
    expect(bash.role).toBe("bashExecution");
    expect(compact.role).toBe("compactionSummary");
  });

  it("bashExecution → user，文本含命令与输出", () => {
    const out = convertToLlm([
      { role: "bashExecution", command: "ls", output: "a.txt\nb.txt", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 },
    ]);
    expect(out).toHaveLength(1);
    const u = out[0] as UserMessage;
    expect(u.role).toBe("user");
    const text = (u.content[0] as TextContent).text;
    expect(text).toContain("Ran `ls`");
    expect(text).toContain("a.txt\nb.txt");
  });

  it("excludeFromContext=true → 过滤掉，LLM 不可见", () => {
    const out = convertToLlm([
      { role: "bashExecution", command: "!!secret", output: "SECRET", exitCode: 0, cancelled: false, truncated: false, timestamp: 0, excludeFromContext: true },
    ]);
    expect(out).toHaveLength(0);
  });

  it("摘要类（compaction/branchSummary）→ user，文本被 <summary> 包裹", () => {
    const out = convertToLlm([
      { role: "compactionSummary", summary: "旧对话摘要", tokensBefore: 10, timestamp: 0 },
      { role: "branchSummary", summary: "分支摘要", fromId: "b1", timestamp: 1 },
    ]);
    expect(out).toHaveLength(2);
    const c = (out[0] as UserMessage).content[0] as TextContent;
    expect(c.text).toContain("<summary>");
    expect(c.text).toContain("旧对话摘要");
    expect(c.text).toContain("</summary>");
    const b = (out[1] as UserMessage).content[0] as TextContent;
    expect(b.text).toContain("分支摘要");
  });

  it("标准消息（user/assistant/toolResult）原样透传（同一引用）", () => {
    const standard: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "reply" }], stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0 }, timestamp: 0 },
      { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "res" }], isError: false, timestamp: 0 },
    ];
    const out = convertToLlm(standard);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(standard[0]);
    expect(out[1]).toBe(standard[1]);
    expect(out[2]).toBe(standard[2]);
  });

  it("端到端：agentLoop 注入自定义消息 + 默认 convertToLlm → 闭环照跑", async () => {
    const stream = agentLoop(
      [createUserMessage("接下来")],
      {
        systemPrompt: "你是教学 Agent。",
        messages: [
          createUserMessage("你好"),
          { role: "bashExecution", command: "ls", output: "a.txt", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 },
        ],
        tools: [],
      },
      { model: mockModel, convertToLlm },
    );
    const newMessages = await stream.result();
    expect(newMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const last = newMessages.at(-1)! as AssistantMessage;
    expect(last.content[0].type).toBe("text");
  });
});