// Free WhatsApp sending from the gym's own phone: a wa.me link opens WhatsApp with the message
// already typed for the member; staff tap Send. Nothing goes through any paid API.
import type { Receipt } from '@/types'
import { formatMoney, METHOD_LABELS } from './format'

function shortDate(value: string | null | undefined): string {
  if (!value) return ''
  const [y, m, d] = value.slice(0, 10).split('-').map(Number)
  return `${String(d).padStart(2, '0')}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}-${y}`
}

/** The message staff send with a receipt (WhatsApp formatting: *bold*). */
export function receiptMessage(receipt: Receipt): string {
  const first = receipt.member_name.split(' ')[0] || receipt.member_name
  const gym = receipt.gym.name
  const method = (METHOD_LABELS[receipt.payment_method] ?? receipt.payment_method).replace(' (manual)', '')
  if (receipt.status === 'REFUNDED' && receipt.refund) {
    return [
      `Hi ${first},`,
      '',
      `A refund of *${formatMoney(receipt.refund.amount)}* for receipt ${receipt.receipt_number} has been recorded by ${gym}.`,
      '',
      `- ${gym}`,
    ].join('\n')
  }
  const lines = [
    `Hi ${first},`,
    '',
    `Thank you! We have received your payment at *${gym}*.`,
    '',
    `*Receipt:* ${receipt.receipt_number}`,
    `*Plan:* ${receipt.plan_name}`,
  ]
  if (receipt.membership_start && receipt.membership_end) {
    lines.push(`*Valid:* ${shortDate(receipt.membership_start)} to ${shortDate(receipt.membership_end)}`)
  }
  if (receipt.discount > 0) lines.push(`*Discount:* ${formatMoney(receipt.discount)}`)
  lines.push(`*Amount paid:* ${formatMoney(receipt.amount)} (${method})`, `*Date:* ${shortDate(receipt.payment_date)}`, '', 'See you at the gym!', `- ${gym}`)
  return lines.join('\n')
}

/** https://wa.me/<number>?text=... (number = country code + digits). */
export function whatsAppLink(number: string | null | undefined, text: string): string {
  const digits = (number ?? '').replace(/\D/g, '')
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
}

/** Country code + local number for wa.me: "98765 43210" -> "919876543210". */
export function whatsAppNumber(phone: string | null | undefined, countryCode = '91'): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 10) return `${countryCode}${digits}`
  if (digits.length === 11 && digits.startsWith('0')) return `${countryCode}${digits.slice(1)}`
  return digits
}

/** Open the chat in a new tab / the WhatsApp app (call this straight from a click). */
export function openWhatsApp(number: string | null | undefined, text: string): boolean {
  if (!number) return false
  window.open(whatsAppLink(number, text), '_blank', 'noopener')
  return true
}

const firstName = (name: string) => name.split(' ')[0] || name

export function welcomeMessage(m: { name: string; member_code: string; gym: string; appUrl?: string; login?: string; password?: string | null }): string {
  const lines = [`Hi ${firstName(m.name)},`, '', `Welcome to *${m.gym}*! 💪`, '', `*Member ID:* ${m.member_code}`]
  if (m.appUrl && m.login) {
    lines.push('', `*Member app:* ${m.appUrl}`, `*Login:* ${m.login}`)
    if (m.password) lines.push(`*One-time password:* ${m.password}`, 'You will choose your own password when you sign in.')
  }
  lines.push('', 'See you at the gym!', `- ${m.gym}`)
  return lines.join('\n')
}

export function paymentFailedMessage(p: { name: string; amount: string; utr?: string | null; reason?: string | null; gym: string }): string {
  return [
    `Hi ${firstName(p.name)},`,
    '',
    `We couldn't verify your payment of *${p.amount}*${p.utr ? ` (UTR ${p.utr})` : ''}.`,
    ...(p.reason ? [`Reason: ${p.reason}`] : []),
    '',
    'Please check with your bank / UPI app or contact the front desk.',
    `- ${p.gym}`,
  ].join('\n')
}

export function expiryMessage(e: { name: string; plan?: string | null; end?: string | null; daysLeft?: number | null; gym: string }): string {
  const expired = e.daysLeft != null && e.daysLeft < 0
  const when = e.daysLeft == null ? '' : e.daysLeft === 0 ? ' today' : e.daysLeft === 1 ? ' tomorrow' : expired ? '' : ` in ${e.daysLeft} days`
  return [
    `Hi ${firstName(e.name)},`,
    '',
    expired
      ? `Your ${e.plan ? `*${e.plan}* ` : ''}membership at *${e.gym}* expired${e.end ? ` on ${e.end}` : ''}.`
      : `Your ${e.plan ? `*${e.plan}* ` : ''}membership at *${e.gym}* ends${when}${e.end ? ` (${e.end})` : ''}.`,
    '',
    expired ? 'Renew today to continue training - we would love to see you back!' : 'Renew at the front desk or in the member app to keep training without a break.',
    `- ${e.gym}`,
  ].join('\n')
}

export function memberReportMessage(r: { name: string; gym: string; from: string; to: string; lines: string[] }): string {
  return [`Hi ${firstName(r.name)},`, '', `Your report from *${r.gym}* (${r.from} to ${r.to}):`, '', ...r.lines, '', 'Keep it up!', `- ${r.gym}`].join('\n')
}
