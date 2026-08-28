import { useEffect, useState } from "react";
import { Check, Palette } from "lucide-react";
import { applySkin, defaultSkin, readSkin, skins, type SkinId } from "~/lib/skins";

/**
 * 配色选择器。
 *
 * 纯客户端：配色只影响观感，没有必要往服务端存一趟 —— 那会让首屏
 * 多等一个请求，还得处理未登录的情况。首屏脚本已经在 paint 之前从
 * localStorage 恢复过了，这里只负责改。
 */
export function SkinPicker() {
  const [skin, setSkin] = useState<SkinId>(defaultSkin);

  // SSR 时读不到 document，挂载后再同步一次真实值
  useEffect(() => setSkin(readSkin()), []);

  function choose(next: SkinId) {
    setSkin(next);
    applySkin(next);
  }

  return (
    <section className="paper-panel rounded-lg p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Palette className="size-4" />
        站点配色
      </h2>
      <p className="mt-1.5 text-sm text-muted-foreground">
        只影响本机，换了立即生效。正文的配色在阅读器里单独设。
      </p>

      <div
        role="radiogroup"
        aria-label="站点配色"
        className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {skins.map((item) => {
          const active = skin === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choose(item.id)}
              className={`flex items-center gap-2.5 rounded-md border p-2.5 text-left transition-colors ${
                active
                  ? "border-primary bg-secondary"
                  : "border-border hover:border-primary/40 hover:bg-muted"
              }`}
            >
              {/* 色卡：主色压在底色上，一眼看出冷暖 */}
              <span
                aria-hidden
                className="relative size-7 shrink-0 rounded-full border border-border"
                style={{ background: item.swatch[1] }}
              >
                <span
                  className="absolute inset-y-0 left-0 w-1/2 rounded-l-full"
                  style={{ background: item.swatch[0] }}
                />
                {active && (
                  <Check
                    className="absolute inset-0 m-auto size-3.5 drop-shadow-[0_0_2px_rgba(0,0,0,0.55)]"
                    style={{ color: "#fff" }}
                  />
                )}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{item.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{item.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
