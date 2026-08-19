import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUserMessage, type Message, type Model, type TextContent, type ToolCall } from "pi-ai";
import { agentLoop } from "../src/agent-loop.ts";
import { readTool, writeTool, lsTool, editTool } from "../../coding-agent/src/index.ts";

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

const tools = [readTool, writeTool, lsTool, editTool];

function run(prompt: string) {
  return agentLoop(
    [createUserMessage(prompt)],
    { systemPrompt: "你是教学 Agent。", messages: [], tools },
    { model: mockModel, convertToLlm: (m) => m as Message[] },
  );
}

/** 取最后一条 assistant 的纯文本（拼接 text block） */
function assistantText(messages: Message[]): string {
  const last = messages.at(-1)!;
  return (last.content as Array<TextContent | ToolCall>)
    .filter((b) => b.type === "text")
    .map((b) => (b as TextContent).text)
    .join("");
}

describe("工具闭环 —— 阶段一", () => {
  it("读取 agent-notes.md → read_file → 工具执行事件 → 最终回答含文件内容", async () => {
    const stream = run("读取 agent-notes.md");
    const events: string[] = [];
    for await (const event of stream) {
      if (event.type === "tool_execution_start") events.push(`tool_start:${event.toolName}`);
      if (event.type === "tool_execution_end") events.push(`tool_end:${event.toolName}`);
    }
    expect(events).toContain("tool_start:read_file");
    expect(events).toContain("tool_end:read_file");

    const newMessages = await stream.result();
    // prompts(user) + assistant(toolCall) + toolResult + assistant(最终回答)
    expect(newMessages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(assistantText(newMessages)).toContain("我读取到了文件内容");
    expect(assistantText(newMessages)).toContain("Agent Loop"); // agent-notes.md 内容
  });

  it("列出工作区文件 → list_files → 事件 + 四段 roles", async () => {
    const stream = run("列出工作区文件");
    const events: string[] = [];
    for await (const event of stream) {
      if (event.type === "tool_execution_start") events.push(event.toolName);
    }
    expect(events).toContain("list_files");
    const newMessages = await stream.result();
    expect(newMessages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    const toolResult = newMessages.find((m) => m.role === "toolResult")!;
    expect(toolResult.toolName).toBe("list_files");
    expect(toolResult.isError).toBe(false);
  });

  it("写笔记 → write_note → 文件真实落盘到临时工作区（不污染真实 workspace）", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-loop-write-"));
    try {
      // 用 createWriteTool 指向 tmp 的工厂：createWriteTool 通过 coding-agent 导出
      const { createWriteTool } = await import("../../coding-agent/src/index.ts");
      const writeToolTmp = createWriteTool(tmp);

      const stream = agentLoop(
        [createUserMessage("写笔记")],
        { systemPrompt: "你是教学 Agent。", messages: [], tools: [writeToolTmp] },
        { model: mockModel, convertToLlm: (m) => m as Message[] },
      );
      const newMessages = await stream.result();
      expect(newMessages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
      expect(assistantText(newMessages)).toContain("笔记已经写入");

      // mock 的 write_note 固定写入 agent-loop-note.md
      const written = await readFile(join(tmp, "agent-loop-note.md"), "utf-8");
      expect(written).toContain("Agent Loop");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
