/** system 是"跟随系统"，不是一套配色：它会在运行时解析成 paper 或 ink。 */
export type ReaderTheme = "system" | "paper" | "soft" | "parchment" | "ink" | "oled";

/** 实际能落到 data-reader-theme 上的具体配色（CSS 里有对应变量的那几个）。 */
export type ResolvedReaderTheme = Exclude<ReaderTheme, "system">;

export const systemDarkQuery = "(prefers-color-scheme: dark)";

const readerThemeKeys: ReaderTheme[] = ["system", "paper", "soft", "parchment", "ink", "oled"];
const paginationModeKeys: PaginationMode[] = ["scroll", "cover", "none"];

/**
 * 校验来自服务端/localStorage 的主题值。
 *
 * 这些值是历史遗留的自由文本（本地库里就存着早期版本的 "sepia"），
 * 原来直接 `as ReaderTheme` 硬转，陌生值会落到 data-reader-theme 上，
 * CSS 匹配不到任何变量，阅读器就没有配色。认不出就回退。
 */
export function normalizeReaderTheme(
  value: unknown,
  fallback: ReaderTheme = "system"
): ReaderTheme {
  return readerThemeKeys.includes(value as ReaderTheme) ? (value as ReaderTheme) : fallback;
}

export function normalizePaginationMode(
  value: unknown,
  fallback: PaginationMode = defaultReaderSettings.paginationMode
): PaginationMode {
  return paginationModeKeys.includes(value as PaginationMode)
    ? (value as PaginationMode)
    : fallback;
}

/**
 * 把用户选的主题解析成具体配色。
 *
 * systemDark 由调用方以 state 形式传入（而不是在这里读 matchMedia），
 * 这样系统深浅色一变，依赖它的组件就会重渲染。
 * 跟随系统时：深色给墨水灰，浅色给明亮纸张。
 */
export function resolveReaderTheme(
  theme: ReaderTheme,
  systemDark: boolean
): ResolvedReaderTheme {
  if (theme !== "system") return theme;
  return systemDark ? "ink" : "paper";
}

/**
 * 行距百分数转 CSS 无单位倍数（180 → 1.8）。
 *
 * ReaderSettings.lineHeight 存的是百分数（面板滑块 140~240）。谁把它原样
 * 交给 CSS line-height，一行行高就变成 fontSize×180；正文被推到列外，
 * 页数也跟着炸（在线源阅读页曾因此整页空白）。两个阅读器都走这里，
 * 免得约定再次跑偏。入参已经是倍数时原样返回。
 */
export function resolveLineHeight(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return defaultReaderSettings.lineHeight / 100;
  return value > 10 ? value / 100 : value;
}

export type PaginationMode = "scroll" | "cover" | "none";

export interface ReaderSettings {
  theme: ReaderTheme;
  fontSize: number;
  fontFamily: "system" | "serif" | "hei";
  lineHeight: number;
  paragraphSpacing: number;
  margin: "narrow" | "standard" | "wide";
  /**
   * 左右留白，占正文容器宽度的百分数（6 表示每侧留 6%）。
   *
   * 与 margin 分工：margin 是「行长上限」，只在宽屏上起作用；
   * sideMargin 每种屏宽都生效，手机上也能把正文从边缘收回来。
   * 两者取较大的那个，见 resolveSideInset。
   */
  sideMargin: number;
  align: "justify" | "left";
  indent: "none" | "2char";
  letterSpacing: "default" | "wide";
  paginationMode: PaginationMode;
  /**
   * 允许选中/复制正文。默认关。
   *
   * 分页模式下点击左右两侧就是翻页，手指或鼠标稍微一拖就选中一片文字，
   * 蓝底加系统的复制气泡会盖住正文 —— 关掉之后翻页手感干净。
   * 想摘句子的人打开它：两个阅读器都会放开选中，翻页也会先让开选区。
   */
  allowCopy: boolean;
}

export const defaultReaderSettings: ReaderSettings = {
  theme: "paper",
  fontSize: 18,
  fontFamily: "system",
  lineHeight: 180,
  paragraphSpacing: 80,
  margin: "standard",
  sideMargin: 6,
  align: "justify",
  indent: "2char",
  letterSpacing: "default",
  paginationMode: "cover",
  allowCopy: false,
};

export const sideMarginRange = { min: 0, max: 20, step: 1 } as const;

/**
 * 左右留白的合法范围是 0~20%，超出就夹回区间，非数字回落到默认值。
 *
 * 只认真正的数字和数字字符串：`Number(null)`、`Number("")`、`Number([])`
 * 全是 0，一律走 Number() 的话，存坏的字段会被当成"留白 0%"当真用上，
 * 正文贴着屏幕边而设置面板显示 0 —— 看着像用户自己调的，不像数据坏了。
 */
export function normalizeSideMargin(
  value: unknown,
  fallback: number = defaultReaderSettings.sideMargin
): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(sideMarginRange.max, Math.max(sideMarginRange.min, Math.round(numeric)));
}

/**
 * 行长上限。
 *
 * 名字对应的是「正文有多宽」：窄档正文最窄、留白最多。此前这张表是反的
 * （narrow 给 96rem，即最宽的正文），选「窄」反而让行更长。
 *
 * 数值按中文一行多少字定：18px 字号下 68rem ≈ 60 字，是长文里还跟得住的上界；
 * 原来的 80~96rem 到 70~85 字，一行读完眼睛要横扫大半个屏幕，回行也容易串行。
 */
const bodyWidthCap: Record<ReaderSettings["margin"], string> = {
  narrow: "52rem",
  standard: "68rem",
  wide: "88rem",
};

/**
 * 算出正文每侧该留多少空白，给 margin-inline / padding-inline 用。
 *
 * 三个约束取最大值：
 *  - `floor`：最小留白，手机上不让文字贴边（也是 0% 时的兜底）
 *  - `sideMargin%`：用户直接调的比例，任何屏宽都生效
 *  - `(100% - 行长上限) / 2`：宽屏上把行长压到可读范围
 *
 * 百分数按包含块宽度解析：分页模式下子元素的包含块就是多列的列盒
 * （列宽 = 页宽），滚动模式下是 article 自身宽度，两处都正好是正文宽度。
 */
export function resolveSideInset(settings: ReaderSettings, floor = "0.75rem"): string {
  const pct = normalizeSideMargin(settings.sideMargin);
  return `max(${floor}, ${pct}%, calc((100% - ${bodyWidthCap[settings.margin]}) / 2))`;
}

export const readerThemes: { key: ReaderTheme; label: string; swatch: string }[] = [
  // 半白半黑的色块，示意会跟着系统在浅色/深色之间切
  { key: "system", label: "跟随系统", swatch: "linear-gradient(135deg,#fbfaf7 0 50%,#23262a 50% 100%)" },
  { key: "paper", label: "明亮纸张", swatch: "#fbfaf7" },
  { key: "soft", label: "柔和阅读", swatch: "#eef2ec" },
  { key: "parchment", label: "羊皮纸", swatch: "#f3ead7" },
  { key: "ink", label: "墨水灰", swatch: "#23262a" },
  { key: "oled", label: "OLED 黑", swatch: "#000000" },
];

export const readerSettingsKey = "yuedu-reader-settings";

export function loadReaderSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(readerSettingsKey);
    // 首次进入直接跟随系统：原来是按当前 dark class 定死 ink/paper，
    // 效果一样但之后系统切换深浅色就跟不上了
    if (!raw) return { ...defaultReaderSettings, theme: "system" };
    const parsed = JSON.parse(raw) as Partial<ReaderSettings>;
    // localStorage 里可能残留旧版本写入的陌生值，必须过一遍校验再用
    return {
      ...defaultReaderSettings,
      ...parsed,
      theme: normalizeReaderTheme(parsed.theme),
      paginationMode: normalizePaginationMode(parsed.paginationMode),
      // 老版本存的设置里没有这个字段，展开后会是 undefined
      sideMargin: normalizeSideMargin(parsed.sideMargin),
      // 同上；这里必须落成真布尔，undefined 交给 style 会当"没设置"处理
      allowCopy: parsed.allowCopy === true,
    };
  } catch {
    return defaultReaderSettings;
  }
}

export function saveReaderSettings(settings: ReaderSettings) {
  try {
    localStorage.setItem(readerSettingsKey, JSON.stringify(settings));
  } catch {
    // 忽略隐私模式下的存储失败
  }
}

export const progressStorageKey = (bookId: string) => `yuedu-progress-${bookId}`;

export interface LocalProgress {
  bookId: string;
  chapterId: string | null;
  paragraphAnchor: string | null;
  charOffset: number;
  chapterProgress: number;
  bookProgress: number;
  updatedAt: string;
  version?: number;
}

export function loadLocalProgress(bookId: string): LocalProgress | null {
  try {
    const raw = localStorage.getItem(progressStorageKey(bookId));
    return raw ? (JSON.parse(raw) as LocalProgress) : null;
  } catch {
    return null;
  }
}

export function saveLocalProgress(bookId: string, progress: LocalProgress) {
  try {
    localStorage.setItem(progressStorageKey(bookId), JSON.stringify(progress));
  } catch {
    // 忽略隐私模式下的存储失败
  }
}
