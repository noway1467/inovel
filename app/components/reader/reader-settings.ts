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
export type PaginationMode = "scroll" | "cover" | "none";

export interface ReaderSettings {
  theme: ReaderTheme;
  fontSize: number;
  fontFamily: "system" | "serif" | "hei";
  lineHeight: number;
  paragraphSpacing: number;
  margin: "narrow" | "standard" | "wide";
  align: "justify" | "left";
  indent: "none" | "2char";
  letterSpacing: "default" | "wide";
  paginationMode: PaginationMode;
}

export const defaultReaderSettings: ReaderSettings = {
  theme: "paper",
  fontSize: 18,
  fontFamily: "system",
  lineHeight: 180,
  paragraphSpacing: 80,
  margin: "standard",
  align: "justify",
  indent: "2char",
  letterSpacing: "default",
  paginationMode: "cover",
};

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
    return { ...defaultReaderSettings, ...(JSON.parse(raw) as Partial<ReaderSettings>) };
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
