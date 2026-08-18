import { join } from "node:path";

/** pi-agent 根目录下的 workspace 工作区（工具读写安全根） */
export const WORKSPACE_ROOT = join(import.meta.dirname, "../../../../workspace");