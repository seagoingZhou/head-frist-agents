import type { Message, AssistantMessage, TextContent, ToolCall, UserMessage } from "pi-ai";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  totalTokens: 0,
};







export function text(value: string): TextContent {
    return { type: "text", text: value };
}

export function createUserMessage(input: string): UserMessage {
    return {
        role: "user",
        content: [text(input)],
        timestamp: Date.now()
    };
}

export function createAssistantMessage(
    content: AssistantMessage["content"],
    stopReason: AssistantMessage["stopReason"] = "stop",
) : AssistantMessage {
    return {
        role: "assistant",
        content,
        stopReason,
        usage: EMPTY_USAGE,
        timestamp: Date.now()
    };
}

export function messageText(message: { content: Array<TextContent | ToolCall> }): string {
    return message.content
    .filter(
        (block) => block.type === "text"
    )
    .map(
        (block) => block.text
    )
    .join("\n");
}
