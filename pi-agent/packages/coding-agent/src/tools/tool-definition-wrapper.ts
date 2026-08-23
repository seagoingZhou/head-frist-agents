import type { AgentTool } from "pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "../core/types.ts";

/** 把工具定义适配成 AgentTool 供核心循环执行；定义上的系统提示/渲染元数据不进入运行时。 */
export function wrapToolDefinition(
    definition: ToolDefinition,
    ctxFactory?: () => ExtensionContext,
): AgentTool {
    return {
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: definition.parameters,
        prepareArguments: definition.prepareArguments,
        executionMode: definition.executionMode,
        execute: (toolCallId, params, signal, onUpdate) =>
            // 传入工具定义需要的扩展上下文（execute 的第 5 参只在这里补）
            definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.()),
    };
}

/** 依次把多个定义适配成 AgentTool。 */
export function wrapToolDefinitions(
    definitions: ToolDefinition[],
    ctxFactory?: () => ExtensionContext,
): AgentTool[] {
    return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/** 从 AgentTool 合成最小工具定义（无系统提示/渲染元数据），便于统一按定义持有。 */
export function createToolDefinitionFromAgentTool(tool: AgentTool): ToolDefinition {
    return {
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        prepareArguments: tool.prepareArguments,
        executionMode: tool.executionMode,
        execute: async (toolCallId, params, signal, onUpdate) =>
            tool.execute(toolCallId, params, signal, onUpdate),
    };
}