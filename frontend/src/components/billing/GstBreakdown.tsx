import { useConfig } from '@/contexts/ConfigContext'
import { cn } from '@/utils/cn'
import { formatMoney } from '@/utils/format'
import { gstSplit, halfRate } from '@/utils/gst'

/** "Price ₹21,999 = ₹20,951.43 + CGST 2.5% ₹523.79 + SGST 2.5% ₹523.78", for billing screens. */
export function GstBreakdown({ amount, className }: { amount: number; className?: string }) {
  const { gst_rate } = useConfig()
  const split = gstSplit(amount, gst_rate)
  if (!split) return null
  const rows: [string, number, boolean?][] = [
    ['Taxable value', split.taxable],
    [`CGST ${halfRate(split.rate)}`, split.cgst],
    [`SGST ${halfRate(split.rate)}`, split.sgst],
    [`Total (incl. ${split.rate}% GST)`, amount, true],
  ]
  return (
    <dl className={cn('rounded-xl border border-line bg-subtle px-4 py-2.5 text-[13px]', className)} aria-label="GST breakdown">
      {rows.map(([label, value, strong]) => (
        <div key={label} className={cn('flex items-center justify-between gap-4 py-0.5', strong && 'mt-1 border-t border-line pt-1.5')}>
          <dt className={strong ? 'font-semibold text-ink' : 'text-muted'}>{label}</dt>
          <dd className={cn('tabular', strong ? 'font-bold text-ink' : 'text-ink-2')}>{formatMoney(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Short line under a price: "incl. ₹1,047.57 GST (5%)". */
export function GstNote({ amount, className }: { amount: number; className?: string }) {
  const { gst_rate } = useConfig()
  const split = gstSplit(amount, gst_rate)
  if (!split) return null
  return <p className={cn('text-[12px] text-muted', className)}>incl. {formatMoney(split.amount)} GST ({split.rate}%)</p>
}
