/**
 * 平台配色（skin）的单一定义处。
 *
 * 与阅读器主题（reader-settings.ts 里的 paper / ink / oled …）是两回事：
 * 那套只作用于正文区域，跟着书走；这套是整站的壳。分开是有意的 ——
 * 看夜里读书要纯黑正文，但不见得想让整个站变黑。
 *
 * 色值不在这里，在 app.css 的 [data-theme] 块里。这里只管"有哪几套、
 * 叫什么、预览色是什么"，因为 root.tsx 的首屏脚本也要校验同一份名单，
 * 两处写死两遍必然漂。
 */

export const skins = [
  {
    id: "amber",
    label: "暖橘",
    hint: "奶油纸底，明快",
    /** 设置页色卡用，取该主题的主色与底色 */
    swatch: ["#ea7a33", "#fdf8f3"],
  },
  {
    id: "ink",
    label: "墨蓝",
    hint: "冷调，克制",
    swatch: ["#2f5d8a", "#f5f6f8"],
  },
  {
    id: "moss",
    label: "青苔",
    hint: "旧版配色",
    swatch: ["#2f6f52", "#f3f2ed"],
  },
  {
    id: "plum",
    label: "绛紫",
    hint: "偏暖的冷色",
    swatch: ["#8b4a72", "#faf6f8"],
  },
] as const;

export type SkinId = (typeof skins)[number]["id"];

export const defaultSkin: SkinId = "amber";

const skinIds = skins.map((skin) => skin.id) as readonly string[];

export function isSkinId(value: unknown): value is SkinId {
  return typeof value === "string" && skinIds.includes(value);
}

export const skinStorageKey = "yuedu-skin";
export const modeStorageKey = "yuedu-theme";

/** 读当前配色。服务端渲染时没有 document，返回默认值。 */
export function readSkin(): SkinId {
  if (typeof document === "undefined") return defaultSkin;
  const current = document.documentElement.dataset.theme;
  return isSkinId(current) ? current : defaultSkin;
}

/** 换配色并记住选择。 */
export function applySkin(skin: SkinId) {
  document.documentElement.dataset.theme = skin;
  try {
    localStorage.setItem(skinStorageKey, skin);
  } catch {
    // 隐私模式下写不进去，本次会话仍然生效
  }
}
