import { useCallback, useRef, type MouseEvent } from "react";
import { useNavigate, useNavigation } from "react-router";

/** 换章期间复用正在进行的导航，避免连续翻页反复取消并重启 loader。 */
export function useChapterNavigation() {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const pending = useRef(false);
  const isChapterLoading = navigation.state !== "idle";

  const navigateChapter = useCallback(
    async (href: string) => {
      // ref 先于 React 重渲染生效，也能挡住同一帧内的点击、触摸和按键连发。
      if (pending.current || isChapterLoading) return;
      pending.current = true;
      try {
        await navigate(href);
      } finally {
        // 成功、失败或被返回/目录导航取消后都释放，不把阅读器永久锁住。
        pending.current = false;
      }
    },
    [isChapterLoading, navigate]
  );

  const onChapterLinkClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // 保留 Ctrl/Cmd 点击、另开标签页等链接原生行为。
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        (event.currentTarget.target && event.currentTarget.target !== "_self")
      )
        return;
      event.preventDefault();
      const { pathname, search, hash } = event.currentTarget;
      void navigateChapter(`${pathname}${search}${hash}`);
    },
    [navigateChapter]
  );

  return { isChapterLoading, navigateChapter, onChapterLinkClick };
}
