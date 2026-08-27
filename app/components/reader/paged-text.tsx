import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 閹稿鐫嗛崚鍡涖€夐弰鍓с仛娑撯偓濞堝灚顒滈弬鍥モ偓?
 *
 * 閻?CSS 婢舵艾鍨?+ translateX 濡亜鎮滈獮宕囆╅崑姘辩倳妞ょ绱濇稉搴㈡拱閸︿即妲勭拠璇叉珤閸氬奔绔存總妤佹簚閸掕绱?
 * 閸愬懎顔愭稉鈧▎鈩冣偓褔鎽垫潻娑橆樋閸掓顔愰崳顭掔礉scrollWidth / 閸掓顔?鐏忚鲸妲搁幀濠氥€夐弫甯礉缂堝銆夐崣顏呮Ц楠炲磭些閵?
 * 鏉╂瑦鐗辨稉宥夋付鐟曚線顣╅崗鍫ｎ吀缁犳鐦℃い浣冾棅婢舵艾鐨€涙绱濈€涙褰?鐞涘矁绐?缁愭褰涚亸鍝勵嚟閸欐ê瀵查崥搴ㄥ櫢閺傜増绁撮柌蹇撳祮閸欘垬鈧?
 *
 * 閸欘亣绀嬬拹锝冣偓灞肩濞堝灚鏋冪€涙鈧簼绠為崚鍡涖€夐弰鍓с仛閵嗗稄绱濇稉宥嗙Ч閸欏﹦鐝烽懞鍌氼嚤閼割亙绗岄弫鐗堝祦閼惧嘲褰囬敍?
 * 閸ョ姵顒濋崷銊у殠濠ф劙妲勭拠濠氥€夋稉搴＄殺閺夈儱鍩嗘径鍕厴閼崇晫娲块幒銉ф暏閵?
 */

export interface PagedTextProps {
  paragraphs: string[];
  /** 缁旂姾濡弽鍥暯閿涘本甯撻崷銊︻劀閺傚洤澧?*/
  heading?: string | null;
  fontSize: number;
  lineHeight: number;
  /** 妞ゅ灚鏆熸稉搴＄秼閸撳秹銆夐崣妯哄閺冭泛娲栫拫鍐跨礉娓氭稑顦荤仦鍌涜閺屾捇銆夐惍浣风瑢娑撳﹣绗呮い鍨瘻闁?*/
  onPaginationChange?: (state: { pageIndex: number; pageCount: number }) => void;
  /** 婢舵牕鐪伴幒褍鍩楃紙濠氥€夐悽顭掔幢閸欐甯堕崐鐓庡綁閸栨牗妞傜捄鐔兼 */
  pageIndex: number;
  onPageIndexChange: (next: number) => void;
  /** 瀹告彃婀＃鏍€夋潻妯兼埛缂侇厼绶氶崜宥囩倳 閳ユ柡鈧?婢舵牕鐪伴幑顔筋劃鐠哄厖绗傛稉鈧粩?*/
  onOverflowPrev?: () => void;
  /** 瀹告彃婀張顐︺€夋潻妯兼埛缂侇厼绶氶崥搴ｇ倳 閳ユ柡鈧?婢舵牕鐪伴幑顔筋劃鐠哄厖绗呮稉鈧粩?*/
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

  // 鐟欏棗褰涚亸鍝勵嚟閸欐ê瀵查敍鍫㈢崶閸欙絿缂夐弨淇扁偓浣规鐏炲骏绱氶崥搴ゎ洣闁插秵鏌婂ù瀣櫤閸掑棝銆?
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
   * 濞村鍣洪幀濠氥€夐弫鑸偓鍌滄暏 useLayoutEffect閿涙艾绻€妞よ婀ù蹇氼潔閸ｃ劎绮崚璺哄缁犳鍤い鍨殶閿?
   * 閸氾箑鍨导姘帥闂傤亙绔存稉?缁?1/1 妞?閸愬秷鐑﹂崚鐗堫劀绾喖鈧鈧?
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
  }, [size.width, size.height, fontSize, lineHeight, paragraphs, heading]);

  // 妞ゅ灚鏆熼崣妯哄閸氬骸缍嬮崜宥夈€夐崣顖濆厴鐡掑﹦鏅敍鍫滅伐婵″倹鏂佹径褍鐡ч崣宄邦嚤閼锋挳銆夐弫鏉垮綁婢?閸欐ê鐨敍?
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
    // 瀹告彃婀＃鏍€夐敍姘唉缂佹瑥顦荤仦鍌氬枀鐎规碍妲搁崥锕佺儲娑撳﹣绔寸粩?
    onOverflowPrev?.();
  }, [pageIndex, onPageIndexChange, onOverflowPrev]);

  const goNext = useCallback(() => {
    if (pageIndex < pageCount - 1) {
      onPageIndexChange(pageIndex + 1);
      return;
    }
    onOverflowNext?.();
  }, [pageIndex, pageCount, onPageIndexChange, onOverflowNext]);

  // 闁款喚娲忔稉搴ｅ仯閸戣崵鐐曟い?
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
        // 瀹革缚绗侀崚鍡曠娑撯偓瀵扳偓閸撳稄绱濋崣鍏呯瑏閸掑棔绠ｆ稉鈧鈧崥搴礉娑擃參妫块悾娆戠舶娑撳﹣绗呴弽蹇撳瀼閹?
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientX - rect.left) / rect.width;
        if (ratio < 0.33) goPrev();
        else if (ratio > 0.67) goNext();
      }}
    >
      {/*
        鐎硅棄瀹冲ù瀣毉閺夈儰绠ｉ崜宥勭瑝閼宠棄绱戞径姘灙閿涙瓭olumnWidth 娑?1px 娴兼碍濡稿锝嗘瀮閸掑洦鍨氶崙鐘插磮娑?
        1px 鐎圭晫娈戦崚妤嬬礉閼插婧傞惇瀣皑閺勵垯绔撮悧鍥┾敄閻у鈧倹绁撮柌蹇撳閸忓牊瀵滈弲顕€鈧碍绁﹀蹇旇閺屾搫绱?
        ResizeObserver 娑撯偓閸掓澘姘ㄩ崚鍥ㄥ灇閸掑棝銆夐妴?
      */}
      <div
        ref={contentRef}
        data-reader-pagination
        className="h-full transition-transform duration-150"
        style={
          size.width > 0
            ? {
                height: `${size.height}px`,
                width: `${size.width}px`,
                columnWidth: `${size.width}px`,
                columnGap: 0,
                columnRule: "0 none transparent",
                columnFill: "auto",
                fontSize: `${fontSize}px`,
                lineHeight,
                transform: `translateX(-${pageIndex * size.width}px)`,
              }
            : { fontSize: `${fontSize}px`, lineHeight }
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
