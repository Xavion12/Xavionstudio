import { Download, FileText } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useParams } from 'react-router'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Spinner } from '@/components/ui/Feedback'
import { useDocumentTitle } from '@/hooks/useUtilities'
import { isApiError } from '@/services/api'
import { MEMBER_REPORT_SECTIONS, memberReportFileName, memberReportPdf, receiptFileName, receiptPdf } from '@/services/documents'
import { publicApi } from '@/services/endpoints'
import { saveBlob } from '@/utils/download'
import { formatDate, formatMoney } from '@/utils/format'

interface Ready {
  blob: Blob
  fileName: string
  gym: string
  title: string
  lines: string[]
}

/** What a member opens from a WhatsApp link: their receipt (/r/...) or report (/mr/...) as a PDF,
 *  built here from the signed link. No sign-in needed. */
export default function SharedDocumentPage() {
  const { token = '' } = useParams()
  const isReport = useLocation().pathname.startsWith('/mr/')
  const [doc, setDoc] = useState<Ready | null>(null)
  const [error, setError] = useState<string | null>(null)
  useDocumentTitle(isReport ? 'Member report' : 'Payment receipt')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        if (isReport) {
          const report = await publicApi.memberReport(token)
          const sections = report.sections ?? MEMBER_REPORT_SECTIONS.map((s) => s.value)
          const blob = await memberReportPdf(report, sections)
          if (!cancelled)
            setDoc({
              blob,
              fileName: memberReportFileName(report),
              gym: report.gym.name,
              title: 'Member report',
              lines: [`${report.member.name} · ${report.member.member_code}`, `${formatDate(report.from, { withYear: true })} to ${formatDate(report.to, { withYear: true })}`],
            })
        } else {
          const receipt = await publicApi.receipt(token)
          const blob = await receiptPdf(receipt)
          if (!cancelled)
            setDoc({
              blob,
              fileName: receiptFileName(receipt),
              gym: receipt.gym.name,
              title: `Receipt ${receipt.receipt_number}`,
              lines: [`${receipt.member_name} · ${receipt.plan_name}`, `${formatMoney(receipt.amount)} · ${formatDate(receipt.payment_date, { withYear: true })}`],
            })
        }
      } catch (e) {
        if (!cancelled) setError(isApiError(e) ? e.message : 'We couldn’t open this document. Please try again.')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token, isReport])

  const view = () => {
    if (!doc) return
    // Same tab: works in phone browsers and inside WhatsApp, where new tabs are often blocked.
    window.location.href = URL.createObjectURL(doc.blob)
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <Card className="w-full max-w-sm space-y-5 p-6 text-center">
        <img src="/receipt-logo.jpg" alt={doc?.gym ?? 'Gym logo'} className="mx-auto h-24 w-auto object-contain dark:rounded-xl dark:bg-white dark:p-2" />
        {error ? (
          <div className="space-y-2">
            <p className="text-lg font-semibold text-ink">Link not available</p>
            <p className="text-sm text-muted">{error}</p>
          </div>
        ) : !doc ? (
          <div className="flex flex-col items-center gap-3 py-4 text-sm text-muted">
            <Spinner className="size-6" />
            Preparing your PDF…
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <p className="inline-flex items-center gap-2 text-lg font-semibold text-ink">
                <FileText className="size-5" aria-hidden /> {doc.title}
              </p>
              {doc.lines.map((line) => (
                <p key={line} className="text-sm text-muted">
                  {line}
                </p>
              ))}
            </div>
            <div className="grid gap-2">
              <Button size="lg" icon={FileText} onClick={view}>
                View PDF
              </Button>
              <Button size="lg" variant="secondary" icon={Download} onClick={() => saveBlob(doc.blob, doc.fileName)}>
                Download PDF
              </Button>
            </div>
            <p className="text-[12px] text-muted">From {doc.gym}. Signed and stamped by the gym.</p>
          </>
        )}
      </Card>
    </main>
  )
}
