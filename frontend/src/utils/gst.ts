/**
 * GST included in a price (paise), split back out exactly as the server does (backend/src/utils/gst.py):
 *
 *   taxable = price × 100 / (100 + rate)       ₹21,999 at 5% → ₹20,951.43
 *   GST     = price − taxable                                  →  ₹1,047.57
 *   CGST    = half (with the odd paisa), SGST = the rest       →    ₹523.79 + ₹523.78
 */
export interface GstSplit {
  rate: number
  taxable: number
  amount: number
  cgst: number
  sgst: number
}

export function gstSplit(paise: number, rate: number | null | undefined): GstSplit | null {
  if (!rate || !(paise > 0)) return null
  const taxable = Math.round((paise * 100) / (100 + rate))
  const amount = paise - taxable
  const sgst = Math.floor(amount / 2)
  return { rate, taxable, amount, cgst: amount - sgst, sgst }
}

/** "2.5%" / "9%" */
export function halfRate(rate: number): string {
  const half = rate / 2
  return `${Number.isInteger(half) ? half : half.toFixed(1)}%`
}
