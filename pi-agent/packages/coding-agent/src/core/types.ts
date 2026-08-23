import type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode } from "pi-agent-core";
import type { Tool } from "pi-ai";

/** 工具渲染/提示元数据类型（当前未接入 UI，仅占位）。 */
export type ToolRenderComponent = unknown;          // 渲染产物（占位，UI 未接入）
export type ToolRenderResultOptions = unknown;      // 结果渲染选项（占位，UI 未接入）
export interface ToolRenderContext {
    /* 渲染上下文（当前为空，UI 未接入） */
}

/** ToolDefinition.execute 第 5 参：工具可用的扩展上下文（当前仅提供 cwd）。 */
export interface ExtensionContext {
    cwd?: string;
}

/**
 * 工具定义：在基础工具契约上再携带系统提示元数据（promptSnippet/promptGuidelines）
 * 与 UI 渲染钩子（renderCall/renderResult），并让 execute 额外接收扩展上下文 ctx。
 * 核心循环只执行 AgentTool；本定义经 wrapToolDefinition 适配后再使用。
 * 系统提示/UI 字段当前未接入渲染。
 */
export interface ToolDefinition extends Tool {
    label: string;

    // 系统提示元数据（当前未用于生成系统提示）
    /** 系统提示里的一句话简介（不提供则默认省略自定义工具） */
    promptSnippet?: string;
    /** 系统提示里附加的说明点 */
    promptGuidelines?: string[];

    prepareArguments?: (args: unknown) => Record<string, unknown>;
    executionMode?: ToolExecutionMode;

    execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback,
        ctx?: ExtensionContext,       // 扩展上下文
    ): Promise<AgentToolResult>;

    // UI 渲染钩子（当前未接入渲染）
    /** 调用时渲染（未接入） */
    renderCall?: (args: Record<string, unknown>, context: ToolRenderContext) => ToolRenderComponent;
    /** 结果时渲染（未接入） */
    renderResult?: (result: AgentToolResult, options: ToolRenderResultOptions, context: ToolRenderContext) => ToolRenderComponent;
}