import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { modeStorageKey } from "~/lib/skins";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(modeStorageKey, next ? "dark" : "light");
    } catch {
      // 隐私模式等场景下忽略本地存储失败
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={dark ? "切换到浅色模式" : "切换到深色模式"} onClick={toggle}>
          {dark ? <Sun className="size-5" /> : <Moon className="size-5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{dark ? "浅色模式" : "深色模式"}</TooltipContent>
    </Tooltip>
  );
}

