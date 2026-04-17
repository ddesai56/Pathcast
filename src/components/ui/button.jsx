import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-all focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'pc-btn-primary bg-[#00d4aa] text-black font-semibold hover:opacity-[0.88]',
        outline: 'border border-[rgba(255,255,255,0.12)] bg-transparent text-[#f0f2f7] hover:bg-[#1a1e28]',
        ghost: 'bg-transparent text-[#f0f2f7] hover:bg-[#1a1e28]',
        destructive: 'bg-[#ff4757] text-white hover:opacity-90',
      },
      size: {
        default: 'rounded-lg px-5 py-[10px] text-[13px]',
        sm: 'rounded-lg px-3 py-2 text-[12px]',
        lg: 'rounded-lg px-6 py-3 text-[14px]',
        icon: 'h-9 w-9 rounded-lg',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  )
})
Button.displayName = 'Button'

export { Button, buttonVariants }
