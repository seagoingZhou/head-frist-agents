import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { text } from "pi-ai";
import type { AgentTool } from "pi-agent-core";
import { WORKSPACE_ROOT } from "../utils/paths.ts";

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
 * 教学版 read 工具（对应生产 createReadTool，见 pi/packages/coding-agent/src/core/tools/read.ts）。
 * 工厂 + Operations 注入：测试时可指向临时目录或委托远程文件系统。
 */
export function createReadTool(
  workspaceRoot: string = WORKSPACE_ROOT,
  ops: ReadOperations = defaultReadOperations,
): AgentTool {
  return {
    name: "read_file",
    label: "读取文件",
    description: "读取工作区文件内容。",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: async (_toolCallId, params) => {
      const path = params.path as string;
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

export const readTool: AgentTool = createReadTool();
