import * as React from 'react'
import { cn } from '@/lib/utils'

const Input = React.forwardRef(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        'pc-input flex w-full rounded-lg border border-[rgba(255,255,255,0.12)] bg-[#1a1e28] px-3 py-[10px] text-[14px] text-[#f0f2f7] placeholder:text-[#555b6e] transition-colors focus:outline-none focus:ring-0 focus:shadow-none focus:border-[#00d4aa] disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Input.displayName = 'Input'

export { Input }
