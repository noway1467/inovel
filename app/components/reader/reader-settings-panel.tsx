import { Minus, Plus, RotateCcw } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Slider } from "~/components/ui/slider";
import { Switch } from "~/components/ui/switch";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { cn } from "~/lib/utils";
import {
  defaultReaderSettings,
  readerThemes,
  sideMarginRange,
  type PaginationMode,
  type ReaderSettings,
} from "~/components/reader/reader-settings";

export function ReaderSettingsPanel({
  open,
  onOpenChange,
  settings,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: ReaderSettings;
  onChange: (next: ReaderSettings) => void;
}) {
  function update(patch: Partial<ReaderSettings>) {
    onChange({ ...settings, ...patch });
  }

  const segmented: { key: PaginationMode; label: string }[] = [
    { key: "scroll", label: "滚动" },
    { key: "cover", label: "覆盖" },
    { key: "none", label: "无动画" },
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="max-w-[420px] pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>阅读设置</SheetTitle>
        </SheetHeader>
        <SheetBody className="space-y-6">
          <section>
            <Label className="mb-2 block">主题</Label>
            {/* 6 个选项（含跟随系统）：3 列两行，比挤成 6 列更好点 */}
            <div className="grid grid-cols-3 gap-2">
              {readerThemes.map((theme) => (
                <button
                  key={theme.key}
                  type="button"
                  onClick={() => update({ theme: theme.key })}
                  aria-label={theme.label}
                  aria-pressed={settings.theme === theme.key}
                  className={cn(
                    "flex min-h-14 flex-col items-center gap-1.5 rounded-md border p-2 text-[11px] transition-colors",
                    settings.theme === theme.key
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted"
                  )}
                >
                  <span className="size-6 rounded-full border border-black/10" style={{ background: theme.swatch }} />
                  <span className="line-clamp-2 text-center leading-tight">{theme.label}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>字号 {settings.fontSize}px</Label>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="减小字号"
                  disabled={settings.fontSize <= 14}
                  onClick={() => update({ fontSize: Math.max(14, settings.fontSize - 1) })}
                >
                  <Minus className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="增大字号"
                  disabled={settings.fontSize >= 32}
                  onClick={() => update({ fontSize: Math.min(32, settings.fontSize + 1) })}
                >
                  <Plus className="size-4" />
                </Button>
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <Label>行距</Label>
            <Slider
              value={[settings.lineHeight]}
              min={140}
              max={240}
              step={5}
              onValueChange={([value]) => update({ lineHeight: value ?? settings.lineHeight })}
              aria-label="行距"
            />
          </section>

          <section className="space-y-2">
            <Label>段距</Label>
            <Slider
              value={[settings.paragraphSpacing]}
              min={0}
              max={150}
              step={10}
              onValueChange={([value]) => update({ paragraphSpacing: value ?? settings.paragraphSpacing })}
              aria-label="段距"
            />
          </section>

          {/*
            左右留白。手机与窄窗口上「正文宽度」那档行长上限压不到，
            行会一直顶到屏幕两边；这个滑块按比例收边距，两种屏宽都生效。
          */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>左右留白</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                每侧 {settings.sideMargin}%
              </span>
            </div>
            <Slider
              value={[settings.sideMargin]}
              min={sideMarginRange.min}
              max={sideMarginRange.max}
              step={sideMarginRange.step}
              onValueChange={([value]) => update({ sideMargin: value ?? settings.sideMargin })}
              aria-label="左右留白"
            />
          </section>

          <section className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>字体</Label>
              <Select value={settings.fontFamily} onValueChange={(value) => update({ fontFamily: value as ReaderSettings["fontFamily"] })}>
                <SelectTrigger aria-label="字体">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">系统字体</SelectItem>
                  <SelectItem value="serif">宋体阅读</SelectItem>
                  <SelectItem value="hei">黑体阅读</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              {/*
                只在宽屏上起作用：把行长压到上限，窄屏由上面的左右留白负责。
                原来叫「正文宽度」，与「左右留白」看着像同一件事的两种说法，
                这里按它真正干的事命名 —— 一行最多多宽。
              */}
              <Label>宽屏行宽</Label>
              <Select value={settings.margin} onValueChange={(value) => update({ margin: value as ReaderSettings["margin"] })}>
                <SelectTrigger aria-label="宽屏行宽">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="narrow">窄</SelectItem>
                  <SelectItem value="standard">标准</SelectItem>
                  <SelectItem value="wide">宽</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>对齐</Label>
              <Select value={settings.align} onValueChange={(value) => update({ align: value as ReaderSettings["align"] })}>
                <SelectTrigger aria-label="对齐方式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="justify">两端对齐</SelectItem>
                  <SelectItem value="left">左对齐</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>段首缩进</Label>
              <Select value={settings.indent} onValueChange={(value) => update({ indent: value as ReaderSettings["indent"] })}>
                <SelectTrigger aria-label="段首缩进">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2char">2 字符</SelectItem>
                  <SelectItem value="none">无</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </section>

          <section>
            <Label className="mb-2 block">翻页模式</Label>
            <div className="grid grid-cols-3 gap-2">
              {segmented.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => update({ paginationMode: item.key })}
                  aria-pressed={settings.paginationMode === item.key}
                  className={cn(
                    "min-h-11 rounded-md border px-2 text-sm transition-colors",
                    settings.paginationMode === item.key
                      ? "border-primary bg-primary/5 font-medium text-primary"
                      : "border-border text-muted-foreground hover:bg-muted"
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </section>

          <section className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
            <div className="min-w-0">
              <Label htmlFor="reader-allow-copy">正文可复制</Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                关掉后正文不能选中，翻页时不会误选出一片蓝底。
              </p>
            </div>
            <Switch
              id="reader-allow-copy"
              checked={settings.allowCopy}
              onCheckedChange={(checked) => update({ allowCopy: checked })}
              aria-label="正文可复制"
            />
          </section>

          <Button
            variant="outline"
            className="w-full"
            onClick={() => onChange(defaultReaderSettings)}
          >
            <RotateCcw className="size-4" />
            恢复默认
          </Button>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
