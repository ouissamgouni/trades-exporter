import * as RadixTooltip from "@radix-ui/react-tooltip"
import * as React from "react"
import { cn } from "../../lib/cn"

export interface TooltipProps {
  content: React.ReactNode
  children: React.ReactNode
  showArrow?: boolean
  disabled?: boolean
  portalled?: boolean
  /** Open delay in ms (maps to Radix `delayDuration`). */
  openDelay?: number
  /** Accepted for API parity with the previous Chakra wrapper; not used by Radix. */
  closeDelay?: number
  side?: "top" | "right" | "bottom" | "left"
  contentProps?: React.ComponentPropsWithoutRef<typeof RadixTooltip.Content>
}

export const Tooltip = React.forwardRef<HTMLDivElement, TooltipProps>(
  function Tooltip(props, ref) {
    const {
      content,
      children,
      showArrow,
      disabled,
      portalled = true,
      openDelay = 200,
      side = "top",
      contentProps,
    } = props

    if (disabled) return <>{children}</>

    // Square corners by design system: no rounded utilities.
    const body = (
      <RadixTooltip.Content
        ref={ref}
        side={side}
        sideOffset={4}
        {...contentProps}
        className={cn(
          "z-50 max-w-xs whitespace-pre-line bg-slate-900 px-2 py-1 text-xs text-white shadow-md",
          contentProps?.className,
        )}
      >
        {content}
        {showArrow && <RadixTooltip.Arrow className="fill-slate-900" />}
      </RadixTooltip.Content>
    )

    return (
      <RadixTooltip.Provider delayDuration={openDelay}>
        <RadixTooltip.Root>
          <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
          {portalled ? <RadixTooltip.Portal>{body}</RadixTooltip.Portal> : body}
        </RadixTooltip.Root>
      </RadixTooltip.Provider>
    )
  },
)
