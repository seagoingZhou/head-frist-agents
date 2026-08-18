import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { text } from "pi-ai";
import type { AgentTool } from "pi-agent-core";
import { WORKSPACE_ROOT } from "../utils/paths.ts";

export interface WriteOperations {
    writeFile: (path: string, content: string) => Promise<void>;
    mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
    writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
    mkdir: (dir) => fsMkdir(dir, {recursive : true}).then(() => {}),
}

export function createWriteTool(
    workspaceRoot : string = WORKSPACE_ROOT,
    operates : WriteOperations = defaultWriteOperations,
): AgentTool {
    return {
        name : "write_note",   // ⚠️ 必须与 mock 的 toolCall.name 一致，见下
        label : "写入文件",
        description : "写入文件内容，自动创建父目录。",
        parameters : {
            type : "object",
            properties : {
                path : {type : "string"},
                content : {type : "string"},
            },
        },
        execute: async(_toolCallId, params) => {
            const path = params.path as string;
            const content = params.content as string;

            // ① 路径安全：解析 + 阻止逃逸出 workspace（写工具最危险的洞）
            const absolutePath = resolve(workspaceRoot, path);
            const relativePath = relative(workspaceRoot, absolutePath);
            if (relativePath.startsWith("..") || isAbsolute(relativePath)){
                throw new Error(`Write path escapes workspace: ${path}`);
            }


            // ② 自动创建父目录（仿生产：先 mkdir 再 write）
            await operates.mkdir(dirname(absolutePath))

            // ③ 写入（失败会 throw → 由 loop 第 4 步 catch 成 isError）
            await operates.writeFile(absolutePath, content);

            return {
                content: [text(`Successfully wrote ${content.length} bytes to ${path}`)],
                details: {},
            }
        }

    }
}

export const writeTool: AgentTool = createWriteTool()