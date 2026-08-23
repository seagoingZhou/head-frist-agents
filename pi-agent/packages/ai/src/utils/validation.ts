import {Value} from "@sinclair/typebox/value";
import { Tool, ToolCall } from "pi-ai";

export function validateToolArguments(
    tool: Tool,
    toolCall: ToolCall
): any {
    const args = structuredClone(toolCall.arguments);
    const schema = tool.parameters as Record<string, unknown>;
    // Convert：数字/数组字符串化 → 真类型（含拆默认值）
    const converted = Value.Convert(schema as any, args) as Record<string, unknown>;

    // Validate：强校验
    const valid = Value.Check(schema as any, converted);
    if (!valid) {
        const first = Value.Errors(schema as any, converted).First();
        const error = `Invalid arguments for tool ${tool.name}: ${first?.message ?? "unknown"}`;
        throw new Error(error);
    }

    return converted;

}