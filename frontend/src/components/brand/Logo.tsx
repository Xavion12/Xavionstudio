import { cn } from '@/utils/cn'

/** The gym's mark (public/brand/mark.png, built from brand/xavion-logo.png by `npm run icons`). */
export function LogoMark({ className }: { className?: string }) {
  return <img src="/brand/mark.png" alt="" aria-hidden width={64} height={64} className={cn('size-9 shrink-0 rounded-[22%] object-contain', className)} />
}

export function Logo({ name = '', className, compact }: { name?: string; className?: string; compact?: boolean }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <LogoMark />
      {!compact && <span className="truncate text-[17px] font-bold tracking-tight text-ink">{name}</span>}
    </span>
  )
}
