/**
 * issue #7：存档索引（SaveIndex）的纯单元测试——目录隔离、幂等、游标推进、删除语义。
 * HTTP 层的登记/更新/只读本人/删除在 turn-history.test.ts 与 resume.e2e.test.ts 覆盖。
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tempDir } from "@galgame/testkit";
import { SaveIndex } from "./saves.ts";
import type { SaveEntry } from "./saves.ts";

function entry(overrides: Partial<SaveEntry> = {}): SaveEntry {
  return {
    roomId: "room_a",
    scenarioId: "transfer",
    createdAt: 100,
    updatedAt: 100,
    lastTurnId: "",
    lastCommittedSeq: 0,
    actorId: "plr_test",
    formatVersion: 1,
    ...overrides,
  };
}

describe("SaveIndex", () => {
  it("upsert 幂等：同房间重复登记不新增条目，保留最早 createdAt", async () => {
    const index = new SaveIndex(tempDir("galgame-saves-unit-"), () => 500);
    await index.upsert("u_a", entry());
    await index.upsert("u_a", entry({ scenarioId: "scholarship", lastCommittedSeq: 12 }));
    const list = await index.list("u_a");
    expect(list).toHaveLength(1);
    expect(list[0]?.createdAt).toBe(100);
    expect(list[0]?.scenarioId).toBe("scholarship");
    expect(list[0]?.lastCommittedSeq).toBe(12);
    expect(list[0]?.actorId).toBe("plr_test");
  });

  it("upsert 可以在旧条目上补写 actorId（老存档迁移）", async () => {
    const index = new SaveIndex(tempDir("galgame-saves-actor-"), () => 500);
    const legacy = entry();
    delete (legacy as { actorId?: string }).actorId;
    await index.upsert("u_a", legacy);
    await index.upsert("u_a", entry({ actorId: "plr_new" }));
    expect((await index.list("u_a"))[0]?.actorId).toBe("plr_new");
  });

  it("touch 推进 lastTurnId/lastCommittedSeq；索引里没有的房间返回 false（历史照记）", async () => {
    const index = new SaveIndex(tempDir("galgame-saves-touch-"), () => 900);
    await index.upsert("u_a", entry());
    expect(await index.touch("u_a", "room_a", "t1", 5)).toBe(true);
    expect(await index.touch("u_a", "room_missing", "t1", 5)).toBe(false);
    const list = await index.list("u_a");
    expect(list[0]).toMatchObject({ lastTurnId: "t1", lastCommittedSeq: 5, updatedAt: 900 });
  });

  it("touch 相同 seq 视为重放：返回 false，不刷新 updatedAt，也不改回合 ID", async () => {
    let now = 900;
    const index = new SaveIndex(tempDir("galgame-saves-replay-"), () => now);
    await index.upsert("u_a", entry());
    expect(await index.touch("u_a", "room_a", "t1", 5)).toBe(true);
    now = 950;
    // 重放同一回合（客户端重试 / 重复回调）：游标已在该 seq，不应把存档当成"刚更新过"
    expect(await index.touch("u_a", "room_a", "t1", 5)).toBe(false);
    expect((await index.list("u_a"))[0]).toMatchObject({
      lastTurnId: "t1", lastCommittedSeq: 5, updatedAt: 900,
    });
  });

  it("按 userId 隔离：u_b 看不到 u_a 的存档；remove 只删自己的", async () => {
    const index = new SaveIndex(tempDir("galgame-saves-iso-"));
    await index.upsert("u_a", entry());
    expect(await index.list("u_b")).toHaveLength(0);
    expect(await index.remove("u_b", "room_a")).toBe(false);
    expect(await index.remove("u_a", "room_a")).toBe(true);
    expect(await index.list("u_a")).toHaveLength(0);
  });

  it("列表按 updatedAt 降序", async () => {
    const root = tempDir("galgame-saves-sort-");
    const index = new SaveIndex(root);
    await index.upsert("u_a", entry({ roomId: "room_old", updatedAt: 10 }));
    await index.upsert("u_a", entry({ roomId: "room_new", updatedAt: 20 }));
    expect((await index.list("u_a")).map((s) => s.roomId)).toEqual(["room_new", "room_old"]);
  });

  it("同一账号的并发任务中，迟到的 touch 和 upsert 保留最新回合", async () => {
    const index = new SaveIndex(tempDir("galgame-saves-concurrent-"), () => 900);
    await index.upsert("u_a", entry());
    const [newer, older] = await Promise.all([
      index.touch("u_a", "room_a", "turn_new", 3),
      index.touch("u_a", "room_a", "turn_old", 2),
      index.upsert("u_a", entry({ lastTurnId: "turn_seed", lastCommittedSeq: 1 })),
    ]);
    expect([newer, older]).toEqual([true, false]);
    expect((await index.list("u_a"))[0]).toMatchObject({
      lastCommittedSeq: 3, lastTurnId: "turn_new", updatedAt: 900,
    });
  });

  it("损坏的索引保留原件，恢复文件后队列仍可写", async () => {
    const index = new SaveIndex(tempDir("galgame-saves-bad-"));
    await index.upsert("u_a", entry());
    const anyIndex = index as unknown as { file(userId: string): string };
    const file = anyIndex.file("u_a");
    const valid = await readFile(file, "utf8");
    for (const broken of ["{not json", JSON.stringify({
      version: 1, userId: "u_a", saves: [entry(), { roomId: "room_incomplete" }],
    })]) {
      await writeFile(file, broken);
      await expect(index.list("u_a")).rejects.toMatchObject({ code: "E_STORE_FAULT" });
      await expect(index.touch("u_a", "room_a", "turn_late", 5)).rejects.toMatchObject({ code: "E_STORE_FAULT" });
      await expect(index.remove("u_a", "room_a")).rejects.toMatchObject({ code: "E_STORE_FAULT" });
      await expect(index.upsert("u_a", entry())).rejects.toMatchObject({ code: "E_STORE_FAULT" });
      expect(await readFile(file, "utf8")).toBe(broken);
    }
    await writeFile(file, valid);
    expect(await index.touch("u_a", "room_a", "turn_recovered", 5)).toBe(true);
  });

  it("续写旧索引时保留合法 v1 文件的额外字段", async () => {
    const index = new SaveIndex(tempDir("galgame-saves-extensions-"));
    await index.upsert("u_a", entry());
    const anyIndex = index as unknown as { file(userId: string): string };
    const file = anyIndex.file("u_a");
    await writeFile(file, JSON.stringify({
      version: 1, userId: "u_a", extension: "index",
      saves: [{ ...entry(), extension: "entry" }],
    }));
    await index.touch("u_a", "room_a", "turn_new", 5);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      extension: "index", saves: [{ extension: "entry", lastCommittedSeq: 5 }],
    });
  });

  it("不同 userId 的可读前缀相同也不会写到同一文件（sha256 后缀去重）", async () => {
    const root = tempDir("galgame-saves-sha-");
    const index = new SaveIndex(root);
    await index.upsert("a/b", entry({ roomId: "room_slash" }));
    await index.upsert("a_b", entry({ roomId: "room_underscore" }));
    expect((await index.list("a/b")).map((s) => s.roomId)).toEqual(["room_slash"]);
    expect((await index.list("a_b")).map((s) => s.roomId)).toEqual(["room_underscore"]);
    const anyIndex = index as unknown as { file(userId: string): string };
    expect(anyIndex.file("a/b")).not.toBe(anyIndex.file("a_b"));
    expect(path.basename(anyIndex.file("a/b"))).toBe("saves.json");
  });
});
