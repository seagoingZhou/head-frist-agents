import { describe, expect, it } from "vitest";
import type { Message, ToolResultMessage, UserMessage } from "pi-ai";

describe("protocol message shapes", () => {
  it("models a user message with text content", () => {
    const msg: UserMessage = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1_700_000_000_000
    };
    expect(msg.role).toBe("user");
    expect(msg.content).toHaveLength(1);
  });

  it("models a tool result bound to its tool call", () => {
    const msg: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read_file",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 1_700_000_000_001
    };
    expect(msg.toolName).toBe("read_file");
  });

  it("treats both shapes as Message", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: "c",
        toolName: "t",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 0
      }
    ];
    expect(messages.map((m) => m.role)).toEqual(["user", "toolResult"]);
  });
});
