import type {
    AssistantMessage,
    Context,
    StreamFunction
} from "../types.ts";
import {
    AssistantMessageEventStream
} from "../utils/event-stream.ts";
import {
    createAssistantMessage,
    messageText,
    text
} from "../message.ts";

/** 根据用户输入挑一个工作区文件（"agent" → agent-notes.md，否则 README.md） */
function pickFile(input: string): string {
  if (input.includes("agent")) return "agent-notes.md";
  return "README.md";
}

// 规则：第一版做「关键词 → toolCall + 看到 toolResult → 最终回答」两条闭环；
// 参考 how-pi-agent-works 的 MockModel（见 02-tool-system.md Step 1.2）。
function mockReply(context: Context): AssistantMessage {
  const last = context.messages[context.messages.length - 1];

  // ① 最后一条是 toolResult → 生成最终回答（stopReason 默认 "stop"，不再发 toolCall）
  if (last && last.role === "toolResult") {
    const output = messageText(last); // toolResult.content 是纯文本
    if (last.toolName === "read_file") {
      return createAssistantMessage([text(`我读取到了文件内容。关键内容如下：\n${output}`)]);
    }
    if (last.toolName === "write_note") {
      return createAssistantMessage([text(`笔记已经写入：${output}`)]);
    }
    return createAssistantMessage([text(`工具结果：${output}`)]);
  }

  // ② 用户输入命中关键词 → toolCall（name 必须与 coding-agent 里注册的 AgentTool.name 一致）
  if (last && last.role === "user") {
    const input = messageText(last).toLowerCase();
    // 读取优先于列出：避免"读取文件"被"文件"命中而误判为 list_files
    if (input.includes("读取") || input.includes("打开")) {
      return createAssistantMessage(
        [{ type: "toolCall", id: `call_${Date.now()}_read`, name: "read_file", arguments: { path: pickFile(input) } }],
        "toolUse",
      );
    }
    if (input.includes("列出") || input.includes("文件")) {
      return createAssistantMessage(
        [{ type: "toolCall", id: `call_${Date.now()}_list`, name: "list_files", arguments: { path: "." } }],
        "toolUse",
      );
    }
    if (input.includes("笔记") || input.includes("写")) {
      return createAssistantMessage(
        [{
          type: "toolCall",
          id: `call_${Date.now()}_write`,
          name: "write_note",
          arguments: {
            path: "agent-loop-note.md",
            content: "Agent Loop 工具闭环（mock 写入）", // write 工具要求 path + content，缺 content 会 throw
          },
        }],
        "toolUse",
      );
    }
  }

  // ③ 兜底：普通文本回复
  const input = last && last.role === "user" ? messageText(last) : "";
  return createAssistantMessage([text(`（mock 回复）你说：${input}`)]);
}


export const streamMock: StreamFunction<"mock"> = (model, context, options) => {
  const finalMessage = mockReply(context);
  const stream = new AssistantMessageEventStream();

  // 事件序列：start → (text_start/delta/end | toolcall_start/delta) → done
  stream.push({ type: "start", partial: finalMessage });
  finalMessage.content.forEach((block, contentIndex) => {
    if (block.type === "text") {
      stream.push({ type: "text_start", contentIndex, partial: finalMessage });
      stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: finalMessage });
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: finalMessage });
    } else if (block.type === "toolCall") {
      // 类型协议里没有 toolcall_end（见 01 方案 Step 8 提示），只发 start + delta
      stream.push({ type: "toolcall_start", contentIndex, partial: finalMessage });
      stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial: finalMessage });
    }
  });
  stream.push({
    type: "done",
    reason: finalMessage.stopReason === "toolUse" ? "toolUse" : "stop",
    message: finalMessage,
  });
  stream.end(finalMessage); // 兜底 resolve .result()

  return stream;
};