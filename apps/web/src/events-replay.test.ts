import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTOR_ID_INVALID_NOTICE,
  ACTOR_ID_MISSING_NOTICE,
  buildEventsQuery,
  decideEventsOutcome,
  fetchRoomEvents,
  filterDirectMessages,
  isActorIdForbidden,
  type ReplayEvent,
} from "./events-replay.ts";

afterEach(() => vi.unstubAllGlobals());

const dm = (): ReplayEvent => ({ type: "msg.sent", audience: ["plr_me"] });
const spoken = (): ReplayEvent => ({ type: "npc.spoke", text: "早上好" });

describe("buildEventsQuery（query 参数决策）", () => {
  it("传了 actorId 就显式带上（要渲染私信必须如此）", () => {
    const q = buildEventsQuery({ actorId: "plr_me", fromSeq: 0, limit: 200 });
    expect(q).toContain("actorId=plr_me");
    expect(q).toContain("fromSeq=0");
    expect(q).toContain("limit=200");
  });

  it("不传 actorId 就省略该参数（服务端静默过滤私信）", () => {
    const q = buildEventsQuery();
    expect(q).toBe("");
    expect(buildEventsQuery({ fromSeq: 5 })).toBe("fromSeq=5");
  });

  it("actorId 里的特殊字符被正确编码", () => {
    expect(buildEventsQuery({ actorId: "plr a&b" })).toContain("actorId=plr+a%26b");
  });
});

describe("isActorIdForbidden（403 分类）", () => {
  it("403 或 E_FORBIDDEN 判为 actorId 无效", () => {
    expect(isActorIdForbidden({ status: 403 })).toBe(true);
    expect(isActorIdForbidden({ status: 200, code: "E_FORBIDDEN" })).toBe(true);
  });

  it("401/5xx/网络错误不是 actorId 的问题", () => {
    expect(isActorIdForbidden({ status: 401, code: "E_UNAUTHORIZED" })).toBe(false);
    expect(isActorIdForbidden({ status: 500 })).toBe(false);
    expect(isActorIdForbidden({ status: 0 })).toBe(false);
    expect(isActorIdForbidden(undefined)).toBe(false);
  });
});

describe("filterDirectMessages（私信纵深过滤）", () => {
  it("renderDm=false 只去掉 msg.sent，其余事件保留", () => {
    const events = [spoken(), dm(), { type: "turn.commit" }];
    expect(filterDirectMessages(events, false)).toEqual([spoken(), { type: "turn.commit" }]);
  });

  it("renderDm=true 原样保留（含私信）", () => {
    const events = [spoken(), dm()];
    expect(filterDirectMessages(events, true)).toBe(events);
  });
});

describe("decideEventsOutcome（纯决策）", () => {
  it("正常 200（带本人 actorId）：全部渲染，无提示", () => {
    const events = [spoken(), dm()];
    const out = decideEventsOutcome({ primary: { ok: true, events }, withActorId: true });
    expect(out.kind).toBe("ok");
    expect(out.events).toEqual(events);
    expect(out.renderDm).toBe(true);
    expect(out.notice).toBeNull();
    expect(out.degraded).toBe(false);
  });

  it("老房间 200 + 空事件流：按空态处理，不是错误", () => {
    const out = decideEventsOutcome({ primary: { ok: true, events: [] }, withActorId: true });
    expect(out.kind).toBe("empty");
    expect(out.events).toEqual([]);
    expect(out.notice).toBeNull();
  });

  it("没传 actorId 的 200：私信被滤掉，给软提示而不是报错", () => {
    const out = decideEventsOutcome({ primary: { ok: true, events: [spoken(), dm()] }, withActorId: false });
    expect(out.kind).toBe("ok");
    expect(out.renderDm).toBe(false);
    expect(out.events).toEqual([spoken()]);
    expect(out.notice).toBe(ACTOR_ID_MISSING_NOTICE);
  });

  it("403 + 降级重试成功：事件流照常渲染，只是不渲染私信并提示 actorId 无效", () => {
    const out = decideEventsOutcome({
      primary: { ok: false, status: 403, code: "E_FORBIDDEN" },
      withActorId: true,
      fallback: { ok: true, events: [spoken(), dm()] },
    });
    expect(out.kind).toBe("degraded");
    expect(out.degraded).toBe(true);
    expect(out.renderDm).toBe(false);
    expect(out.events).toEqual([spoken()]);
    expect(out.notice).toContain("actorId 无效");
    expect(out.notice).toBe(ACTOR_ID_INVALID_NOTICE);
  });

  it("403 后重试也是空流/再次失败：仍不判死，空态 + 提示", () => {
    for (const fallback of [
      { ok: true as const, events: [] },
      { ok: false as const, status: 403 },
    ]) {
      const out = decideEventsOutcome({
        primary: { ok: false, status: 403, code: "E_FORBIDDEN" },
        withActorId: true,
        fallback,
      });
      expect(out.kind).toBe("degraded");
      expect(out.events).toEqual([]);
      expect(out.notice).toBe(ACTOR_ID_INVALID_NOTICE);
    }
  });

  it("非 403 错误：归为 error 并保留服务端人话", () => {
    const out = decideEventsOutcome({
      primary: { ok: false, status: 500, message: "服务端暂时不可用" },
      withActorId: true,
    });
    expect(out.kind).toBe("error");
    expect(out.events).toEqual([]);
    expect(out.notice).toContain("服务端");
  });
});

describe("fetchRoomEvents（HTTP 薄包装：403 自动重拉）", () => {
  it("第一次带 actorId 得 403，第二次不带 actorId 拿回事件流", async () => {
    const seenUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seenUrls.push(url);
        if (seenUrls.length === 1) {
          return new Response(JSON.stringify({ ok: false, code: "E_FORBIDDEN", message: "actorId 无效" }), { status: 403 });
        }
        return new Response(JSON.stringify({ events: [spoken(), dm()], lastSeq: 7 }));
      }),
    );
    const out = await fetchRoomEvents("room_1", { actorId: "plr_wrong", fromSeq: 0 });
    expect(seenUrls[0]).toContain("actorId=plr_wrong");
    expect(seenUrls[1]).not.toContain("actorId=");
    expect(seenUrls[1]).toContain("fromSeq=0");
    expect(out.kind).toBe("degraded");
    expect(out.renderDm).toBe(false);
    expect(out.events).toEqual([spoken()]);
    expect(out.notice).toContain("actorId 无效");
  });

  it("正常 200 只请求一次，私信保留", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events: [spoken(), dm()], lastSeq: 2 })));
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchRoomEvents("room_1", { actorId: "plr_me" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.kind).toBe("ok");
    expect(out.events).toHaveLength(2);
    expect(out.renderDm).toBe(true);
  });
});
