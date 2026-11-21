/**
 * 离线叙述器的回归测试（审阅 M2）：提示词解析、场景别名的目标选取、
 * 观察类不重复场景描述、缺失场景的兜底、缺失数据文件不炸启动。
 */
import { describe, expect, it } from "vitest";
import { loadSceneDescs, offlineNarrative, parsePromptContext } from "./offline-narrator.ts";

function messages(input: string, loc: string, day = 1, phase = "morning"): { role?: string; content?: string }[] {
  return [
    {
      role: "system",
      content: `你是校园文字冒险游戏的叙事者。\n当前地点：${loc}；第 ${day} 天 ${phase}。\n玩家：你。\n玩家输入：${input}`,
    },
    { role: "user", content: input },
  ];
}

const SCENES = new Map<string, string>([
  ["图书馆", "旧馆三层，四层书架把光切成一条一条。流通台后面是过刊室。"],
  ["一食堂", "队伍一直排到门口。价目表被人用笔改过。"],
]);

describe("parsePromptContext", () => {
  it("从提示词里取回地点/天数/时段/玩家输入", () => {
    const ctx = parsePromptContext(messages("去食堂", "图书馆", 3, "evening"));
    expect(ctx).toEqual({ locName: "图书馆", day: 3, phase: "evening", input: "去食堂" });
  });

  it("提示词缺失时给安全默认值，不抛错", () => {
    const ctx = parsePromptContext([{ content: "hi" }]);
    expect(ctx).toEqual({ locName: "", day: 1, phase: "morning", input: "hi" });
  });
});

describe("offlineNarrative", () => {
  it("移动类输入用目标场景的描述（含别名匹配），不用出发地", () => {
    const text = offlineNarrative(messages("去食堂", "图书馆"), SCENES);
    expect(text).toContain("队伍一直排到门口"); // 目标"一食堂"的别名"食堂"
    expect(text).not.toContain("旧馆三层");
  });

  it("观察类输入不重复场景描述（facts 会带），只给开场与收束", () => {
    const text = offlineNarrative(messages("看看四周", "图书馆"), SCENES);
    expect(text).not.toContain("旧馆三层");
    expect(text.length).toBeGreaterThan(0);
  });

  it("场景缺失时退回通用白描，不抛错", () => {
    const text = offlineNarrative(messages("去操场", "图书馆"), new Map());
    expect(text.length).toBeGreaterThan(0);
  });

  it("交易类输入走交易收束句", () => {
    const text = offlineNarrative(messages("买面包", "一食堂"), SCENES);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("配置");
  });
});

describe("loadSceneDescs", () => {
  it("文件不存在返回空表，不抛错", async () => {
    const map = await loadSceneDescs("C:/nonexistent/world_map.json");
    expect(map.size).toBe(0);
  });
});
