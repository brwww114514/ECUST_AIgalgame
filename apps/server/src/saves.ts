/**
 * 存档索引（issue #7）：`data/users/<safeUserId>/saves.json`。
 *
 * 为什么是"索引"而不是存档本体：世界状态的事件日志在 `data/rooms/`，这里只记
 * "这个账号玩过哪些房间、最后一次提交到哪"。删索引不删房间（玩家还能靠 roomId 回来）。
 * 目录名与 `FileImpressions` 一致地做 sha256 去重，避免 `a/b` 与 `a_b` 撞同一份文件。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** 与 docs/09 对齐的存档条目；`formatVersion` 只在破坏性变更时 +1 */
export interface SaveEntry {
  roomId: string;
  scenarioId: string;
  createdAt: number;
  updatedAt: number;
  lastTurnId: string;
  lastCommittedSeq: number;
  /**
   * 建房时服务端签发的房间内角色 id。
   * 3.3 之前的老存档没有这个字段，恢复时由前端从房间成员表兜底；新存档必须写。
   */
  actorId?: string;
  formatVersion: 1;
}

interface SavesFile {
  version: 1;
  userId: string;
  saves: SaveEntry[];
}

/** 单账号最多保留的存档数：只是索引，超了淘汰最久未更新的（房间本身不删） */
const MAX_SAVES = 100;

const savesFileSchema = z.object({
  version: z.literal(1),
  userId: z.string(),
  saves: z.array(z.object({
    roomId: z.string(),
    scenarioId: z.string(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    lastTurnId: z.string(),
    lastCommittedSeq: z.number().int().nonnegative(),
    actorId: z.string().optional(),
    formatVersion: z.literal(1),
  }).passthrough()),
}).passthrough();

export class SaveIndex {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 可读前缀 + sha256：既是单射（防穿越/防撞目录），又方便运维认人 */
  private file(userId: string): string {
    const readable = userId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24) || "u";
    const digest = createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 24);
    return path.join(this.root, `${readable}-${digest}`, "saves.json");
  }

  async list(userId: string): Promise<SaveEntry[]> {
    const file = await this.read(userId);
    return [...file.saves].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 建房登记：同一房间重复 upsert 时保留更早的 createdAt（幂等） */
  async upsert(userId: string, entry: SaveEntry): Promise<void> {
    await this.mutate(userId, (file) => {
      const existing = file.saves.find((s) => s.roomId === entry.roomId);
      if (existing) {
        if (entry.lastCommittedSeq < existing.lastCommittedSeq) return false;
        existing.scenarioId = entry.scenarioId;
        existing.updatedAt = entry.updatedAt;
        existing.lastTurnId = entry.lastTurnId;
        existing.lastCommittedSeq = entry.lastCommittedSeq;
        if (entry.actorId) existing.actorId = entry.actorId;
        return true;
      }
      file.saves.push(entry);
      file.saves.sort((a, b) => b.updatedAt - a.updatedAt);
      file.saves = file.saves.slice(0, MAX_SAVES);
      return true;
    });
  }

  /** 回合提交后推进游标。未登记的房间或迟到的较低序号返回 false。 */
  touch(userId: string, roomId: string, turnId: string, committedSeq: number): Promise<boolean> {
    return this.mutate(userId, (file) => {
      const entry = file.saves.find((s) => s.roomId === roomId);
      if (!entry || committedSeq < entry.lastCommittedSeq) return false;
      entry.lastTurnId = turnId;
      entry.lastCommittedSeq = committedSeq;
      entry.updatedAt = this.now();
      return true;
    });
  }

  /** 只删索引，不删房间：返回是否真的删掉了一条 */
  remove(userId: string, roomId: string): Promise<boolean> {
    return this.mutate(userId, (file) => {
      const before = file.saves.length;
      file.saves = file.saves.filter((s) => s.roomId !== roomId);
      return file.saves.length < before;
    });
  }

  private async read(userId: string): Promise<SavesFile> {
    let text: string;
    try {
      text = await readFile(this.file(userId), "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, userId, saves: [] };
      throw Object.assign(new Error("读取存档索引失败", { cause }), { code: "E_STORE_FAULT" });
    }
    try {
      // 任一条目损坏都中止，避免部分解析成功后把原始条目覆盖掉。
      const doc: SavesFile = savesFileSchema.parse(JSON.parse(text));
      if (doc.userId !== userId) throw new Error("存档索引归属不符");
      return doc;
    } catch (cause) {
      throw Object.assign(new Error("存档索引无效", { cause }), { code: "E_STORE_FAULT" });
    }
  }

  private mutate(userId: string, fn: (file: SavesFile) => boolean): Promise<boolean> {
    const prev = this.chains.get(userId) ?? Promise.resolve();
    const task = prev.then(async () => {
      const file = await this.read(userId);
      const changed = fn(file);
      if (changed) await this.write(userId, file);
      return changed;
    });
    this.chains.set(userId, task.catch(() => undefined));
    return task;
  }

  private async write(userId: string, file: SavesFile): Promise<void> {
    const target = this.file(userId);
    await mkdir(path.dirname(target), { recursive: true });
    // 先写临时文件再 rename：避免进程中断留下半截 JSON
    const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, JSON.stringify(file), "utf8");
    await rename(tmp, target);
  }
}
