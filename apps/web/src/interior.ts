/**
 * 室内地图定义（目前只有图书馆）。
 *
 * 室内是一套独立的像素坐标系（1600×1200），与校园大地图（6000×4500）无关；
 * 进入室内只切换渲染，不改变世界状态里的 locId —— 玩家仍然"在图书馆"。
 */

export interface InteriorSpot {
  id: string;
  name: string;
  x: number;
  y: number;
  /** 点位类型：决定标记样式 */
  kind: "service" | "area" | "facility";
}

export interface InteriorMap {
  /** public 下的底图 */
  image: string;
  width: number;
  height: number;
  /** 刚进门时站的位置 */
  spawn: { x: number; y: number };
  /** 出口（走到附近点它就能回到大地图） */
  exit: { x: number; y: number };
  spots: InteriorSpot[];
}

export const LIBRARY_INTERIOR: InteriorMap = {
  image: "/map/library-interior.png",
  width: 1600,
  height: 1200,
  spawn: { x: 800, y: 1040 },
  exit: { x: 800, y: 1150 },
  spots: [
    { id: "lib_counter", name: "借阅台", x: 800, y: 470, kind: "service" },
    { id: "lib_reading", name: "自习区", x: 800, y: 230, kind: "area" },
    { id: "lib_shelf_w", name: "西书架区", x: 270, y: 500, kind: "area" },
    { id: "lib_shelf_e", name: "东书架区", x: 1330, y: 500, kind: "area" },
    { id: "lib_digital", name: "电子阅览室", x: 1315, y: 970, kind: "facility" },
    { id: "lib_stairs", name: "楼梯", x: 210, y: 980, kind: "facility" },
  ],
};

/** 室内 NPC 的落位（按索引轮换，保证同馆内几个人不重叠） */
const NPC_SPOTS: Array<{ x: number; y: number }> = [
  { x: 660, y: 250 },
  { x: 940, y: 250 },
  { x: 600, y: 640 },
  { x: 1000, y: 640 },
  { x: 300, y: 330 },
  { x: 1300, y: 330 },
];

export function interiorNpcSpot(index: number): { x: number; y: number } {
  return NPC_SPOTS[index % NPC_SPOTS.length]!;
}

/** 哪些场景有室内地图（场景 id → 室内地图） */
export const INTERIORS: Record<string, InteriorMap> = {
  loc_library: LIBRARY_INTERIOR,
};

export function interiorFor(sceneId: string | undefined | null): InteriorMap | null {
  if (!sceneId) return null;
  return INTERIORS[sceneId] ?? null;
}
