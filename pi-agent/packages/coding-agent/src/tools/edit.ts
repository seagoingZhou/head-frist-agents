import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { text } from "pi-ai";
import type { AgentTool } from "pi-agent-core";
import { WORKSPACE_ROOT } from "../utils/paths.ts";

export interface EditOperations {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
    access: (path: string) => Promise<void>;
}

const defaultEditOperations : EditOperations = {
    readFile: (path) =>fsReadFile(path, "utf-8"),
    writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
    access: (path) => fsAccess(path),
}

export function createEditTool(
    workspaceRoot: string = WORKSPACE_ROOT,
    ops: EditOperations = defaultEditOperations
): AgentTool {
    return {
        name: "edit_file",
        label: "编辑文件",
        description: "用精确文本替换修改文件（oldText 必须在文件中唯一）。",
        parameters: {
            type: "object",
            properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } },
            required: ["path", "oldText", "newText"],
        },
        execute: async(_toolCallId, params) => {
            const path = params.path as string;
            const oldText = params.oldText as string;
            const newText = (params.newText as string) ?? "";

            // ① 解析绝对路径
            const absolutePath = join(workspaceRoot, path);
            // ② 逃逸守卫（写类工具最危险：挡住 ../ 越出 workspace，照抄 write.ts 三行）
            const relatedPath = relative(workspaceRoot, absolutePath);
            if (relatedPath.startsWith("..") || isAbsolute(relatedPath)) {
                throw new Error(`Edit path escapes workspace: ${path}`);
            }

            // ③ 存在性检查（access 失败会 throw → loop catch 成 isError）
            await ops.access(absolutePath);

            // ④ 读原文 + 匹配校验
            const content = await ops.readFile(absolutePath);
            if (!oldText) {
                throw new Error("oldText must not be empty");
            }
            const index = content.indexOf(oldText);
            if (index === -1) {
                throw new Error(`oldText not found in ${path}`);
            }
            if (content.indexOf(oldText, index + 1) !== -1) {
                throw new Error(`oldText is not unique in ${path}`);
            }

            // ⑤ 替换 + 写回
            const newContent = content.slice(0, index) + newText + content.slice(index + oldText.length);
            await ops.writeFile(absolutePath, newContent);

            // ⑥ 返回（仿生产 edit.ts:330：错误信息带路径）
            return {
                content : [text(`Successfully replaced 1 block in ${path}`)],
                details : {},
            }
        }
    }
}

export const editTool: AgentTool = createEditTool();

