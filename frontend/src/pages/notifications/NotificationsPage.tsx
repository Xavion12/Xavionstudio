import { zodResolver } from '@hookform/resolvers/zod'
import { BellRing, CalendarClock, Clock, Megaphone, Send, Smartphone } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { Link } from 'react-router'
import { Pill, StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DataList } from '@/components/ui/DataList'
import { Dialog } from '@/components/ui/Dialog'
import { EmptyState, ErrorState } from '@/components/ui/Feedback'
import { ChannelPicker, useChannels } from '@/components/notifications/ChannelPicker'
import { SelectField, TextField, TextareaField, inputClasses } from '@/components/ui/Field'
import { PageHeader, Pagination } from '@/components/ui/Navigation'
import { useToast } from '@/contexts/ToastContext'
import { invalidate, useApi } from '@/hooks/useApi'
import { useAction, useDocumentTitle } from '@/hooks/useUtilities'
import { notificationsApi, settingsApi } from '@/services/endpoints'
import { offerSchema, type OfferValues } from '@/schemas/training'
import type { AnnounceResult, SendChannel } from '@/types'
import { cn } from '@/utils/cn'
import { formatDateTime, formatNumber } from '@/utils/format'
import { NOTIFICATION_TYPES, notificationMeta } from '@/utils/notifications'

type Segment = 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'ALL'
const MAX = 1000
const APP_LIMIT = 300

/** "Sent to 12 in the app · 30 on WhatsApp · 18 by email" */
export function deliverySummary(result: AnnounceResult): string {
  const parts = [
    result.delivered ? `${formatNumber(result.delivered)} in the app` : '',
    result.whatsapp ? `${formatNumber(result.whatsapp)} on WhatsApp` : '',
    result.email ? `${formatNumber(result.email)} by email` : '',
  ].filter(Boolean)
  return parts.length ? `Sent to ${parts.join(' · ')}` : 'Nobody matched'
}

function AnnouncementDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const [segment, setSegment] = useState<Segment>('ACTIVE')
  const [channels, setChannels] = useState<SendChannel[]>(['APP'])
  const { register, handleSubmit, reset, control, formState } = useForm<OfferValues>({ resolver: zodResolver(offerSchema), defaultValues: { title: '', message: '' } })
  const message = useWatch({ control, name: 'message' }) ?? ''
  const live = useChannels()
  useEffect(() => {
    if (open) {
      reset({ title: '', message: '' })
      setSegment('ACTIVE')
    }
  }, [open, reset])
  useEffect(() => {
    // Offer every connected channel by default once we know which are live.
    if (open) setChannels(['APP', ...(live.whatsapp ? ['WHATSAPP' as const] : []), ...(live.email ? ['EMAIL' as const] : [])])
  }, [open, live.whatsapp, live.email])
  const submit = handleSubmit(async (values) => {
    if (!channels.length) {
      toast.error('Choose at least one way to send it')
      return
    }
    try {
      const result = await notificationsApi.send({ segment, channels, title: values.title.trim() || null, message: values.message.trim() })
      invalidate('notifications', 'messages')
      toast.success(deliverySummary(result), {
        description: channels.includes('APP') && result.without_app ? `${formatNumber(result.without_app)} matching member(s) don’t use the app yet.` : undefined,
      })
      onClose()
    } catch (error) {
      toast.fromError(error)
    }
  })
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Send an offer or announcement"
      description="Offers, holiday timings, new batches — in the member app, on WhatsApp and by email."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="announce-form" icon={Send} loading={formState.isSubmitting}>
            Send
          </Button>
        </>
      }
    >
      <form id="announce-form" onSubmit={submit} className="space-y-4" noValidate>
        <SelectField
          label="Who should receive it?"
          value={segment}
          onChange={(e) => setSegment(e.target.value as Segment)}
          options={[
            { value: 'ACTIVE', label: 'Members with an active membership' },
            { value: 'EXPIRING', label: 'Members expiring in the next 7 days' },
            { value: 'EXPIRED', label: 'Members whose membership has expired' },
            { value: 'ALL', label: 'Every member' },
          ]}
        />
        <ChannelPicker value={channels} onChange={setChannels} />
        <TextField
          label="Title"
          placeholder="e.g. Diwali offer — 20% off"
          hint="Email subject, and the first words in the app. Optional."
          maxLength={80}
          error={formState.errors.title?.message}
          {...register('title')}
          data-autofocus
        />
        <TextareaField
          label="Message"
          required
          rows={5}
          maxLength={MAX}
          placeholder={'e.g. 20% off every plan this week.\nValid till 31 Oct at the front desk or in the app.'}
          hint={`${message.length}/${MAX}${channels.includes('APP') && message.length > APP_LIMIT ? ` · the app shows the first ${APP_LIMIT}` : ''}`}
          error={formState.errors.message?.message}
          {...register('message')}
        />
      </form>
    </Dialog>
  )
}

export default function NotificationsPage() {
  useDocumentTitle('Notifications')
  const toast = useToast()
  const [type, setType] = useState('')
  const [status, setStatus] = useState('')
  const [days, setDays] = useState(30)
  const [page, setPage] = useState(1)
  const [announcing, setAnnouncing] = useState(false)
  const params = { type: type || undefined, status: status || undefined, days, page, limit: 25 }
  const log = useApi(`notifications:log:${JSON.stringify(params)}`, () => notificationsApi.log(params), { keepPrevious: true })
  const settings = useApi('settings', () => settingsApi.get())
  const reminders = useAction(async () => {
    try {
      const r = await notificationsApi.runReminders()
      invalidate('notifications')
      toast.success(r.created ? `${r.created} reminder${r.created === 1 ? '' : 's'} created` : 'No reminders due right now', {
        description: r.created ? undefined : 'Members already reminded today are skipped, so running this twice is safe.',
      })
    } catch (error) {
      toast.fromError(error)
    }
  })
  const s = settings.data

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="In the member app, and by WhatsApp and email when the server has their keys"
        actions={
          <>
            <Button variant="secondary" icon={BellRing} loading={reminders.loading} onClick={() => reminders.run()}>
              Run reminders now
            </Button>
            <Button icon={Megaphone} onClick={() => setAnnouncing(true)}>
              Send offer / announcement
            </Button>
          </>
        }
      />
      <div className="mb-5 grid gap-3 md:grid-cols-3">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-semibold text-ink">
              <CalendarClock className="size-4 text-muted" aria-hidden /> Expiry reminders
            </span>
            {s ? s.reminders_enabled ? <Pill tone="green">On</Pill> : <Pill tone="slate">Off</Pill> : null}
          </div>
          <p className="mt-2 text-[13px] text-muted">
            Every morning: 7, 3 and 1 day before a membership ends, and once after it ends — never twice in a day.
          </p>
        </Card>
        <Card className="p-4">
          <span className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Smartphone className="size-4 text-muted" aria-hidden /> Delivery
          </span>
          <p className="mt-2 text-[13px] text-muted">Shown in the member app and the team’s bell. Members without an app login can’t receive them.</p>
        </Card>
        <Card className="p-4">
          <span className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Clock className="size-4 text-muted" aria-hidden /> Retention
          </span>
          <p className="mt-2 text-[13px] text-muted">
            {s ? `Notifications older than ${formatNumber(s.notification_retention_days)} days are removed automatically.` : 'Old notifications are removed automatically.'}{' '}
            <Link to="/settings?tab=data" className="font-semibold text-ink underline-offset-2 hover:underline">
              Change
            </Link>
          </p>
        </Card>
      </div>
      <div className="mb-3 grid gap-2 sm:grid-cols-3 lg:max-w-3xl">
        <select value={type} onChange={(e) => (setType(e.target.value), setPage(1))} aria-label="Type" className={cn(inputClasses, 'h-10')}>
          <option value="">All types</option>
          {Object.entries(NOTIFICATION_TYPES).map(([value, meta]) => (
            <option key={value} value={value}>
              {meta.label}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))} aria-label="Status" className={cn(inputClasses, 'h-10')}>
          <option value="">Read and unread</option>
          <option value="UNREAD">Unread</option>
          <option value="READ">Read</option>
        </select>
        <select value={days} onChange={(e) => (setDays(Number(e.target.value)), setPage(1))} aria-label="Period" className={cn(inputClasses, 'h-10')}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last 12 months</option>
        </select>
      </div>
      <Card className={cn('overflow-hidden', log.refreshing && log.data && 'opacity-80')}>
        {log.error && !log.data ? (
          <ErrorState error={log.error} onRetry={log.reload} />
        ) : (
          <DataList
            rows={log.data?.items}
            loading={log.loading}
            rowKey={(n) => n.id}
            columns={[
              { key: 'time', header: 'Time', cell: (n) => <span className="whitespace-nowrap">{formatDateTime(n.created_at)}</span> },
              {
                key: 'to',
                header: 'To',
                cell: (n) =>
                  n.member_id ? (
                    <Link to={`/members/${n.member_id}`} className="block">
                      <span className="block font-semibold text-ink hover:underline">{n.user_name}</span>
                      <span className="block text-[12px] text-muted">{n.member_code}</span>
                    </Link>
                  ) : (
                    <span className="block">
                      <span className="block font-semibold text-ink">{n.user_name ?? '—'}</span>
                      <span className="block text-[12px] text-muted">{n.audience ? n.audience[0] + n.audience.slice(1).toLowerCase() : ''}</span>
                    </span>
                  ),
              },
              { key: 'type', header: 'Type', cell: (n) => <span className="whitespace-nowrap">{notificationMeta(n.type).label}</span> },
              { key: 'message', header: 'Message', className: 'max-w-[380px]', cell: (n) => <span className="line-clamp-2 text-[13px]">{n.message}</span> },
              {
                key: 'status',
                header: 'Status',
                cell: (n) => <StatusBadge status={n.status} size="sm" label={n.status === 'READ' && n.read_at ? `Read ${formatDateTime(n.read_at).split(',')[0]}` : undefined} />,
              },
            ]}
            mobile={(n) => (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-ink">{n.user_name ?? 'Member'}</span>
                  <StatusBadge status={n.status} size="sm" />
                </div>
                <p className="line-clamp-2 text-[13px] text-ink-2">{n.message}</p>
                <p className="text-[12px] text-muted">
                  {notificationMeta(n.type).label} · {formatDateTime(n.created_at)}
                </p>
              </div>
            )}
            empty={<EmptyState icon={BellRing} title="No notifications in this period" description="Reminders, payment confirmations and announcements appear here." />}
          />
        )}
        {log.data && log.data.total > 0 && (
          <div className="border-t border-line px-4">
            <Pagination page={log.data.page} pages={log.data.pages} total={log.data.total} limit={log.data.limit} onPage={setPage} />
          </div>
        )}
      </Card>
      <AnnouncementDialog open={announcing} onClose={() => setAnnouncing(false)} />
    </div>
  )
}
