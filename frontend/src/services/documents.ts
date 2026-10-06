// Receipts and reports are generated on demand in the browser from JSON the API returns.
// Nothing is stored on the server (no PDFs, no files) — the admin downloads and keeps them.
import type { MemberReport, MemberReportSection, PaymentMethod, Receipt, ReportData, ReportKind } from '@/types'
import { csvBlob, toCsv, type Cell } from '@/utils/csv'
import { saveBlob } from '@/utils/download'
import {
  amountInWords,
  CATEGORY_LABELS,
  METHOD_LABELS,
  formatDate,
  formatDateTime,
  formatDateTimeCsv,
  formatDateTimeShort,
  formatMoney,
  formatNumber,
  formatTime,
  paiseToDecimal,
} from '@/utils/format'
import { hexColor, loadJpeg, PdfDocument, textWidth, wrapText, type Color, type JpegImage } from '@/utils/pdf'

// Print palette (documents are always printed light, whatever the app theme).
const INK = hexColor('#16181d')
const MUTED = hexColor('#5b606b')
const FAINT = hexColor('#8f95a1')
const LINE = hexColor('#e3e5e9')
const ZEBRA = hexColor('#f6f7f9')
const HEAD = hexColor('#eceef1')
const BAND = hexColor('#16181d')
const LIME = hexColor('#c6f432')
const WHITE: Color = [1, 1, 1]

type Format = 'money' | 'date' | 'datetime' | 'time' | 'method' | 'category' | 'text' | 'number'

export interface ReportColumn {
  key: string
  label: string
  format?: Format
  /** Relative width in the PDF table. */
  weight: number
}

export const REPORT_COLUMNS: Record<ReportKind, ReportColumn[]> = {
  members: [
    { key: 'member_code', label: 'Member ID', weight: 1.1 },
    { key: 'name', label: 'Name', weight: 1.8 },
    { key: 'phone', label: 'Phone', weight: 1.2 },
    { key: 'email', label: 'Email', weight: 2 },
    { key: 'gender', label: 'Gender', weight: 0.8 },
    { key: 'joining_date', label: 'Joined', format: 'date', weight: 1 },
    { key: 'status', label: 'Status', weight: 0.9 },
    { key: 'trainer', label: 'Trainer', weight: 1.4 },
    { key: 'expiry_date', label: 'Membership ends', format: 'date', weight: 1.2 },
  ],
  memberships: [
    { key: 'member_code', label: 'Member ID', weight: 1.1 },
    { key: 'name', label: 'Name', weight: 1.9 },
    { key: 'plan', label: 'Plan', weight: 1.2 },
    { key: 'start_date', label: 'Start', format: 'date', weight: 1 },
    { key: 'end_date', label: 'End', format: 'date', weight: 1 },
    { key: 'amount', label: 'Amount', format: 'money', weight: 1 },
    { key: 'status', label: 'Status', weight: 1 },
  ],
  payments: [
    { key: 'payment_number', label: 'Payment No.', weight: 1.35 },
    { key: 'payment_date', label: 'Date', format: 'date', weight: 1.05 },
    { key: 'member_code', label: 'Member ID', weight: 1.1 },
    { key: 'name', label: 'Name', weight: 1.3 },
    { key: 'plan', label: 'Plan', weight: 0.9 },
    { key: 'payment_method', label: 'Method', format: 'method', weight: 1.15 },
    { key: 'transaction_reference', label: 'UTR / Ref.', weight: 1.2 },
    { key: 'amount', label: 'Amount', format: 'money', weight: 0.95 },
    { key: 'status', label: 'Status', weight: 1.05 },
    { key: 'refund_amount', label: 'Refunded', format: 'money', weight: 0.9 },
    { key: 'verified_by', label: 'Verified by', weight: 1 },
    { key: 'verified_at', label: 'Verified at', format: 'datetime', weight: 1.6 },
  ],
  attendance: [
    { key: 'attendance_date', label: 'Date', format: 'date', weight: 1 },
    { key: 'member_code', label: 'Member ID', weight: 1 },
    { key: 'name', label: 'Name', weight: 2 },
    { key: 'check_in', label: 'Check-in', format: 'time', weight: 0.9 },
    { key: 'check_out', label: 'Check-out', format: 'time', weight: 0.9 },
    { key: 'minutes', label: 'Minutes', format: 'number', weight: 0.75 },
    { key: 'method', label: 'Method', weight: 0.8 },
  ],
  expenses: [
    { key: 'expense_date', label: 'Date', format: 'date', weight: 1 },
    { key: 'category', label: 'Category', format: 'category', weight: 1.1 },
    { key: 'description', label: 'Description', weight: 3 },
    { key: 'amount', label: 'Amount', format: 'money', weight: 1 },
    { key: 'recorded_by', label: 'Recorded by', weight: 1.2 },
  ],
}

function csvCell(value: unknown, format: Format = 'text'): Cell {
  if (value === null || value === undefined || value === '') return ''
  switch (format) {
    case 'money':
      return paiseToDecimal(Number(value))
    case 'datetime':
      return formatDateTimeCsv(String(value))
    case 'time':
      return formatDateTimeCsv(String(value)).slice(11)
    case 'method':
      return METHOD_LABELS[String(value)] ?? String(value)
    case 'category':
      return CATEGORY_LABELS[String(value)] ?? String(value)
    default:
      return value as Cell
  }
}

export function displayCell(value: unknown, format: Format = 'text'): string {
  if (value === null || value === undefined || value === '') return '-'
  switch (format) {
    case 'money':
      return formatMoney(Number(value))
    case 'date':
      return formatDate(String(value))
    case 'datetime':
      return formatDateTimeShort(String(value))
    case 'time':
      return formatTime(String(value))
    case 'method':
      return METHOD_LABELS[String(value)] ?? String(value)
    case 'category':
      return CATEGORY_LABELS[String(value)] ?? String(value)
    case 'number':
      return formatNumber(Number(value))
    default:
      return String(value)
  }
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/** e.g. Xavion_Fitness_Studio_Payment_Report_2026-09-01_to_2026-09-24.csv */
export function reportFileName(report: ReportData, extension: 'csv' | 'pdf'): string {
  return `${slug(report.gym_name) || 'Gym'}_${slug(report.title)}_${report.from}_to_${report.to}.${extension}`
}

// -- summaries ------------------------------------------------------------------------------------
export interface SummaryItem {
  label: string
  value: string
}

type Rows<T> = T[] | undefined

/** The headline numbers of a report, shown on screen and at the top of the PDF. */
export function reportSummary(report: ReportData): { stats: SummaryItem[]; breakdown: SummaryItem[] } {
  const s = report.summary as Record<string, unknown>
  const n = (key: string) => formatNumber(Number(s[key] ?? 0))
  const m = (key: string) => formatMoney(Number(s[key] ?? 0))
  switch (report.kind) {
    case 'members':
      return {
        stats: [
          { label: 'Total members', value: n('total') },
          { label: 'Active', value: n('active') },
          { label: 'Expired', value: n('expired') },
          { label: 'Inactive', value: n('inactive') },
          { label: 'Suspended', value: n('suspended') },
          { label: 'Joined in period', value: n('new_members') },
        ],
        breakdown: [],
      }
    case 'memberships': {
      const plans = (s.plans as Rows<{ plan: string; active: number; expired: number; renewals: number; started: number; amount: number }>) ?? []
      return {
        stats: [
          { label: 'Started in period', value: formatNumber(plans.reduce((t, p) => t + p.started, 0)) },
          { label: 'Renewals', value: formatNumber(plans.reduce((t, p) => t + p.renewals, 0)) },
          { label: 'Active now', value: formatNumber(plans.reduce((t, p) => t + p.active, 0)) },
          { label: 'Value started', value: formatMoney(plans.reduce((t, p) => t + p.amount, 0)) },
        ],
        breakdown: plans.map((p) => ({
          label: p.plan,
          value: `${formatNumber(p.started)} started · ${formatNumber(p.renewals)} renewals · ${formatNumber(p.active)} active · ${formatMoney(p.amount)}`,
        })),
      }
    }
    case 'payments': {
      const methods = (s.methods as Rows<{ method: PaymentMethod; count: number; amount: number }>) ?? []
      const statuses = (s.statuses as Rows<{ status: string; count: number; amount: number }>) ?? []
      return {
        stats: [
          { label: 'Collected', value: m('collected') },
          { label: 'Refunded', value: `${m('refunds')} (${n('refund_count')})` },
          { label: 'Net revenue', value: m('total_revenue') },
          { label: 'Payments', value: formatNumber(statuses.reduce((t, x) => t + x.count, 0)) },
        ],
        breakdown: [
          ...methods.map((x) => ({ label: METHOD_LABELS[x.method] ?? x.method, value: `${formatNumber(x.count)} · ${formatMoney(x.amount)}` })),
          ...statuses.map((x) => ({ label: `Status ${x.status}`, value: `${formatNumber(x.count)} · ${formatMoney(x.amount)}` })),
        ],
      }
    }
    case 'attendance': {
      // "members" = members present that day (several visits by one member count once).
      const daily = (s.daily as Rows<{ date: string; members?: number; visits: number }>) ?? []
      const present = (d: { members?: number; visits: number }) => d.members ?? d.visits
      const attended = Number(s.member_days ?? s.total_visits ?? 0)
      const busiest = daily.reduce<(typeof daily)[number] | null>((best, d) => (!best || present(d) > present(best) ? d : best), null)
      return {
        stats: [
          { label: 'Days attended', value: formatNumber(attended) },
          { label: 'Visits', value: n('total_visits') },
          { label: 'Different members', value: s.unique_members === undefined ? '-' : n('unique_members') },
          { label: 'Members a day', value: daily.length ? formatNumber(Math.round(attended / daily.length)) : '0' },
          { label: 'Busiest day', value: busiest ? `${formatDate(busiest.date, { withYear: false })} (${formatNumber(present(busiest))})` : '-' },
        ],
        breakdown: ((s.monthly as Rows<{ month: string; members?: number; visits: number; days: number }>) ?? []).map((x) => ({
          label: x.month,
          value: `${formatNumber(x.members ?? x.visits)} attended · ${formatNumber(x.visits)} visits over ${formatNumber(x.days)} days`,
        })),
      }
    }
    case 'expenses': {
      const categories = (s.categories as Rows<{ category: string; count: number; amount: number }>) ?? []
      return {
        stats: [
          { label: 'Total expenses', value: m('total') },
          { label: 'Entries', value: formatNumber(categories.reduce((t, c) => t + c.count, 0)) },
        ],
        breakdown: categories.map((c) => ({
          label: CATEGORY_LABELS[c.category] ?? c.category,
          value: `${formatNumber(c.count)} · ${formatMoney(c.amount)}`,
        })),
      }
    }
  }
}

// -- CSV ---------------------------------------------------------------------------------------------
export function reportCsv(report: ReportData): Blob {
  const columns = REPORT_COLUMNS[report.kind]
  const rows = report.rows.map((row) => columns.map((c) => csvCell(row[c.key], c.format)))
  return csvBlob(toCsv(columns.map((c) => c.label), rows, { neutralize: true }))
}

// -- PDF ---------------------------------------------------------------------------------------------
const MARGIN = 36

function footer(pdf: PdfDocument, left: string): void {
  const total = pdf.pageCount
  for (let index = 0; index < total; index++) {
    pdf.onPage(index, () => {
      const y = pdf.height - 26
      pdf.line(MARGIN, y - 6, pdf.width - MARGIN, y - 6, { color: LINE })
      pdf.text(MARGIN, y, left, { size: 7.5, color: FAINT, maxWidth: pdf.width / 2 })
      pdf.text(pdf.width - MARGIN, y, `Page ${index + 1} of ${total}`, { size: 7.5, color: FAINT, align: 'right' })
    })
  }
}

export async function reportPdf(report: ReportData): Promise<Blob> {
  const columns = REPORT_COLUMNS[report.kind]
  const landscape = columns.length > 6
  const pdf = new PdfDocument({ landscape, title: `${report.gym_name} - ${report.title}`, author: report.gym_name })
  const width = pdf.width - MARGIN * 2
  const bottom = pdf.height - 48

  // Header band (logo on a white tile, then the gym and the report's name)
  pdf.rect(0, 0, pdf.width, 70, { fill: BAND })
  pdf.rect(0, 70, pdf.width, 3, { fill: LIME })
  const titleX = (await drawLogoTile(pdf, MARGIN, 9, 96, 52)) ? MARGIN + 108 : MARGIN
  pdf.text(titleX, 18, report.gym_name, { size: 15, bold: true, color: WHITE, maxWidth: width * 0.5 })
  pdf.text(titleX, 40, report.title.toUpperCase(), { size: 10, bold: true, color: LIME })
  pdf.text(pdf.width - MARGIN, 20, `${formatDate(report.from)} - ${formatDate(report.to)}`, { size: 10, bold: true, color: WHITE, align: 'right' })
  pdf.text(pdf.width - MARGIN, 38, `Generated ${formatDateTime(report.generated_at)}`, { size: 8, color: [0.8, 0.82, 0.86], align: 'right' })

  // Summary tiles
  let y = 92
  const { stats, breakdown } = reportSummary(report)
  const gap = 8
  const tileWidth = (width - gap * (stats.length - 1)) / stats.length
  stats.forEach((item, i) => {
    const x = MARGIN + i * (tileWidth + gap)
    pdf.rect(x, y, tileWidth, 42, { fill: ZEBRA, stroke: LINE, radius: 6 })
    pdf.text(x + 10, y + 8, item.label.toUpperCase(), { size: 6.5, bold: true, color: MUTED, maxWidth: tileWidth - 20 })
    pdf.text(x + 10, y + 21, item.value, { size: 12, bold: true, color: INK, maxWidth: tileWidth - 20 })
  })
  y += 54
  if (breakdown.length) {
    const perRow = landscape ? 3 : 2
    const cell = width / perRow
    breakdown.forEach((item, i) => {
      const x = MARGIN + (i % perRow) * cell
      if (i % perRow === 0 && i > 0) y += 14
      pdf.text(x, y, `${item.label}:`, { size: 8, bold: true, color: INK, maxWidth: cell * 0.35 })
      pdf.text(x + cell * 0.36, y, item.value, { size: 8, color: MUTED, maxWidth: cell * 0.62 })
    })
    y += 24
  }
  if (report.truncated) {
    pdf.text(MARGIN, y, `Showing the first ${formatNumber(report.row_cap)} rows. Choose a shorter period for the complete list.`, {
      size: 8,
      bold: true,
      color: hexColor('#9a3412'),
    })
    y += 16
  }

  // Table
  const totalWeight = columns.reduce((t, c) => t + c.weight, 0)
  const widths = columns.map((c) => (c.weight / totalWeight) * width)
  const rightAligned = (c: ReportColumn) => c.format === 'money' || c.format === 'number'
  const rowHeight = 16
  const drawHeader = () => {
    pdf.rect(MARGIN, y, width, 20, { fill: HEAD })
    let x = MARGIN
    columns.forEach((c, i) => {
      const w = widths[i]
      pdf.text(rightAligned(c) ? x + w - 5 : x + 5, y + 6, c.label, { size: 7.5, bold: true, color: MUTED, maxWidth: w - 10, align: rightAligned(c) ? 'right' : 'left' })
      x += w
    })
    y += 20
  }
  drawHeader()
  if (!report.rows.length) {
    pdf.text(MARGIN + width / 2, y + 18, 'No records in this period.', { size: 10, color: MUTED, align: 'center' })
  }
  report.rows.forEach((row, index) => {
    if (y + rowHeight > bottom) {
      pdf.addPage()
      y = MARGIN
      drawHeader()
    }
    if (index % 2 === 1) pdf.rect(MARGIN, y, width, rowHeight, { fill: ZEBRA })
    let x = MARGIN
    columns.forEach((c, i) => {
      const w = widths[i]
      pdf.text(rightAligned(c) ? x + w - 5 : x + 5, y + 4.5, displayCell(row[c.key], c.format), {
        size: 8,
        color: INK,
        maxWidth: w - 10,
        align: rightAligned(c) ? 'right' : 'left',
      })
      x += w
    })
    y += rowHeight
  })
  pdf.line(MARGIN, y, MARGIN + width, y, { color: LINE })
  y += 18
  if (y + SIGN_OFF_HEIGHT > bottom) {
    pdf.addPage()
    y = MARGIN
  }
  await drawSignOff(pdf, MARGIN, MARGIN + width, y, {
    gymName: report.gym_name,
    signer: report.signatory || report.gym_name,
    stampWord: 'VERIFIED',
    ringText: 'VERIFIED REPORT',
    stampDate: dashDateTime(report.generated_at),
    signedAt: formatDateTime(report.generated_at),
    note: 'This is a computer-generated report.',
  })
  footer(pdf, `${report.gym_name} · ${report.title} · ${formatNumber(report.rows.length)} rows`)
  return pdf.output()
}

export async function downloadReport(report: ReportData, format: 'csv' | 'pdf'): Promise<void> {
  const blob = format === 'csv' ? reportCsv(report) : await reportPdf(report)
  saveBlob(blob, reportFileName(report, format))
}

// -- receipt -------------------------------------------------------------------------------------------
const STAMP_INK = hexColor('#1f3c88') // rubber-stamp blue
const SIGN_INK = hexColor('#14285e') // pen blue
const WATERMARK = hexColor('#f1f2f4')

/** 26-Feb-2026 */
function dashDate(value: string | null | undefined): string {
  if (!value) return '-'
  const [y, m, d] = value.slice(0, 10).split('-').map(Number)
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]
  return `${String(d).padStart(2, '0')}-${month}-${y}`
}

/** "2.5%" / "9%" */
function percent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`
}

/** The round PAID seal: gym name around the top, "PAYMENT RECEIVED" along the bottom. */
function drawSeal(pdf: PdfDocument, cx: number, cy: number, gym: string, date: string, tilt = 0, word = 'PAID', ring = 'PAYMENT RECEIVED'): void {
  // A rubber stamp is never pressed perfectly straight: everything is turned by ``tilt`` degrees.
  const rad = (tilt * Math.PI) / 180
  const at = (dx: number, dy: number): [number, number] => [cx + dx * Math.cos(rad) + dy * Math.sin(rad), cy - dx * Math.sin(rad) + dy * Math.cos(rad)]
  const outer = 46
  pdf.circle(cx, cy, outer, { stroke: STAMP_INK, lineWidth: 2.2 })
  pdf.circle(cx, cy, outer - 4, { stroke: STAMP_INK, lineWidth: 0.7 })
  pdf.circle(cx, cy, outer - 18, { stroke: STAMP_INK, lineWidth: 0.7 })
  const name = gym.toUpperCase()
  let size = 8
  while (size > 5.5 && textWidth(name, size, true) > Math.PI * (outer - 13) * 0.95) size -= 0.25
  pdf.circularText(cx, cy, outer - 13.5, name, 90 + tilt, { size, bold: true, color: STAMP_INK })
  pdf.circularText(cx, cy, outer - 8, ring, 270 + tilt, { size: 6, bold: true, color: STAMP_INK, inward: true })
  const write = (dx: number, baseline: number, text: string, textSize: number) => {
    const [x, y] = at(dx, baseline)
    pdf.rotatedText(x, y, text, tilt, { size: textSize, bold: true, color: STAMP_INK, align: 'center' })
  }
  write(-24, 3, '*', 8)
  write(24, 3, '*', 8)
  let wordSize = 14
  while (wordSize > 8 && textWidth(word, wordSize, true) > 50) wordSize -= 0.5
  write(0, 4, word, wordSize)
  write(0, 15, date, 6.5)
}

/** A small tick, like the "valid signature" mark on a digitally signed document. */
function drawTick(pdf: PdfDocument, x: number, y: number, size: number, color: Color): void {
  pdf.line(x, y + size * 0.55, x + size * 0.38, y + size, { color, width: 1.4 })
  pdf.line(x + size * 0.38, y + size, x + size, y, { color, width: 1.4 })
}

let logoPromise: Promise<JpegImage | null> | null = null
function receiptLogo(): Promise<JpegImage | null> {
  logoPromise ??= loadJpeg('/receipt-logo.jpg')
  return logoPromise
}

/** The owner's handwritten signature, if a scan has been added as public/receipt-signature.jpg. */
let signaturePromise: Promise<JpegImage | null> | null = null
function receiptSignature(): Promise<JpegImage | null> {
  signaturePromise ??= loadJpeg('/receipt-signature.jpg')
  return signaturePromise
}

export interface SignOff {
  gymName: string
  /** Name on the digital signature. */
  signer: string
  /** Word in the middle of the stamp (PAID, VERIFIED ...) and the text along its bottom rim. */
  stampWord: string
  ringText: string
  stampDate: string
  signedAt: string
  /** Small print on the left, e.g. "This is a computer-generated receipt." */
  note: string
}

/** Height the sign-off block needs; callers start a new page when less is left. */
export const SIGN_OFF_HEIGHT = 140

/** "For <gym>", the digital signature (or the scanned signature), the line and "Authorised
 *  Signatory", with the stamp pressed beside it like a real rubber stamp. Every PDF ends with it. */
export async function drawSignOff(pdf: PdfDocument, left: number, right: number, top: number, s: SignOff): Promise<void> {
  const lineY = top + 104
  pdf.text(right, top + 4, `For ${s.gymName.toUpperCase()}`, { size: 8.5, bold: true, color: INK, align: 'right', maxWidth: 220 })
  const signature = await receiptSignature()
  if (signature) {
    pdf.image(right - 150, lineY - 76, 150, 46, signature)
  } else {
    let signSize = 22
    while (signSize > 12 && textWidth(s.signer, signSize, false) > 165) signSize -= 1
    pdf.text(right - 4, lineY - 64, s.signer, { size: signSize, italic: true, color: SIGN_INK, align: 'right' })
  }
  const tickColor = hexColor('#1e8e3e')
  const digital = `Digitally signed by ${s.signer}`
  const digitalWidth = Math.min(165, textWidth(digital, 7, true))
  drawTick(pdf, right - digitalWidth - 13, lineY - 27, 8, tickColor)
  pdf.text(right, lineY - 27, digital, { size: 7, bold: true, color: tickColor, align: 'right', maxWidth: 165 })
  pdf.text(right, lineY - 17, `Date: ${s.signedAt}`, { size: 6.5, color: MUTED, align: 'right' })
  pdf.line(right - 170, lineY, right, lineY, { color: INK, width: 0.7 })
  pdf.text(right, lineY + 5, 'Authorised Signatory', { size: 8, color: MUTED, align: 'right' })
  drawSeal(pdf, right - 176, lineY - 34, s.gymName, s.stampDate, -12, s.stampWord, s.ringText)
  pdf.text(left, lineY + 5, s.note, { size: 7.5, color: FAINT })
}

/** The logo on a white tile, for dark header bands. */
async function drawLogoTile(pdf: PdfDocument, x: number, y: number, w: number, h: number): Promise<boolean> {
  const logo = await receiptLogo()
  if (!logo) return false
  pdf.rect(x, y, w, h, { fill: WHITE, radius: 6 })
  pdf.image(x + 6, y + 4, w - 12, h - 8, logo)
  return true
}

/** 26-Feb-2026 for a timestamp, in the gym's time zone. */
function dashDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const local = new Date(iso)
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(local)
  return dashDate(ymd)
}

export async function receiptPdf(receipt: Receipt): Promise<Blob> {
  const gym = receipt.gym
  const pdf = new PdfDocument({ title: `${gym.name} - Receipt ${receipt.receipt_number}`, author: gym.name })
  const left = 40
  const right = pdf.width - 40
  const width = right - left
  const bottomLimit = pdf.height - 64
  const logo = await receiptLogo()

  const watermark = () => {
    const mark = gym.name.toUpperCase()
    let size = 64
    while (size > 30 && textWidth(mark, size, true) > pdf.height * 0.95) size -= 2
    pdf.rotatedText(pdf.width / 2, pdf.height / 2 + 40, mark, 52, { size, bold: true, color: WATERMARK, align: 'center' })
  }
  watermark()

  // Header: logo on the left, the gym's details on the right.
  const top = 36
  if (logo) pdf.image(left, top, 150, 86, logo)
  else pdf.text(left, top + 20, gym.name, { size: 18, bold: true, color: INK, maxWidth: width * 0.45 })
  let hy = top
  const lines: { text: string; bold?: boolean; size?: number }[] = [{ text: gym.name.toUpperCase(), bold: true, size: 10.5 }]
  for (const part of wrapText(gym.address || '', 8.5, width * 0.48)) lines.push({ text: part })
  if (gym.sac_code && receipt.tax) lines.push({ text: `SAC : ${gym.sac_code}` })
  if (gym.phone) lines.push({ text: `Phone: ${gym.phone}` })
  if (gym.email) lines.push({ text: `Email: ${gym.email}` })
  if (gym.gst_number) lines.push({ text: `GST No.: ${gym.gst_number}` })
  for (const line of lines) {
    pdf.text(right, hy, line.text, { size: line.size ?? 8.5, bold: line.bold, color: line.bold ? INK : MUTED, align: 'right', maxWidth: width * 0.55 })
    hy += (line.size ?? 8.5) + 4.5
  }
  let y = Math.max(top + 92, hy + 12)

  // Title + band: who paid, receipt number and date.
  pdf.text(left, y, receipt.status === 'REFUNDED' ? 'Payment Receipt (Refunded)' : 'Payment Receipt', { size: 17, bold: true, color: INK })
  y += 26
  pdf.rect(left, y, width, 54, { fill: BAND })
  pdf.rect(left, y + 54, width, 2.5, { fill: LIME })
  pdf.text(left + 12, y + 8, 'BILL TO', { size: 7.5, bold: true, color: LIME })
  pdf.text(left + 12, y + 20, `${receipt.member_name} (# ${receipt.member_code})`, { size: 10, bold: true, color: WHITE, maxWidth: width / 2 - 24 })
  pdf.text(left + 12, y + 35, receipt.member_phone || '', { size: 9, color: [0.82, 0.84, 0.88] })
  const mid = left + width / 2 + 8
  pdf.text(mid, y + 9, `Receipt Number: ${receipt.receipt_number}`, { size: 9, bold: true, color: WHITE })
  pdf.text(mid, y + 23, `Bill Date: ${dashDate(receipt.payment_date)}`, { size: 9, color: [0.82, 0.84, 0.88] })
  pdf.text(mid, y + 37, `Payment No: ${receipt.payment_number}`, { size: 8, color: [0.82, 0.84, 0.88] })
  y += 76

  // Purchase details and the money lines (GST is included in what was paid).
  const amountX = right - 8
  const labelX = right - 120
  pdf.line(left, y, right, y, { color: INK, width: 0.9 })
  pdf.text(left + 8, y + 8, 'Purchase Details', { size: 9.5, bold: true, color: INK })
  pdf.text(amountX, y + 8, 'AMOUNT', { size: 9, bold: true, color: INK, align: 'right' })
  y += 26
  pdf.line(left, y, right, y, { color: INK, width: 0.9 })
  pdf.text(left + 8, y + 9, receipt.plan_name.toUpperCase(), { size: 10, bold: true, color: INK, maxWidth: labelX - left - 40 })
  if (receipt.membership_start && receipt.membership_end) {
    pdf.text(left + 8, y + 23, `From ${dashDate(receipt.membership_start)} till ${dashDate(receipt.membership_end)}`, { size: 7.5, color: MUTED })
  }
  pdf.text(amountX, y + 9, formatMoney(receipt.price), { size: 10, color: INK, align: 'right' })
  y += 38
  const money: [string, string, boolean?][] = []
  if (receipt.discount > 0) money.push(['DISCOUNT', formatMoney(receipt.discount)])
  if (receipt.tax) {
    const half = receipt.tax.rate / 2
    money.push(['TAXABLE AMOUNT', formatMoney(receipt.tax.taxable)])
    money.push(['CGST(%) + SGST(%)', `${percent(half)} + ${percent(half)}`])
    money.push(['TAX AMOUNT', formatMoney(receipt.tax.amount)])
  }
  money.push(['PAID AMOUNT', formatMoney(receipt.amount), true])
  for (const [label, value, strong] of money) {
    pdf.line(left, y, right, y, { color: LINE })
    if (strong) pdf.rect(labelX - 110, y + 1, right - labelX + 110, 24, { fill: ZEBRA })
    pdf.text(labelX, y + 8, label, { size: strong ? 9 : 8, bold: !!strong, color: strong ? INK : MUTED, align: 'right' })
    pdf.text(amountX, y + 7.5, value, { size: strong ? 11 : 9.5, bold: !!strong, color: INK, align: 'right' })
    y += 26
  }
  pdf.line(left, y, right, y, { color: INK, width: 0.9 })
  y += 22

  // Payment mode.
  pdf.text(left, y, 'Payment Mode Details', { size: 9.5, bold: true, color: INK })
  y += 14
  const method = (METHOD_LABELS[receipt.payment_method] ?? receipt.payment_method).replace(' (manual)', '')
  for (const part of wrapText(`${method}  ${formatMoney(receipt.amount)} ( ${amountInWords(receipt.amount)} )`, 9, width)) {
    pdf.text(left, y, part, { size: 9, color: INK })
    y += 12
  }
  if (receipt.transaction_reference) {
    pdf.text(left, y, `Reference / UTR: ${receipt.transaction_reference}`, { size: 8.5, color: MUTED })
    y += 12
  }
  y += 8

  if (receipt.refund) {
    const r = receipt.refund
    pdf.rect(left, y, width, 58, { stroke: INK, lineWidth: 0.8, radius: 8 })
    pdf.text(left + 12, y + 9, 'REFUND RECORDED', { size: 8, bold: true, color: INK })
    pdf.text(left + 12, y + 23, `${formatMoney(r.amount)} by ${METHOD_LABELS[r.method] ?? r.method} on ${dashDate(r.date)}`, { size: 10, bold: true, color: INK })
    pdf.text(left + 12, y + 39, `Reason: ${r.reason}${r.reference ? `  ·  Reference: ${r.reference}` : ''}`, { size: 8, color: MUTED, maxWidth: width - 24 })
    y += 72
  }

  // Terms and conditions (onto a second page when long), then the seal and signature.
  const newPage = () => {
    pdf.addPage()
    watermark()
    y = 48
  }
  if (receipt.terms.length) {
    if (y + 40 > bottomLimit) newPage()
    pdf.text(left, y, 'Terms and Conditions', { size: 9.5, bold: true, color: INK })
    y += 15
    for (const term of receipt.terms) {
      const wrapped = wrapText(term, 8.5, width)
      if (y + wrapped.length * 11 > bottomLimit) newPage()
      for (const part of wrapped) {
        pdf.text(left, y, part, { size: 8.5, color: MUTED })
        y += 11
      }
      y += 5
    }
  }
  if (y + SIGN_OFF_HEIGHT > bottomLimit) newPage()
  await drawSignOff(pdf, left, right, Math.max(y + 8, bottomLimit - SIGN_OFF_HEIGHT), {
    gymName: gym.name,
    signer: gym.signatory || gym.name,
    stampWord: receipt.status === 'REFUNDED' ? 'REFUNDED' : 'PAID',
    ringText: 'PAYMENT RECEIVED',
    stampDate: dashDate(receipt.payment_date),
    signedAt: receipt.verified_at ? formatDateTime(receipt.verified_at) : dashDate(receipt.payment_date),
    note: 'This is a computer-generated receipt.',
  })
  footer(pdf, `${gym.name} · Receipt ${receipt.receipt_number}`)
  return pdf.output()
}

export function receiptFileName(receipt: Receipt): string {
  return `${slug(receipt.gym.name) || 'Gym'}_Receipt_${receipt.receipt_number}.pdf`
}

export async function downloadReceipt(receipt: Receipt): Promise<void> {
  saveBlob(await receiptPdf(receipt), receiptFileName(receipt))
}

// -- member report ------------------------------------------------------------------------------------
export const MEMBER_REPORT_SECTIONS: { value: MemberReportSection; label: string; staffOnly?: boolean }[] = [
  { value: 'membership', label: 'Membership & history' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'payments', label: 'Payments', staffOnly: true },
  { value: 'progress', label: 'Progress (measurements)' },
  { value: 'workouts', label: 'Workout plans' },
]

const METRIC_COLUMNS: { key: string; label: string; unit: string }[] = [
  { key: 'weight', label: 'Weight', unit: 'kg' },
  { key: 'body_fat', label: 'Body fat', unit: '%' },
  { key: 'chest', label: 'Chest', unit: 'cm' },
  { key: 'waist', label: 'Waist', unit: 'cm' },
  { key: 'arm', label: 'Arm', unit: 'cm' },
  { key: 'thigh', label: 'Thigh', unit: 'cm' },
]

function minutesLabel(minutes: number): string {
  if (!minutes) return '-'
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

export function memberReportFileName(report: MemberReport): string {
  return `${slug(report.gym.name) || 'Gym'}_${slug(report.member.name)}_${report.member.member_code}_Report_${report.from}_to_${report.to}.pdf`
}

/** One member's report: profile and membership, then the chosen sections, signed and stamped. */
export async function memberReportPdf(report: MemberReport, sections: MemberReportSection[]): Promise<Blob> {
  const gym = report.gym
  const m = report.member
  const pdf = new PdfDocument({ title: `${gym.name} - ${m.name} report`, author: gym.name })
  const left = 40
  const right = pdf.width - 40
  const width = right - left
  const bottomLimit = pdf.height - 60
  const logo = await receiptLogo()
  const watermark = () => {
    const mark = gym.name.toUpperCase()
    let size = 64
    while (size > 30 && textWidth(mark, size, true) > pdf.height * 0.95) size -= 2
    pdf.rotatedText(pdf.width / 2, pdf.height / 2 + 40, mark, 52, { size, bold: true, color: WATERMARK, align: 'center' })
  }
  let y = 0
  const newPage = () => {
    pdf.addPage()
    watermark()
    y = 44
  }
  const ensure = (space: number) => {
    if (y + space > bottomLimit) newPage()
  }
  watermark()

  // Header: logo, gym details, title.
  if (logo) pdf.image(left, 32, 130, 74, logo)
  else pdf.text(left, 48, gym.name, { size: 18, bold: true, color: INK, maxWidth: width * 0.45 })
  let hy = 34
  const details = [gym.name.toUpperCase(), ...wrapText(gym.address || '', 8.5, width * 0.48), gym.phone ? `Phone: ${gym.phone}` : '', gym.email ? `Email: ${gym.email}` : ''].filter(Boolean)
  details.forEach((line, i) => {
    pdf.text(right, hy, line, { size: i === 0 ? 10.5 : 8.5, bold: i === 0, color: i === 0 ? INK : MUTED, align: 'right', maxWidth: width * 0.55 })
    hy += i === 0 ? 15 : 13
  })
  y = Math.max(116, hy + 10)
  pdf.text(left, y, 'Member Report', { size: 17, bold: true, color: INK })
  pdf.text(right, y + 4, `${dashDate(report.from)} to ${dashDate(report.to)}`, { size: 9.5, bold: true, color: INK, align: 'right' })
  y += 26

  // Member band.
  pdf.rect(left, y, width, 58, { fill: BAND })
  pdf.rect(left, y + 58, width, 2.5, { fill: LIME })
  pdf.text(left + 12, y + 8, 'MEMBER', { size: 7.5, bold: true, color: LIME })
  pdf.text(left + 12, y + 20, `${m.name} (# ${m.member_code})`, { size: 10.5, bold: true, color: WHITE, maxWidth: width / 2 - 24 })
  pdf.text(left + 12, y + 36, [m.phone, m.email].filter(Boolean).join('  ·  '), { size: 8.5, color: [0.82, 0.84, 0.88], maxWidth: width / 2 - 24 })
  const mid = left + width / 2 + 8
  pdf.text(mid, y + 9, `Joined: ${dashDate(m.joining_date)}`, { size: 9, color: WHITE })
  pdf.text(mid, y + 23, `Trainer: ${m.trainer?.name ?? 'None'}`, { size: 9, color: [0.82, 0.84, 0.88], maxWidth: width / 2 - 20 })
  pdf.text(mid, y + 37, `Generated: ${formatDateTime(report.generated_at)}`, { size: 8, color: [0.82, 0.84, 0.88] })
  y += 78

  const heading = (title: string, note?: string) => {
    ensure(60)
    pdf.text(left, y, title, { size: 12, bold: true, color: INK })
    if (note) pdf.text(right, y + 2, note, { size: 8.5, color: MUTED, align: 'right' })
    y += 18
  }
  /** A simple table with a header row; columns are [label, share of width, right-aligned?]. */
  const table = (columns: [string, number, boolean?][], rows: string[][], empty: string) => {
    const widths = columns.map(([, share]) => share * width)
    const drawHead = () => {
      pdf.rect(left, y, width, 18, { fill: HEAD })
      let x = left
      columns.forEach(([label, , alignRight], i) => {
        pdf.text(alignRight ? x + widths[i] - 6 : x + 6, y + 5, label, { size: 7.5, bold: true, color: MUTED, align: alignRight ? 'right' : 'left', maxWidth: widths[i] - 12 })
        x += widths[i]
      })
      y += 18
    }
    drawHead()
    if (!rows.length) {
      pdf.text(left + 6, y + 5, empty, { size: 8.5, color: MUTED })
      y += 22
      return
    }
    rows.forEach((row, index) => {
      if (y + 16 > bottomLimit) {
        newPage()
        drawHead()
      }
      if (index % 2 === 1) pdf.rect(left, y, width, 16, { fill: ZEBRA })
      let x = left
      row.forEach((cell, i) => {
        const alignRight = columns[i][2]
        pdf.text(alignRight ? x + widths[i] - 6 : x + 6, y + 4.5, cell, { size: 8, color: INK, align: alignRight ? 'right' : 'left', maxWidth: widths[i] - 12 })
        x += widths[i]
      })
      y += 16
    })
    y += 14
  }
  const keyValues = (pairs: [string, string][]) => {
    ensure(40)
    const col = width / 4
    pairs.forEach(([label, value], i) => {
      const x = left + (i % 4) * col
      if (i > 0 && i % 4 === 0) y += 32
      pdf.text(x, y, label.toUpperCase(), { size: 6.5, bold: true, color: FAINT, maxWidth: col - 10 })
      pdf.text(x, y + 10, value || '-', { size: 10, bold: true, color: INK, maxWidth: col - 10 })
    })
    y += 40
  }

  if (sections.includes('membership')) {
    heading('Membership')
    const current = m.membership.current ?? m.membership.latest
    keyValues([
      ['Status', m.membership.status.replace('_', ' ')],
      ['Plan', current?.plan_name ?? 'No plan'],
      ['Valid till', m.membership.expiry_date ? dashDate(m.membership.expiry_date) : '-'],
      ['Days left', m.membership.days_left == null ? '-' : m.membership.days_left < 0 ? 'Expired' : String(m.membership.days_left)],
    ])
    table(
      [['Plan', 0.34], ['Start', 0.17], ['End', 0.17], ['Amount', 0.16, true], ['Status', 0.16]],
      report.memberships.map((ms) => [ms.plan_name ?? '-', dashDate(ms.start_date), dashDate(ms.end_date), formatMoney(ms.amount), ms.status]),
      'No memberships yet.',
    )
  }
  if (sections.includes('attendance')) {
    const a = report.attendance
    const minutes = a.items.reduce((sum, d) => sum + d.minutes, 0)
    heading('Attendance', `${a.days} days present · ${a.visits} visits · ${minutesLabel(minutes)} in the gym`)
    table(
      [['Date', 0.24], ['First in', 0.18], ['Last out', 0.18], ['Visits', 0.14, true], ['Time in gym', 0.26, true]],
      a.items.map((d) => [dashDate(d.date), formatTime(d.check_in), d.check_out ? formatTime(d.check_out) : '-', String(d.visits.length), minutesLabel(d.minutes)]),
      'No visits in this period.',
    )
  }
  if (sections.includes('payments') && report.payments) {
    const paid = report.payments.filter((p) => p.status === 'PAID').reduce((sum, p) => sum + p.amount, 0)
    heading('Payments', `${report.payments.length} payments · ${formatMoney(paid)} paid`)
    table(
      [['Date', 0.15], ['Payment no.', 0.2], ['Plan', 0.22], ['Method', 0.14], ['Amount', 0.14, true], ['Status', 0.15]],
      report.payments.map((p) => [dashDate(p.payment_date), p.payment_number, p.plan_name ?? '-', (METHOD_LABELS[p.payment_method] ?? p.payment_method).replace(' (manual)', ''), formatMoney(p.amount), p.status]),
      'No payments in this period.',
    )
  }
  if (sections.includes('progress')) {
    const pr = report.progress
    heading('Progress', pr.bmi ? `BMI ${pr.bmi}` : undefined)
    const latest = METRIC_COLUMNS.filter((c) => pr.latest[c.key as keyof typeof pr.latest]).map((c): [string, string] => {
      const value = pr.latest[c.key as keyof typeof pr.latest]!.value
      const change = pr.change[c.key as keyof typeof pr.change]
      return [c.label, `${value} ${c.unit}${change ? ` (${change > 0 ? '+' : ''}${change})` : ''}`]
    })
    if (latest.length) keyValues(latest.slice(0, 8))
    table(
      [['Date', 0.22], ...METRIC_COLUMNS.map((c): [string, number, boolean] => [`${c.label} (${c.unit})`, 0.13, true])],
      pr.history.map((h) => [dashDate(h.date), ...METRIC_COLUMNS.map((c) => {
        const v = (h as unknown as Record<string, unknown>)[c.key]
        return v == null ? '-' : String(v)
      })]),
      'No measurements yet.',
    )
  }
  if (sections.includes('workouts')) {
    heading('Workout plans', `${report.workouts.length} active`)
    if (!report.workouts.length) {
      pdf.text(left + 6, y, 'No active workout plans.', { size: 8.5, color: MUTED })
      y += 22
    }
    for (const w of report.workouts) {
      ensure(40)
      pdf.text(left, y, `${w.title}${w.day_label ? `  ·  ${w.day_label}` : ''}`, { size: 10, bold: true, color: INK, maxWidth: width * 0.7 })
      if (w.trainer_name) pdf.text(right, y, `Trainer: ${w.trainer_name}`, { size: 8, color: MUTED, align: 'right' })
      y += 16
      table(
        [['Exercise', 0.4], ['Sets', 0.12, true], ['Reps', 0.14, true], ['Weight (kg)', 0.16, true], ['Rest', 0.18, true]],
        w.exercises.map((e) => [e.exercise_name, e.sets == null ? '-' : String(e.sets), e.reps ?? '-', e.weight == null ? '-' : String(e.weight), e.rest_seconds ? `${e.rest_seconds}s` : '-']),
        'No exercises.',
      )
    }
  }

  ensure(SIGN_OFF_HEIGHT + 10)
  await drawSignOff(pdf, left, right, y + 6, {
    gymName: gym.name,
    signer: gym.signatory || gym.name,
    stampWord: 'VERIFIED',
    ringText: 'MEMBER REPORT',
    stampDate: dashDateTime(report.generated_at),
    signedAt: formatDateTime(report.generated_at),
    note: 'This is a computer-generated report.',
  })
  footer(pdf, `${gym.name} · ${m.name} (${m.member_code}) · ${dashDate(report.from)} to ${dashDate(report.to)}`)
  return pdf.output()
}

/** A short WhatsApp summary of the report (the PDF itself goes by Share PDF on phones). */
export function memberReportSummary(report: MemberReport, sections: MemberReportSection[]): string[] {
  const lines: string[] = []
  const m = report.member
  if (sections.includes('membership')) {
    const plan = (m.membership.current ?? m.membership.latest)?.plan_name
    lines.push(`*Membership:* ${plan ?? 'No plan'}${m.membership.expiry_date ? `, valid till ${dashDate(m.membership.expiry_date)}` : ''}`)
  }
  if (sections.includes('attendance')) lines.push(`*Attendance:* ${report.attendance.days} days present, ${report.attendance.visits} visits`)
  if (sections.includes('payments') && report.payments) {
    const paid = report.payments.filter((p) => p.status === 'PAID').reduce((sum, p) => sum + p.amount, 0)
    lines.push(`*Payments:* ${report.payments.length} (${formatMoney(paid)} paid)`)
  }
  if (sections.includes('progress')) {
    const w = report.progress.latest.weight
    if (w) lines.push(`*Weight:* ${w.value} kg (${dashDate(w.date)})`)
    if (report.progress.bmi) lines.push(`*BMI:* ${report.progress.bmi}`)
  }
  if (sections.includes('workouts')) lines.push(`*Workout plans:* ${report.workouts.map((w) => w.title).join(', ') || 'none'}`)
  return lines
}
