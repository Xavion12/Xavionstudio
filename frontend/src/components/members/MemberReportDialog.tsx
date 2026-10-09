import { Download, MessageCircle, Share2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Checkbox, TextField } from '@/components/ui/Field'
import { Segmented } from '@/components/ui/Navigation'
import { useToast } from '@/contexts/ToastContext'
import { canSharePdf } from '@/hooks/useReceipt'
import { MEMBER_REPORT_SECTIONS, memberReportFileName, memberReportPdf, memberReportSummary } from '@/services/documents'
import { membersApi } from '@/services/endpoints'
import type { MemberReport, MemberReportSection, MemberWorkspace } from '@/types'
import { saveBlob } from '@/utils/download'
import { formatDate, todayISO } from '@/utils/format'
import { memberReportMessage, shareUrl, whatsAppLink } from '@/utils/whatsapp'

type Preset = 'month' | '3m' | '12m' | 'custom'

function shift(days: number): string {
  const d = new Date(`${todayISO()}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function presetRange(preset: Preset): { from: string; to: string } {
  const to = todayISO()
  if (preset === 'month') return { from: `${to.slice(0, 8)}01`, to }
  if (preset === '12m') return { from: shift(364), to }
  return { from: shift(89), to }
}

/** Tick what to include, then download, share or send the member's report. */
export function MemberReportDialog({ member, staff, open, onClose }: { member: MemberWorkspace; staff: boolean; open: boolean; onClose: () => void }) {
  const toast = useToast()
  const available = MEMBER_REPORT_SECTIONS.filter((s) => staff || !s.staffOnly)
  const [sections, setSections] = useState<MemberReportSection[]>(available.map((s) => s.value))
  const [preset, setPreset] = useState<Preset>('3m')
  const [range, setRange] = useState(presetRange('3m'))
  const [busy, setBusy] = useState<'pdf' | 'share' | 'whatsapp' | null>(null)

  useEffect(() => {
    if (open) {
      setSections(available.map((s) => s.value))
      setPreset('3m')
      setRange(presetRange('3m'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggle = (value: MemberReportSection) => setSections((current) => (current.includes(value) ? current.filter((v) => v !== value) : [...current, value]))
  const load = async (): Promise<MemberReport | null> => {
    if (!sections.length) {
      toast.error('Tick at least one section')
      return null
    }
    return membersApi.report(member.id, range.from, range.to)
  }

  const download = async () => {
    setBusy('pdf')
    try {
      const report = await load()
      if (report) saveBlob(await memberReportPdf(report, sections), memberReportFileName(report))
    } catch (error) {
      toast.fromError(error, "We couldn't create the report. Please try again.")
    } finally {
      setBusy(null)
    }
  }

  const share = async () => {
    setBusy('share')
    try {
      const report = await load()
      if (!report) return
      const file = new File([await memberReportPdf(report, sections)], memberReportFileName(report), { type: 'application/pdf' })
      try {
        await navigator.share({ files: [file], title: `${member.name} report` })
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) saveBlob(file, file.name)
      }
    } catch (error) {
      toast.fromError(error, "We couldn't create the report. Please try again.")
    } finally {
      setBusy(null)
    }
  }

  const whatsapp = async () => {
    const win = window.open('', '_blank') // during the click: browsers block pop-ups opened after a wait
    if (win) win.opener = null // the opened tab can't reach back into this one
    setBusy('whatsapp')
    try {
      const report = await load()
      if (!report || !report.member_whatsapp) {
        win?.close()
        if (report) toast.error('No phone number', { description: 'Add the member’s mobile number to send on WhatsApp.' })
        return
      }
      const { path } = await membersApi.reportLink(member.id, range.from, range.to, sections)
      const text = memberReportMessage({
        name: member.name,
        gym: report.gym.name,
        from: formatDate(report.from, { withYear: true }),
        to: formatDate(report.to, { withYear: true }),
        lines: memberReportSummary(report, sections),
        pdfUrl: shareUrl(path),
      })
      const link = whatsAppLink(report.member_whatsapp, text)
      if (win) win.location.href = link
      else window.location.href = link
    } catch (error) {
      win?.close()
      toast.fromError(error, "We couldn't prepare the report. Please try again.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Generate report"
      description={`${member.name} · ${member.member_code}`}
      footer={
        <>
          <Button variant="secondary" icon={Download} loading={busy === 'pdf'} onClick={download}>
            Download PDF
          </Button>
          {canSharePdf && (
            <Button variant="secondary" icon={Share2} loading={busy === 'share'} onClick={share}>
              Share PDF
            </Button>
          )}
          <Button icon={MessageCircle} loading={busy === 'whatsapp'} onClick={whatsapp}>
            Send on WhatsApp
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-3">
          <p className="text-sm font-semibold text-ink">Period</p>
          <Segmented<Preset>
            label="Report period"
            value={preset}
            onChange={(next) => {
              setPreset(next)
              if (next !== 'custom') setRange(presetRange(next))
            }}
            options={[
              { value: 'month', label: 'This month' },
              { value: '3m', label: 'Last 3 months' },
              { value: '12m', label: 'Last 12 months' },
              { value: 'custom', label: 'Custom' },
            ]}
          />
          {preset === 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              <TextField label="From" type="date" max={range.to} value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
              <TextField label="To" type="date" max={todayISO()} value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
            </div>
          )}
        </div>
        <fieldset className="space-y-1">
          <legend className="mb-1.5 text-sm font-semibold text-ink">Include</legend>
          {available.map((s) => (
            <Checkbox key={s.value} label={s.label} checked={sections.includes(s.value)} onChange={() => toggle(s.value)} />
          ))}
        </fieldset>
        <p className="text-[13px] text-muted">
          The PDF carries the gym logo, the digital signature and the VERIFIED stamp. <strong className="font-semibold text-ink">Send on WhatsApp</strong> opens the member’s chat with a summary and a link to this PDF (valid 30 days); on a phone, <strong className="font-semibold text-ink">Share PDF</strong> sends the PDF itself.
        </p>
      </div>
    </Dialog>
  )
}
