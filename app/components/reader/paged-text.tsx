import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { resolveLineHeight } from "~/components/reader/reader-settings";

/**
 * 按屏分页显示一段正文。
 *
 * 用 CSS 多列 + translateX 横向平移做翻页，与本地阅读器同一套机制：
 * 内容一次性铺进多列容器，scrollWidth / 列宽 就是总页数，翻页只是平移。
 * 这样不需要预先计算每页装多少字，字号/行距/窗口尺寸变化后重新测量即可。
 *
 * 只负责「一段文字怎么分页显示」，不涉及章节导航与数据获取，
 * 因此在线源阅读页与将来别处都能直接用。
 */

export interface PagedTextProps {
  paragraphs: string[];
  /** 章节标题，排在正文前 */
  heading?: string | null;
  fontSize: number;
  /**
   * 行距，与 ReaderSettings.lineHeight 同一约定：百分数（180 表示 1.8 倍）。
   * 之前这里把 180 直接当无单位倍数交给 CSS，一行行高就成了 fontSize×180，
   * 正文被推到列外，看着就是"HTML 有内容但整页空白"。
   */
  lineHeight: number;
  /** 页数与当前页变化时回调，供外层渲染页码与上下页按钮 */
  onPaginationChange?: (state: { pageIndex: number; pageCount: number }) => void;
  /** 外层控制翻页用；受控值变化时跟随 */
  pageIndex: number;
  onPageIndexChange: (next: number) => void;
  /** 已在首页还继续往前翻 —— 外层据此跳上一章 */
  onOverflowPrev?: () => void;
  /** 已在末页还继续往后翻 —— 外层据此跳下一章 */
  onOverflowNext?: () => void;
}

export function PagedText({
  paragraphs,
  heading,
  fontSize,
  lineHeight,
  pageIndex,
  pageCount: _ignored,
  onPageIndexChange,
  onPaginationChange,
  onOverflowPrev,
  onOverflowNext,
}: PagedTextProps & { pageCount?: number }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [pageCount, setPageCount] = useState(1);

  const resolvedLineHeight = resolveLineHeight(lineHeight);

  // 视口尺寸变化（窗口缩放、旋屏）后要重新测量分页
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      setSize({ width: element.clientWidth, height: element.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /**
   * 测量总页数。用 useLayoutEffect：必须在浏览器绘制前算出页数，
   * 否则会先闪一下"第 1/1 页"再跳到正确值。
   */
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || size.width === 0 || size.height === 0) return;
    const columnWidth = Math.max(1, size.width);
    const measurePages = () => {
      const next = Math.max(1, Math.ceil(content.scrollWidth / columnWidth));
      setPageCount(next);
    };
    measurePages();
    const frame = requestAnimationFrame(measurePages);
    return () => cancelAnimationFrame(frame);
  }, [size.width, size.height, fontSize, resolvedLineHeight, paragraphs, heading]);

  // 页数变化后当前页可能越界（例如放大字号导致页数变多/变少）
  useEffect(() => {
    if (pageIndex > pageCount - 1) onPageIndexChange(Math.max(0, pageCount - 1));
  }, [pageCount, pageIndex, onPageIndexChange]);

  useEffect(() => {
    onPaginationChange?.({ pageIndex, pageCount });
  }, [pageIndex, pageCount, onPaginationChange]);

  const goPrev = useCallback(() => {
    if (pageIndex > 0) {
      onPageIndexChange(pageIndex - 1);
      return;
    }
    // 已在首页：交给外层决定是否跳上一章
    onOverflowPrev?.();
  }, [pageIndex, onPageIndexChange, onOverflowPrev]);

  const goNext = useCallback(() => {
    if (pageIndex < pageCount - 1) {
      onPageIndexChange(pageIndex + 1);
      return;
    }
    onOverflowNext?.();
  }, [pageIndex, pageCount, onPageIndexChange, onOverflowNext]);

  // 键盘与点击翻页
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        goNext();
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        goPrev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goPrev, goNext]);

  return (
    <div
      ref={viewportRef}
      className="relative h-full overflow-hidden"
      onClick={(event) => {
        // 左三分之一往前，右三分之一往后，中间留给上下栏切换
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientX - rect.left) / rect.width;
        if (ratio < 0.33) goPrev();
        else if (ratio > 0.67) goNext();
      }}
    >
      {/*
        宽度测出来之前不能开多列：columnWidth 为 1px 会把正文切成几千个
        1px 宽的列，肉眼看就是一片空白。测量前先按普通流式渲染，
        ResizeObserver 一到就切成分页。
      */}
      <div
        ref={contentRef}
        data-reader-pagination
        className="reader-body h-full transition-transform duration-150"
        style={
          size.width > 0 && size.height > 0
            ? {
                height: "100%",
                blockSize: `${size.height}px`,
                inlineSize: `${size.width}px`,
                columnWidth: `${size.width}px`,
                columnGap: 0,
                columnRule: "0 none transparent",
                columnFill: "auto",
                fontSize: `${fontSize}px`,
                lineHeight: resolvedLineHeight,
                transform: `translateX(-${pageIndex * size.width}px)`,
              }
            : { fontSize: `${fontSize}px`, lineHeight: resolvedLineHeight }
        }
      >
        {heading && <h1 className="mb-6 text-center text-[1.3em] font-semibold">{heading}</h1>}
        {paragraphs.map((text, index) => (
          <p key={`p${index}`} className="mb-4 indent-[2em]">
            {text}
          </p>
        ))}
      </div>
    </div>
  );
}
