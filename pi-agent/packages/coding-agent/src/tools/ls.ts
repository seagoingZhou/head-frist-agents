import { pathExists } from "./path-utils.ts";
import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { text } from "pi-ai";
import type { AgentTool } from "pi-agent-core";
import { WORKSPACE_ROOT } from "../utils/paths.ts";



const DEFAULT_LIMIT = 500;

export interface LsOperations {
    exists: (path: string) => Promise<boolean>;
    stat: (path: string) => Promise<{ isDirectory(): boolean }>;
    readdir: (path: string) => Promise<string[]>;
}

const defaultLsOperations: LsOperations = {
    exists : pathExists,
    stat: fsStat,
    readdir: fsReaddir,
}

 /** 返回给 LLM 的附加信息：目录条目数限制是否触发 */
export interface LsToolDetails {
    entryLimitReached?: number;   // 命中 limit 时记录条目数
}

export function createLsTool(
    workspaceRoot : string = WORKSPACE_ROOT,
    ops : LsOperations = defaultLsOperations,
): AgentTool {
    return {
        name: "list_files",
        label: "列出文件",
        description: "列出目录内容,目录名带 / 后缀,默认最多 500 条。",
        parameters: { type: "object", properties: { path: { type: "string" }, limit: {type: "number"} } },
        execute: async (_toolCallId, params) => {

            // ① 解析路径,缺省 "."
            const dirPath = join(workspaceRoot, (params.path as string || "."));

            // ② 存在性检查
            if (!(await ops.exists(dirPath))) {
                throw new Error(`Path not found: ${dirPath}`);
            }

            // ③ 必须是目录
            const stat = await ops.stat(dirPath);
            if (!stat.isDirectory()){
                throw new Error(`Not a directory: ${dirPath}`);
            }

            // ④ 读取目录条目
            let entries = await ops.readdir(dirPath);
            entries = entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())); // 大小写不敏感排序

            // ⑤ 截断
            const effectiveLimit = (params.limit as number) ?? DEFAULT_LIMIT;       // ⑤ 截断
            const results: string[] = [];
            let entryLimitReached = 0;
            for (const entry of entries) {
                if (results.length >= effectiveLimit) { entryLimitReached = entries.length; break; }
                let suffix = "";
                try {
                const entryStat = await ops.stat(join(dirPath, entry));            // 目录加 "/" 后缀
                if (entryStat.isDirectory()) suffix = "/";
                } catch { continue; }                                                // stat 不了就跳过该条
                results.push(entry + suffix);
            }

            const output = results.length === 0 ? "(empty directory)" : results.join("\n");
            return  {
                content : [text(output)],
                details : entryLimitReached > 0 ? { entryLimitReached } : {},
            }
        }
    }
}

export const lsTool: AgentTool = createLsTool();

