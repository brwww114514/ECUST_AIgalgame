import { describe, expect, it } from "vitest";
import type { Delivery, SceneBeat } from "../../../packages/shared/src/contract/v2.ts";
import {
  DEFAULT_LISTEN_TIMEOUT_MS,
  deliveryParts,
  groupDeliveriesByUtterance,
  initialConversationView,
  insertSceneBeat,
  isListeningExpired,
  linesFromView,
  reduceConversationView,
  viewerParts,
} from "./conversation-view.ts";
import type { ConversationView, ReduceCtx } from "./conversation-view.ts";

const ME = "plr_me";
const NPC = "npc_lin";

function delivery(over: Partial<Delivery> = {}): Delivery {
  return {
    to: ME,
    speaker: NPC,
    utteranceId: "u1",
    mode: "broadcast",
    channels: ["content"],
    content: "大家好",
    action: "林雨环顾四周",
    notice: "这句话是对你说的",
    ...over,
  };
}

function beat(id: string, order: SceneBeat["order"], text: string): SceneBeat {
  return { id, kind: "summary", roomId: "room_1", text, createdAt: 1, order };
}

const ctx = (): ReduceCtx => {
  let n = 100;
  return { selfActorId: ME, now: 1_000, lineId: () => ++n };
};

function lineState(lines: ConversationView["lines"]): ConversationView {
  return { ...initialConversationView(), lines };
}

describe("deliveryParts：只渲染 channels 列出的部分，不拿原文兜底", () => {
  it("channels 只列 content 时，即便有 action/notice 字段也不渲染", () => {
    expect(deliveryParts(delivery({ channels: ["content"] }))).toEqual([
      { channel: "content", text: "大家好" },
    ]);
  });

  it("三通道齐全时按 content/action/notice 顺序渲染", () => {
    expect(deliveryParts(delivery({ channels: ["notice", "action", "content"] }))).toEqual([
      { channel: "content", text: "大家好" },
      { channel: "action", text: "林雨环顾四周" },
      { channel: "notice", text: "这句话是对你说的" },
    ]);
  });

  it("通道存在但字段缺失/空串 → 不产生片段（signal 无 content）", () => {
    const d = delivery({ channels: ["content", "action"], content: undefined, action: "" });
    expect(deliveryParts(d)).toEqual([]);
  });

  it("whisper/signal 对非目标只有 action 通道 → 只出 action，不推测内容", () => {
    const d = delivery({ mode: "whisper", channels: ["action"], content: undefined, notice: undefined });
    expect(deliveryParts(d)).toEqual([{ channel: "action", text: "林雨环顾四周" }]);
  });

  it("addressed 的「对 X 说」走 notice 通道", () => {
    const parts = deliveryParts(delivery({ channels: ["content", "notice"], notice: "这句话是对阿哲说的" }));
    expect(parts).toContainEqual({ channel: "notice", text: "这句话是对阿哲说的" });
  });
});

describe("归组：同一 utteranceId 只算一句", () => {
  it("多条 Delivery 按 utteranceId 归组，viewerParts 只取自己的且去重", () => {
    const mine = delivery({ utteranceId: "u7", channels: ["content"], content: "只有我看得到" });
    const other = delivery({ to: "plr_other", utteranceId: "u7", channels: ["content"], content: "别人的" });
    const dup = delivery({ utteranceId: "u7", channels: ["content"], content: "只有我看得到" });
    const groups = groupDeliveriesByUtterance([mine, other, dup]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.deliveries).toHaveLength(3);
    expect(viewerParts(groups[0]!, ME)).toEqual([{ channel: "content", text: "只有我看得到" }]);
  });

  it("不同 utteranceId 分到不同组", () => {
    const groups = groupDeliveriesByUtterance([
      delivery({ utteranceId: "a" }),
      delivery({ utteranceId: "b" }),
    ]);
    expect(groups.map((g) => g.utteranceId)).toEqual(["a", "b"]);
  });
});

describe("scene beat 按 order 插入", () => {
  const player = (id: number) => ({ id, kind: "utterance" as const, speaker: ME, parts: [{ channel: "content" as const, text: "我开口" }], turn: 0 });
  const npc = (id: number) => ({ id, kind: "utterance" as const, speaker: NPC, parts: [], turn: 0 });
  const scene = (id: number) => ({ id, kind: "scene" as const, parts: [{ channel: "notice" as const, text: "总结" }], turn: 0 });

  it("before 插在玩家发言前，after 插在玩家发言后", () => {
    const before = insertSceneBeat([npc(1), player(2), npc(3)], beat("b1", "before", "换地点"), scene(9), ME);
    expect(before.map((l) => l.kind)).toEqual(["utterance", "scene", "utterance", "utterance"]);
    const after = insertSceneBeat([npc(1), player(2), npc(3)], beat("b2", "after", "多人"), scene(10), ME);
    // after 插在最后一条玩家发言之后，但原数组里 npc(3) 在其后 → 位置为 index 2
    expect(after.map((l) => l.id)).toEqual([1, 2, 10, 3]);
  });

  it("没有玩家发言时追加到末尾，不抛错", () => {
    const out = insertSceneBeat([npc(1)], beat("b3", "before", "空"), scene(11), ME);
    expect(out.map((l) => l.id)).toEqual([1, 11]);
  });
});

describe("reduceConversationView", () => {
  it("多条同 utteranceId 的 Delivery 只生成一行；非本人的 Delivery 被忽略", () => {
    let s = initialConversationView();
    s = reduceConversationView(s, { type: "conversation.utterance", delivery: delivery({ utteranceId: "u1", channels: ["content"], content: "A" }) }, ctx());
    s = reduceConversationView(s, { type: "conversation.utterance", delivery: delivery({ utteranceId: "u1", channels: ["action"], content: undefined, action: "B" }) }, ctx());
    s = reduceConversationView(s, { type: "conversation.utterance", delivery: delivery({ to: "plr_other", utteranceId: "u1", channels: ["content"], content: "X" }) }, ctx());
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]!.parts).toEqual([
      { channel: "content", text: "A" },
      { channel: "action", text: "B" },
    ]);
  });

  it("phase=listening 记录等待起点；speaking 清除", () => {
    let s = initialConversationView();
    s = reduceConversationView(s, { type: "conversation.phase", sessionId: "s1", phase: "listening" }, ctx());
    expect(s.phase).toBe("listening");
    expect(s.listeningSince).toBe(1_000);
    s = reduceConversationView(s, { type: "conversation.phase", sessionId: "s1", phase: "speaking" }, ctx());
    expect(s.phase).toBe("speaking");
    expect(s.listeningSince).toBeNull();
  });

  it("30s 超时判定：到期前 false，到期后 true（服务端自动恢复时前端清等待态）", () => {
    const s = reduceConversationView(initialConversationView(), { type: "conversation.phase", sessionId: "s1", phase: "listening" }, ctx());
    expect(isListeningExpired(s, 1_000 + DEFAULT_LISTEN_TIMEOUT_MS - 1)).toBe(false);
    expect(isListeningExpired(s, 1_000 + DEFAULT_LISTEN_TIMEOUT_MS)).toBe(true);
  });

  it("scene beat 去重，且按 order 相对玩家发言插入", () => {
    let s = lineState([
      { id: 1, kind: "utterance", speaker: NPC, parts: [], turn: 0 },
      { id: 2, kind: "utterance", speaker: ME, parts: [], turn: 0 },
    ]);
    s = reduceConversationView(s, { type: "conversation.scene", beat: beat("b1", "before", "前情") }, ctx());
    s = reduceConversationView(s, { type: "conversation.scene", beat: beat("b1", "before", "前情") }, ctx());
    expect(s.beats).toHaveLength(1);
    expect(s.lines.map((l) => l.kind)).toEqual(["utterance", "scene", "utterance"]);
  });

  it("只有 committed 推进权威轮次并清除错误；error 保留 retryable", () => {
    let s = initialConversationView();
    s = reduceConversationView(s, { type: "conversation.error", sessionId: "s1", code: "E_STORE_FAULT", message: "写失败", retryable: true }, ctx());
    expect(s.error).toEqual({ code: "E_STORE_FAULT", message: "写失败", retryable: true });
    const world = { entities: {}, links: [], room: {} } as never;
    s = reduceConversationView(s, { type: "conversation.committed", sessionId: "s1", turn: 3, proposals: [], state: world }, ctx());
    expect(s.committedTurn).toBe(3);
    expect(s.error).toBeNull();
  });

  it("mental 只展示自己；notice 作为系统行", () => {
    let s = initialConversationView();
    s = reduceConversationView(s, { type: "conversation.mental", actorId: NPC, mental: { actorId: NPC, thought: "秘密", salience: 3 } }, ctx());
    expect(s.lines).toHaveLength(0);
    s = reduceConversationView(s, { type: "conversation.mental", actorId: ME, mental: { actorId: ME, thought: "我在想", salience: 3 } }, ctx());
    s = reduceConversationView(s, { type: "conversation.notice", text: "系统提示" }, ctx());
    expect(s.lines.map((l) => l.kind)).toEqual(["mental", "notice"]);
  });

  it("opened 初始化参与者并重置视图", () => {
    let s = lineState([{ id: 1, kind: "system", parts: [], turn: 0 }]);
    s = reduceConversationView(s, { type: "conversation.opened", sessionId: "s1", participants: [ME, NPC] }, ctx());
    expect(s.participants).toEqual([ME, NPC]);
    expect(s.lines).toHaveLength(0);
  });
});

describe("linesFromView：通道摊平为 UI 行", () => {
  it("content→npc/player、action→narrative、notice→system，自己说的话归 player", () => {
    let s = initialConversationView();
    s = reduceConversationView(s, { type: "conversation.utterance", delivery: delivery({ channels: ["content", "action", "notice"] }) }, ctx());
    const lines = linesFromView(s, { selfActorId: ME, nameOf: (id) => (id === ME ? "我" : "林雨") });
    expect(lines.map((l) => l.kind)).toEqual(["npc", "narrative", "system"]);
    // 台词用「名字：台词」分句；动作句名字即主语，不再重复
    expect(lines[0]!.text).toBe("林雨：大家好");
    // 同一句已有台词，动作是台词的延续，不重复主语
    expect(lines[1]!.text).toBe("环顾四周");
    const own = reduceConversationView(initialConversationView(), { type: "conversation.utterance", delivery: delivery({ speaker: ME, channels: ["content"] }) }, ctx());
    const ownLines = linesFromView(own, { selfActorId: ME, nameOf: () => "我" });
    expect(ownLines[0]!.kind).toBe("player");
    // 自己说的话不加"你"前缀（行动文本本身已是完整句）
    expect(ownLines[0]!.text).toBe("大家好");
  });

  it("模型台词已以展示名开头时不再重复（#101 回归）", () => {
    let s = initialConversationView();
    s = reduceConversationView(
      s,
      {
        type: "conversation.utterance",
        delivery: delivery({ channels: ["content", "action"], content: "林雨：你是哪个班的？", action: "林雨把文件夹往腋下一夹" }),
      },
      ctx(),
    );
    const lines = linesFromView(s, { selfActorId: ME, nameOf: () => "林雨" });
    expect(lines[0]!.text).toBe("林雨：你是哪个班的？");
    expect(lines[1]!.text).toBe("把文件夹往腋下一夹");
  });

  it("名字后没有分隔符时不剥，避免把语义削掉", () => {
    let s = initialConversationView();
    s = reduceConversationView(
      s,
      { type: "conversation.utterance", delivery: delivery({ channels: ["content"], content: "林雨来了，你们先坐" }) },
      ctx(),
    );
    const lines = linesFromView(s, { selfActorId: ME, nameOf: () => "林雨" });
    // 「林雨来了」不是说话人标签：名字已出现一次，原样展示，不再拼前缀
    expect(lines[0]!.text).toBe("林雨来了，你们先坐");
  });

  it("同一句既有台词又有动作时，动作不再重复主语", () => {
    let s = initialConversationView();
    s = reduceConversationView(s, { type: "conversation.utterance", delivery: delivery({ channels: ["content", "action"], action: "抬眼打量对方" }) }, ctx());
    const lines = linesFromView(s, { selfActorId: ME, nameOf: () => "林雨" });
    expect(lines[0]!.text).toBe("林雨：大家好");
    expect(lines[1]!.text).toBe("抬眼打量对方");
  });
});
