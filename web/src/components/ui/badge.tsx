import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ring-1 ring-inset [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground ring-transparent",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground ring-border",
        destructive:
          "border-transparent bg-destructive/10 text-destructive ring-destructive/20",
        success:
          "border-transparent bg-emerald-500/15 text-emerald-700 ring-emerald-500/25 dark:text-emerald-400",
        warning:
          "border-transparent bg-amber-500/15 text-amber-700 ring-amber-500/25 dark:text-amber-400",
        info: "border-transparent bg-sky-500/15 text-sky-700 ring-sky-500/25 dark:text-sky-400",
        outline: "text-foreground ring-border",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
