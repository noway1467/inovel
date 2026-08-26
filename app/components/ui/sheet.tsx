import * as React from "react";
import { Drawer as DrawerPrimitive } from "vaul";
import { X } from "lucide-react";
import { cn } from "~/lib/utils";

function Sheet({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root {...props} />;
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger {...props} />;
}

function SheetClose({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close {...props} />;
}

function SheetPortal({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal {...props} />;
}

function SheetOverlay({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return (
    <DrawerPrimitive.Overlay
      className={cn("fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]", className)}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = "bottom",
  showClose = true,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content> & {
  side?: "top" | "bottom" | "left" | "right";
  showClose?: boolean;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DrawerPrimitive.Content
        className={cn(
          "fixed z-50 flex flex-col bg-surface text-foreground shadow-xl outline-none",
          side === "bottom" && "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-lg",
          side === "top" && "inset-x-0 top-0 max-h-[88dvh] rounded-b-lg",
          side === "left" && "inset-y-0 left-0 h-full w-[min(92vw,400px)] rounded-r-lg",
          side === "right" && "inset-y-0 right-0 h-full w-[min(92vw,400px)] rounded-l-lg",
          className
        )}
        {...props}
      >
        {side === "bottom" && <div className="mx-auto mt-3 h-1.5 w-10 rounded-full bg-muted" />}
        {showClose && (
          <DrawerPrimitive.Close className="absolute right-3 top-3 flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted">
            <X className="size-4" />
            <span className="sr-only">关闭</span>
          </DrawerPrimitive.Close>
        )}
        {children}
      </DrawerPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("grid gap-1.5 p-4 pb-0", className)} {...props} />;
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return <DrawerPrimitive.Title className={cn("text-base font-semibold", className)} {...props} />;
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return <DrawerPrimitive.Description className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("overflow-y-auto px-4 py-4", className)} {...props} />;
}

export {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};

