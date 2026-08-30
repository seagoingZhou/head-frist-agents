import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { text } from "pi-ai";
import type { AgentTool } from "pi-agent-core";
import type { ToolDefinition } from "../types.ts";
import { type Static, Type } from "@sinclair/typebox";
import { WORKSPACE_ROOT } from "../../utils/paths.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

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

const ReplaceEditSchema = Type.Object({
    oldText: Type.String({
        description:
            "要替换的精确文本。它在原始文件中必须唯一，且不能与同一调用中其它 edits[].oldText 的区间重叠。",
    }),
    newText: Type.String({ description: "一次定向替换的替换文本。" }),
}, { additionalProperties: false });

const EditSchema = Type.Object({
    path: Type.String({ description: "要编辑的文件路径（相对工作区的路径）。" }),
    edits: Type.Array(ReplaceEditSchema, {
        description:
            "一个或多个精确替换。每个 edit 都基于原始内容匹配（不做增量套用）；oldText 不得重叠或嵌套，相邻的两处改动建议合并成一条 edit。",
    }),
}, { additionalProperties: false });
type EditParams = Static<typeof EditSchema>;

export type EditToolInput = Static<typeof EditSchema>;

type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

/**
 * 参数预处理：把 LLM 给的参数整理成 execute 的标准形态 { path, edits[] }。
 *
 * 处理两种不标准输入：
 *  - 旧形态：顶层 { oldText, newText } → 折叠成 edits[] 一项（并剔除旧字段，否则 schema 拒）
 *  - edits 被序列化成 JSON 字符串 → 解析回数组
 * 其余的（正常 edits[] / null / 非对象）原样返回，交由后续 TypeBox validate 判断。
 */
function prepareEditArguments(input: unknown): Record<string, unknown> {
    // ① 非对象 → 原样返回（null / undefined / 字符串 / 数字）
    if (!input || typeof input !== "object") {
        return input as Record<string, unknown>;
    }
    const args = input as Record<string, unknown>;

    // ② edits 若是 JSON 字符串 → parse 回数组（解析失败静默，交给 validate）
    if (typeof args.edits === "string") {
        try {
            const parsed = JSON.parse(args.edits);
            if (Array.isArray(parsed)) {
                args.edits = parsed;
            }
        } catch {}
    }

    // ③ 旧形态折叠：顶层有字符串 oldText + newText → 并入 edits[]，并剔除顶层这两个字段
    const legacy = args as LegacyEditToolInput;
    if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
    return args as EditToolInput;
    }
    const edits = Array.isArray(legacy.edits) ?
                    [...legacy.edits]:
                    [];
    edits.push(
        {
            oldText: legacy.oldText,
            newText: legacy.newText,
        }
    )
    const {oldText: _oldText, newText: _newText, ...reset} = legacy;
    
    // ④ 返回整理后的参数
    return {...reset, edits} as EditToolInput;;
}


export function createEditToolDefinition(
    workspaceRoot: string = WORKSPACE_ROOT,
    ops: EditOperations = defaultEditOperations
): ToolDefinition {
    return {
        name: "edit_file",
        label: "编辑文件",
        description: "对文件做一处或多处精确文本替换（每个 oldText 在原始文件中唯一且互不重叠，可一次改多处）。",
        parameters: EditSchema as Record<string, unknown>,
        // 系统提示/UI 字段：当前未接入渲染，仅占位
        promptSnippet: "编辑工作区文件",
        renderCall: () => undefined,
        renderResult: () => undefined,
        prepareArguments: prepareEditArguments,
        execute: async(_toolCallId, params, _signal, _onUpdate, _ctx) => {
            const { path, edits } = params as EditParams;

            // ① 解析绝对路径
            const absolutePath = join(workspaceRoot, path);
            // ② 逃逸守卫（写类工具最危险：挡住 ../ 越出 workspace，照抄 write.ts 三行）
            const relatedPath = relative(workspaceRoot, absolutePath);
            if (relatedPath.startsWith("..") || isAbsolute(relatedPath)) {
                throw new Error(`Edit path escapes workspace: ${path}`);
            }

            // ③ 存在性检查（access 失败会 throw → loop catch 成 isError）
            await ops.access(absolutePath);

            // ④ 读原文 + 在【原始内容】上逐条定位 edits（生产契约：每个 oldText 匹配原文，不做增量套用）
            const original = await ops.readFile(absolutePath);
            if (edits.length === 0) {
                throw new Error("edits must contain at least one replacement");
            }
            type Replacement = { start: number; end: number; newText: string };
            const replacements: Replacement[] = [];
            for (const edit of edits) {
                if (!edit.oldText) {
                    throw new Error("oldText must not be empty");
                }
                const start = original.indexOf(edit.oldText);
                if (start === -1) {
                    throw new Error(`oldText not found in ${path}`);
                }
                if (original.indexOf(edit.oldText, start + 1) !== -1) {
                    throw new Error(`oldText is not unique in ${path}`);
                }

                const end = start + edit.oldText.length;
                // 非重叠校验：新区间与已收集的任一区间相交即拒（相邻不算重叠）
                if (replacements.some((o) => start < o.end && o.start < end)) {
                    throw new Error(`edits overlap in ${path}`);
                }
                replacements.push({ start, end, newText: edit.newText });
            }

            // ⑤ 逆序套用：先改后面的位置，避免索引漂移（所有位置都对原始原文定位）
            let result = original;
            for (let i = replacements.length - 1; i >= 0; i--) {
                const r = replacements[i];
                result = result.slice(0, r.start) + r.newText + result.slice(r.end);
            }
            await ops.writeFile(absolutePath, result);

            // ⑥ 返回（仿生产 edit.ts:330：错误信息带路径；成功消息带替换块数）
            return {
                content: [text(`Successfully replaced ${replacements.length} block(s) in ${path}`)],
                details: {},
            }
        }
    }
}

export const editToolDefinition: ToolDefinition = createEditToolDefinition();

/** 返回可直接交给 agent loop 执行的 edit_file 工具（AgentTool 形态）。 */
export function createEditTool(
    workspaceRoot: string = WORKSPACE_ROOT,
    ops: EditOperations = defaultEditOperations,
): AgentTool {
    return wrapToolDefinition(createEditToolDefinition(workspaceRoot, ops));
}

export const editTool: AgentTool = createEditTool();

