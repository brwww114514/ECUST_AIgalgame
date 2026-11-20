import { mkdir, open, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Envelope } from "../../shared/src/contract/types.ts";

/** rename 已执行，但无法确认目录项的持久性；原操作可能已经生效。 */
export class StoreCommitUnknownError extends Error {
  readonly code = "E_STORE_FAULT";

  constructor(cause: unknown) {
    super("房间日志可能已写入，目录同步失败。请核对存档后再继续。", { cause });
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class RoomLogWriter {
  private ready?: Promise<void>;
  private createdRoot?: string;

  constructor(private readonly directory: string) {}

  private ensureDirectory(): Promise<void> {
    this.ready ??= this.prepareDirectory().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async prepareDirectory(): Promise<void> {
    const created = await mkdir(this.directory, { recursive: true });
    this.createdRoot ??= created;
    if (!this.createdRoot) return;

    // 首次建目录时，每级新目录的名字也要在父目录里持久化。
    const last = path.dirname(path.resolve(this.createdRoot));
    let parent = path.dirname(path.resolve(this.directory));
    while (parent !== last) {
      await syncDirectory(parent);
      parent = path.dirname(parent);
    }
    await syncDirectory(last);
  }

  async write(file: string, events: readonly Envelope[]): Promise<void> {
    await this.ensureDirectory();
    const temporary = `${file}.tmp`;
    const body = events.map((event) => JSON.stringify(event) + "\n").join("");
    // 先打开目录：权限或句柄故障应尽量在替换原日志前暴露。
    const directory = await open(this.directory, "r");
    try {
      await writeFile(temporary, body, { encoding: "utf8", flush: true });
      await rename(temporary, file);
      try {
        await directory.sync();
      } catch (cause) {
        throw new StoreCommitUnknownError(cause);
      }
    } finally {
      // 关闭报错不会改变已得到的 sync 结果，也不能盖掉上面的写入错误。
      await directory.close().catch((error: unknown) => console.error("[store] 关闭日志目录失败", error));
    }
  }
}
