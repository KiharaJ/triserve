import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Styled NATIVE select — deliberately not the Radix popover select: these
 * admin forms are dense and register directly with react-hook-form, and the
 * native control is the most reliable + accessible fit for that.
 */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "flex h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        "dark:bg-input/30 [&>option]:bg-background [&>option]:text-foreground",
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
}

export { Select }
