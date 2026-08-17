import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWriteTool } from "../../src/tools/write.ts";

describe("write tool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pi-write-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("写入文件并读回验证（真实落盘）", async () => {
    const tool = createWriteTool(tmp);
    const content = "hello 写入工具";

    const result = await tool.execute("call_1", { path: "note.md", content });

    // 返回值：成功消息含字节数
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain(String(content.length));

    // 读回磁盘验证
    const onDisk = await readFile(join(tmp, "note.md"), "utf-8");
    expect(onDisk).toBe(content);
  });

  it("自动创建父目录", async () => {
    const tool = createWriteTool(tmp);

    await tool.execute("call_2", { path: "sub/dir/note.md", content: "x" });

    const onDisk = await readFile(join(tmp, "sub/dir/note.md"), "utf-8");
    expect(onDisk).toBe("x");
  });

  it("拒绝逃逸出 workspace 的路径（../）", async () => {
    const tool = createWriteTool(tmp);

    await expect(
      tool.execute("call_3", { path: "../outside.md", content: "x" }),
    ).rejects.toThrow("Write path escapes workspace");

    // 守卫在写之前抛错，所以 workspace 内不应有任何文件
    await expect(readFile(join(tmp, "outside.md"), "utf-8")).rejects.toThrow();
  });
});
