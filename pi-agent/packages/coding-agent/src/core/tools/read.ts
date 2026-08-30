import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { text } from "pi-ai";
import type { AgentTool } from "pi-agent-core";
import type { ToolDefinition } from "../types.ts";
import { type Static, Type } from "@sinclair/typebox";
import { WORKSPACE_ROOT } from "../../utils/paths.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { truncateHead } from "./truncate.ts";

const ReadSchema = Type.Object({
  path: Type.String({ description: "要读取的文件路径（相对工作区的路径）。" }),
});
type ReadInput = Static<typeof ReadSchema>;

export interface ReadOperations {
    readFile: (path: string) => Promise<string>;
    access: (path: string) => Promise<void>;
}

const defaultReadOperations: ReadOperations = {
  readFile: (path) => fsReadFile(path, "utf-8"),
  access: (path) => fsAccess(path),
};

/** details 里携带的信息（仿生产 read.ts:275：附加文件总行数；05 上下文工程加截断信息） */
export interface ReadToolDetails {
  /** 原始文件总行数 */
  totalFileLines: number;
  /** 是否被截断（超 2000 行或 50KB，双限制先触者胜） */
  truncated?: boolean;
  /** 由哪个限制触发："lines" | "bytes" */
  truncatedBy?: "lines" | "bytes" | null;
  /** 截断后的输出行数 */
  outputLines?: number;
}

/**
 * 创建 read_file 工具定义：读取工作区文件内容，返回纯文本与文件总行数。
 * 工厂支持注入工作区根与文件系统操作（测试可指向临时目录或远程 fs）。
 */
export function createReadToolDefinition(
  workspaceRoot: string = WORKSPACE_ROOT,
  ops: ReadOperations = defaultReadOperations,
): ToolDefinition {
  return {
    name: "read_file",
    label: "读取文件",
    description: "读取工作区文件内容。",
    parameters: ReadSchema as Record<string, unknown>,
    // 系统提示/UI 字段：当前未接入渲染，仅占位
    promptSnippet: "读取工作区文件",
    renderCall: () => undefined,
    renderResult: () => undefined,
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const { path } = params as ReadInput;
      const absolute = join(workspaceRoot, path);
      await ops.access(absolute); // 存在性检查
      const content = await ops.readFile(absolute);
      // 上下文工程"输入侧①减法"：read 保留开头（truncateHead，2000 行/50KB 双限制、UTF-8 安全）
      const trunc = truncateHead(content);
      // 截断是有损的但不偷偷干：追加逃生提示，告诉 LLM 只看了前 N 行、还剩多少
      const output = trunc.truncated
        ? `${trunc.content}\n\n[Showing first ${trunc.outputLines} of ${trunc.totalLines} lines. Output truncated.]`
        : content;
      return {
        content: [text(output)],
        details: {
          totalFileLines: trunc.totalLines,
          truncated: trunc.truncated,
          truncatedBy: trunc.truncatedBy,
          outputLines: trunc.outputLines,
        } satisfies ReadToolDetails,
      };
    },
  };
}

export const readToolDefinition: ToolDefinition = createReadToolDefinition();

/** 返回可直接交给 agent loop 执行的 read_file 工具（AgentTool 形态）。 */
export function createReadTool(
    workspaceRoot: string = WORKSPACE_ROOT,
    ops: ReadOperations = defaultReadOperations,
): AgentTool {
    return wrapToolDefinition(createReadToolDefinition(workspaceRoot, ops));
}

export const readTool: AgentTool = createReadTool();
