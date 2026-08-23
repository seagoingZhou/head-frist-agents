import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { text } from "pi-ai";
import type { AgentTool } from "pi-agent-core";
import type { ToolDefinition } from "../core/types.ts";
import { type Static, Type } from "@sinclair/typebox";
import { WORKSPACE_ROOT } from "../utils/paths.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

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

/** details 里携带的信息（仿生产 read.ts:275：附加文件总行数） */
export interface ReadToolDetails {
  totalFileLines: number;
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
      return {
        content: [text(content)],
        details: { totalFileLines: content.split("\n").length } satisfies ReadToolDetails,
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
