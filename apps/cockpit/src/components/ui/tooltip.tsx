'use client'

import * as React from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

/**
 * shadcn's `radix-nova` tooltip, vendored verbatim except for one line.
 *
 * Stock leans on the style sheet's `cn-tooltip-content` / `cn-tooltip-arrow`
 * rules for the bubble's own padding and radius, and this project ships no such
 * rules — `src/index.css` carries the palette and nothing else, so the class
 * names are inert here and a stock tooltip renders as unpadded text on a solid
 * block. The three utilities added below (`rounded-md px-2 py-1 text-xs`) are
 * layout and type scale only; every colour still comes from the CVA's own
 * `bg-foreground text-background`, which is why nothing here names one.
 */

function TooltipProvider({ delayDuration = 0, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'cn-tooltip-content z-50 w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) rounded-md px-2 py-1 text-xs bg-foreground text-background',
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="cn-tooltip-arrow z-50 size-2 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
