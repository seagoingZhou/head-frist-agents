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