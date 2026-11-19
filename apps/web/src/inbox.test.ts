import { describe, expect, it } from "vitest";
import type { GossipEvent, MessageRecord } from "../../../packages/shared/src/contract/v2.ts";
import {
  applyGossipEvent,
  applyGossipEvents,
  claimSend,
  confidencePercent,
  formatCreatedAt,
  inboxLoadNotice,
  kindLabel,
  mergeMessages,
  parseGossipMessageEvent,
  sendErrorNotice,
  visibleFor,
} from "./inbox.ts";

function rec(id: string, seq: number, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id,
    roomId: "room_1",
    from: "plr_me",
    to: "npc_lin",
    kind: "player",
    content: "你好",
    hop: 0,
    confidence: 1,
    visibility: "private",
    createdAt: 1_700_000_000_000 + seq,
    seq,
    ...overrides,
  };
}

describe("收件箱去重（SSE 重连会重放）", () => {
  it("按 message.id 去重，重复重放不新增记录", () => {
    const first = [rec("m1", 1), rec("m2", 2)];
    const replay = [rec("m2", 2), rec("m3", 3)];
    const merged = mergeMessages(first, replay);
    expect(merged.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("按 seq 稳定排序，且不修改原数组", () => {
    const a = [rec("m2", 2), rec("m1", 1)];
    const out = mergeMessages(a, [rec("m0", 0)]);
    expect(out.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
    expect(a.map((m) => m.id)).toEqual(["m2", "m1"]);
  });

  it("同一 id 先出现的记录胜出（GET 权威列表不被 SSE 覆盖）", () => {
    const out = mergeMessages([rec("m1", 1, { content: "权威" })], [rec("m1", 1, { content: "重放" })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe("权威");
  });

  it("applyGossipEvent 只投影 gossip.message", () => {
    const base = [rec("m1", 1)];
    const added = applyGossipEvent(base, { type: "gossip.message", message: rec("m2", 2) });
    expect(added.map((m) => m.id)).toEqual(["m1", "m2"]);
    const noop: GossipEvent = { type: "gossip.committed", ids: ["m9"] };
    expect(applyGossipEvent(added, noop).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("applyGossipEvents 批量并入 POST 返回的 events，仍按 id 去重", () => {
    const events: GossipEvent[] = [
      { type: "gossip.message", message: rec("m1", 1) },
      { type: "gossip.message", message: rec("m2", 2) },
      { type: "gossip.committed", ids: ["m1", "m2"] },
    ];
    expect(applyGossipEvents([], events).map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});

describe("SSE 事件边界解析", () => {
  it("gossip.message 通过 zod 校验后返回 MessageRecord", () => {
    const data = JSON.stringify({ type: "gossip.message", message: rec("m1", 5) });
    expect(parseGossipMessageEvent(data)).toMatchObject({ id: "m1", seq: 5, kind: "player" });
  });

  it("非 gossip.message 事件 / 坏 JSON / 缺字段都返回 null", () => {
    expect(parseGossipMessageEvent(JSON.stringify({ type: "gossip.committed", ids: [] }))).toBeNull();
    expect(parseGossipMessageEvent("not json")).toBeNull();
    expect(parseGossipMessageEvent(JSON.stringify({ type: "gossip.message", message: { id: "x" } }))).toBeNull();
  });
});

describe("private 可见性（只对收发双方渲染）", () => {
  it("只保留自己是 from/to 的消息，第三方私信不下发到界面", () => {
    const all = [
      rec("m1", 1, { from: "plr_me", to: "npc_lin" }),
      rec("m2", 2, { from: "npc_lin", to: "plr_me", kind: "gossip" }),
      rec("m3", 3, { from: "npc_lin", to: "npc_yan" }),
    ];
    expect(visibleFor(all, "plr_me").map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(visibleFor(all, "")).toEqual([]);
  });
});

describe("发送防抖（连点只产生一条）", () => {
  it("首次放行，500ms 内连点被拒，且被拒的点击不续期锁", () => {
    const first = claimSend({ lastClaimAt: 0 }, 10_000);
    expect(first.allowed).toBe(true);
    const second = claimSend(first.next, 10_100);
    expect(second.allowed).toBe(false);
    expect(second.next.lastClaimAt).toBe(10_000);
    const third = claimSend(second.next, 10_600);
    expect(third.allowed).toBe(true);
  });

  it("锁的边界：刚好到 lockMs 放行", () => {
    const lock = { lastClaimAt: 1000 };
    expect(claimSend(lock, 1499, 500).allowed).toBe(false);
    expect(claimSend(lock, 1500, 500).allowed).toBe(true);
  });
});

describe("提示文案", () => {
  it("审核拦截 / 审核不可用给专门提示", () => {
    expect(sendErrorNotice("E_CONTENT_BLOCKED")).toContain("审核拦截");
    expect(sendErrorNotice("E_AUDIT_UNAVAILABLE")).toContain("审核服务");
    expect(sendErrorNotice("E_OTHER")).toContain("E_OTHER");
  });

  it("403 是降级提示，500 不误判为越权", () => {
    expect(inboxLoadNotice(403)).toContain("没有权限");
    expect(inboxLoadNotice(400)).toContain("缺少身份");
    expect(inboxLoadNotice(500)).toBeNull();
  });

  it("kind / confidence / 时间展示", () => {
    expect(kindLabel("gossip")).toBe("八卦");
    expect(kindLabel("reply")).toBe("回复");
    expect(confidencePercent(0.73)).toBe("73%");
    expect(confidencePercent(2)).toBe("100%");
    expect(formatCreatedAt(0)).not.toBe("");
  });
});
