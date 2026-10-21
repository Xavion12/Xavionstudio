import { ExternalLink, History, Lock, LogOut, MapPin, MonitorSmartphone, MoreVertical, ShieldAlert, ShieldCheck, UserCheck, Users } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Pill } from '@/components/ui/Badge'
import { Button, IconButton } from '@/components/ui/Button'
import { Card, StatCard } from '@/components/ui/Card'
import { DataList } from '@/components/ui/DataList'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { EmptyState, ErrorState } from '@/components/ui/Feedback'
import { inputClasses, TextField } from '@/components/ui/Field'
import { Menu } from '@/components/ui/Menu'
import { PageHeader, Pagination, Segmented, Tabs } from '@/components/ui/Navigation'
import { useToast } from '@/contexts/ToastContext'
import { useApi } from '@/hooks/useApi'
import { useDocumentTitle } from '@/hooks/useUtilities'
import { isApiError } from '@/services/api'
import { securityApi } from '@/services/endpoints'
import { useLiveStatus } from '@/services/realtime'
import type { ActivityEntry, DeviceSession, Role, SecurityUnlock } from '@/types'
import { cn } from '@/utils/cn'
import { addDaysISO, formatDateTime, formatNumber, formatTime, relativeTime, todayISO } from '@/utils/format'

const ROLE_LABELS: Record<Role, string> = { ADMIN: 'Admin', STAFF: 'Staff', TRAINER: 'Trainer', MEMBER: 'Member' }
const ROLE_PLURALS: Record<Role, string> = { ADMIN: 'Admins', STAFF: 'Staff', TRAINER: 'Trainers', MEMBER: 'Members' }
const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`
const ROLE_TONES: Record<Role, 'violet' | 'blue' | 'amber' | 'slate'> = { ADMIN: 'violet', STAFF: 'blue', TRAINER: 'amber', MEMBER: 'slate' }

// The unlock lives only in memory: a reload, or 15 minutes, locks the page again.
let saved: SecurityUnlock | null = null
const valid = (u: SecurityUnlock | null) => !!u && u.expires_at * 1000 > Date.now() + 5_000

const isLocked = (error: unknown) => isApiError(error) && error.code === 'SECURITY_LOCKED'

/** Admin only: signed-in devices (members included) and the activity log, behind the password. */
export default function SecurityPage() {
  useDocumentTitle('Security')
  const [unlock, setUnlock] = useState<SecurityUnlock | null>(() => (valid(saved) ? saved : null))
  const lock = useCallback(() => {
    saved = null
    setUnlock(null)
  }, [])

  // Lock again when the unlock expires while the page is open.
  useEffect(() => {
    if (!unlock) return
    const timer = window.setTimeout(lock, Math.max(0, unlock.expires_at * 1000 - Date.now()))
    return () => window.clearTimeout(timer)
  }, [unlock, lock])

  if (!unlock) {
    return (
      <LockScreen
        onUnlock={(u) => {
          saved = u
          setUnlock(u)
        }}
      />
    )
  }
  return <Unlocked token={unlock.token} expiresAt={unlock.expires_at} onLock={lock} />
}

function LockScreen({ onUnlock }: { onUnlock: (u: SecurityUnlock) => void }) {
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!password) return setError('Enter your password')
    setBusy(true)
    setError(undefined)
    try {
      onUnlock(await securityApi.unlock(password))
    } catch (e) {
      if (isApiError(e) && e.fields?.password) setError(e.fields.password)
      else toast.fromError(e)
    } finally {
      setBusy(false)
      setPassword('')
    }
  }
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-sm p-6">
        <form onSubmit={submit} className="space-y-5" noValidate>
          <div className="text-center">
            <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300">
              <Lock className="size-6" aria-hidden />
            </span>
            <h1 className="mt-4 text-xl font-bold text-ink">Security is locked</h1>
            <p className="mt-1.5 text-sm text-muted">Enter your admin password to see signed-in devices and the activity log. It locks again after 15 minutes.</p>
          </div>
          <TextField
            label="Your password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={error}
          />
          <Button type="submit" className="w-full" icon={ShieldCheck} loading={busy}>
            Unlock
          </Button>
          <p className="text-center text-[12px] text-muted">Wrong passwords count toward the sign-in lockout and are recorded in the activity log.</p>
        </form>
      </Card>
    </div>
  )
}

function Unlocked({ token, expiresAt, onLock }: { token: string; expiresAt: number; onLock: () => void }) {
  const [tab, setTab] = useState<'devices' | 'activity'>('devices')
  const overview = useApi(`security:overview:${token}`, () => securityApi.overview(token), { freshMs: 0 })
  const data = overview.data
  useEffect(() => {
    if (isLocked(overview.error)) onLock()
  }, [overview.error, onLock])

  const count = (role: Role) => data?.roles.find((r) => r.role === role)
  const team = (data?.roles ?? []).filter((r) => r.role !== 'MEMBER')
  return (
    <div>
      <PageHeader
        title="Security"
        description={`Unlocked · locks again at ${formatTime(new Date(expiresAt * 1000).toISOString())}`}
        actions={
          <div className="flex items-center gap-2">
            <LiveBadge />
            <Button variant="secondary" icon={Lock} onClick={onLock}>
              Lock now
            </Button>
          </div>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatCard
          label="Signed in now"
          icon={MonitorSmartphone}
          value={formatNumber(data?.devices)}
          hint={data ? `${plural(data.people, 'person').replace('persons', 'people')} · ${formatNumber(data.online)} app${data.online === 1 ? '' : 's'} open now` : undefined}
          loading={!data}
        />
        <StatCard
          label="Members signed in"
          icon={Users}
          tone="blue"
          value={formatNumber(count('MEMBER')?.people)}
          hint={count('MEMBER') ? `${plural(count('MEMBER')!.devices, 'device')} in the member app` : undefined}
          loading={!data}
        />
        <StatCard
          label="Team signed in"
          icon={UserCheck}
          tone="amber"
          value={formatNumber(team.reduce((t, r) => t + r.people, 0))}
          hint={team.length ? team.map((r) => `${r.people} ${r.label.toLowerCase()}`).join(' · ') : undefined}
          loading={!data}
        />
        <StatCard
          label="Sign-ins today"
          icon={data?.today.failed ? ShieldAlert : ShieldCheck}
          tone={data?.today.failed ? 'red' : 'brand'}
          value={formatNumber(data?.today.sign_ins)}
          hint={data ? `${plural(data.today.people, 'person').replace('persons', 'people')} · ${formatNumber(data.today.failed)} failed` : undefined}
          loading={!data}
        />
      </div>
      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'devices', label: 'Signed-in devices', icon: MonitorSmartphone, badge: data?.devices },
          { value: 'activity', label: 'Activity log', icon: History },
        ]}
      />
      {tab === 'devices' ? (
        <Devices token={token} roleCounts={data?.roles} onLocked={onLock} onChanged={overview.reload} />
      ) : (
        <Activity token={token} categories={data?.categories ?? []} onLocked={onLock} />
      )}
    </div>
  )
}

function Devices({
  token,
  roleCounts,
  onLocked,
  onChanged,
}: {
  token: string
  roleCounts?: { role: Role; label: string; devices: number }[]
  onLocked: () => void
  onChanged: () => void
}) {
  const toast = useToast()
  const [role, setRole] = useState<'' | Role>('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(20)
  const [ending, setEnding] = useState<{ session: DeviceSession; all: boolean } | null>(null)
  const params = { role: role || undefined, q: q.trim() || undefined, page, limit }
  const list = useApi(`security:sessions:${token}:${JSON.stringify(params)}`, () => securityApi.sessions(token, params), {
    keepPrevious: true,
    freshMs: 0,
  })
  useEffect(() => {
    if (isLocked(list.error)) onLocked()
  }, [list.error, onLocked])
  const data = list.data
  const total = (roleCounts ?? []).reduce((t, r) => t + r.devices, 0)

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Segmented
          label="Who"
          value={role || 'ALL'}
          onChange={(v) => (setRole(v === 'ALL' ? '' : (v as Role)), setPage(1))}
          options={[
            { value: 'ALL', label: 'Everyone', count: roleCounts ? total : undefined },
            ...(['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] as Role[]).map((r) => ({
              value: r,
              label: ROLE_PLURALS[r],
              count: roleCounts?.find((c) => c.role === r)?.devices,
            })),
          ]}
        />
        <input
          type="search"
          value={q}
          onChange={(e) => (setQ(e.target.value), setPage(1))}
          placeholder="Search name, member ID, email"
          aria-label="Search signed-in people"
          className={cn(inputClasses, 'h-10 lg:w-72')}
        />
      </div>
      <Card className={cn('overflow-hidden', list.refreshing && data && 'opacity-80')}>
        {list.error && !data && !isLocked(list.error) ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : (
          <DataList
            rows={data?.items}
            loading={list.loading}
            rowKey={(s) => s.id}
            columns={[
              { key: 'who', header: 'Person', cell: (s) => <Person s={s} /> },
              {
                key: 'device',
                header: 'Device',
                cell: (s) => (
                  <div>
                    <p className="flex items-center gap-1.5 font-medium text-ink">
                      <OnlineDot online={s.online} />
                      {s.device}
                    </p>
                    <p className="text-[12px] text-muted">{s.ip ?? 'IP not recorded'}</p>
                  </div>
                ),
              },
              { key: 'where', header: 'Location', cell: (s) => <Where s={s} /> },
              { key: 'signed', header: 'Signed in', className: 'hidden lg:table-cell', cell: (s) => <span className="whitespace-nowrap">{formatDateTime(s.signed_in_at)}</span> },
              { key: 'seen', header: 'Last active', cell: (s) => <span className="whitespace-nowrap">{relativeTime(s.last_active_at)}</span> },
              { key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right', cell: (s) => <DeviceActions s={s} onEnd={setEnding} /> },
            ]}
            mobile={(s) => (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <Person s={s} />
                  <Where s={s} />
                  <p className="flex items-center gap-1.5 text-[12px] text-muted">
                    <OnlineDot online={s.online} />
                    {s.device} · active {relativeTime(s.last_active_at)}
                  </p>
                </div>
                <DeviceActions s={s} onEnd={setEnding} />
              </div>
            )}
            empty={<EmptyState icon={MonitorSmartphone} title="Nobody signed in" description="No device matches this filter right now." />}
          />
        )}
        {data && data.total > 0 && (
          <div className="border-t border-line px-4">
            <Pagination page={data.page} pages={data.pages} total={data.total} limit={data.limit} onPage={setPage} onLimit={(l) => (setLimit(l), setPage(1))} />
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={!!ending}
        onClose={() => setEnding(null)}
        title={ending?.all ? `Sign out every device of ${ending.session.name}?` : `Sign out ${ending?.session.name}'s ${ending?.session.device}?`}
        message={
          ending?.all
            ? 'They are signed out on every phone and computer and must sign in again with their password.'
            : 'That device must sign in again with the password. Their other devices stay signed in.'
        }
        confirmLabel="Sign out"
        onConfirm={async () => {
          const target = ending!
          try {
            if (target.all) await securityApi.signOutPerson(token, target.session.user_id)
            else await securityApi.signOutDevice(token, target.session.id)
            toast.success('Signed out', { description: target.all ? `${target.session.name} on every device` : `${target.session.name} · ${target.session.device}` })
            list.reload()
            onChanged()
          } catch (error) {
            if (isLocked(error)) onLocked()
            else toast.fromError(error)
            throw error
          }
        }}
      />
    </>
  )
}

function LiveBadge() {
  const status = useLiveStatus()
  const live = status === 'live'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-semibold',
        live ? 'border-success-200 bg-success-50 text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-300' : 'border-line text-muted',
      )}
      title={live ? 'Updates appear the moment they happen' : 'Reconnecting… the page still refreshes on its own'}
    >
      <span className={cn('size-2 rounded-full', live ? 'animate-pulse bg-success-500' : 'bg-neutral-400')} aria-hidden />
      {live ? 'Live' : 'Connecting'}
    </span>
  )
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      className={cn('inline-block size-2 shrink-0 rounded-full', online ? 'bg-success-500' : 'bg-neutral-300 dark:bg-neutral-600')}
      title={online ? 'App open now' : 'App not open right now'}
      aria-label={online ? 'Online now' : 'Not open now'}
    />
  )
}

/** GPS position (map link, accuracy, when) and the network's city. */
function Where({ s }: { s: DeviceSession }) {
  const gps = s.location
  return (
    <div className="min-w-0 text-[12px]">
      {gps ? (
        <a
          href={`https://www.google.com/maps?q=${gps.lat},${gps.lng}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-semibold text-ink hover:underline"
        >
          <MapPin className="size-3.5 text-success-600" aria-hidden />
          {gps.lat.toFixed(4)}, {gps.lng.toFixed(4)}
          <ExternalLink className="size-3 text-muted" aria-hidden />
        </a>
      ) : (
        <span className="inline-flex items-center gap-1 font-medium text-warning-700 dark:text-warning-300">
          <MapPin className="size-3.5" aria-hidden /> No GPS yet
        </span>
      )}
      <p className="text-muted">
        {[gps?.accuracy_m != null ? `±${formatNumber(gps.accuracy_m)} m` : null, gps?.at ? relativeTime(gps.at) : null, s.place].filter(Boolean).join(' · ') ||
          'Network location not available'}
      </p>
    </div>
  )
}

function Person({ s }: { s: DeviceSession }) {
  return (
    <div className="min-w-0">
      <p className="flex flex-wrap items-center gap-1.5 font-semibold text-ink">
        <span className="truncate">{s.name}</span>
        <Pill tone={ROLE_TONES[s.role]}>{ROLE_LABELS[s.role]}</Pill>
        {s.current && <Pill tone="green">This device</Pill>}
      </p>
      {s.login && <p className="truncate text-[12px] text-muted">{s.login}</p>}
    </div>
  )
}

function DeviceActions({ s, onEnd }: { s: DeviceSession; onEnd: (v: { session: DeviceSession; all: boolean }) => void }) {
  if (s.current) return <span className="text-[12px] text-muted">You</span>
  return (
    <Menu
      label="Device actions"
      trigger={({ toggle }) => <IconButton icon={MoreVertical} label={`Actions for ${s.name}`} size="icon-sm" onClick={toggle} />}
      items={[
        { label: 'Sign out this device', icon: LogOut, tone: 'danger', onSelect: () => onEnd({ session: s, all: false }) },
        { label: 'Sign out all their devices', icon: LogOut, tone: 'danger', onSelect: () => onEnd({ session: s, all: true }) },
      ]}
    />
  )
}

type Period = 'today' | 'week' | 'month' | 'custom'

function Activity({ token, categories, onLocked }: { token: string; categories: string[]; onLocked: () => void }) {
  const [period, setPeriod] = useState<Period>('week')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [category, setCategory] = useState('')
  const [role, setRole] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(50)
  const today = todayISO()
  const start = period === 'today' ? today : period === 'week' ? addDaysISO(today, -6) : period === 'month' ? addDaysISO(today, -29) : from || undefined
  const end = period === 'custom' ? to || undefined : today
  const params = { from: start, to: end, category: category || undefined, role: role || undefined, q: q.trim() || undefined, page, limit }
  const list = useApi(`security:activity:${token}:${JSON.stringify(params)}`, () => securityApi.activity(token, params), {
    keepPrevious: true,
    freshMs: 0,
  })
  useEffect(() => {
    if (isLocked(list.error)) onLocked()
  }, [list.error, onLocked])
  const data = list.data
  const reset = () => setPage(1)

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <Segmented
          label="Period"
          value={period}
          onChange={(v) => (setPeriod(v), reset())}
          options={[
            { value: 'today', label: 'Today' },
            { value: 'week', label: '7 days' },
            { value: 'month', label: '30 days' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
        <div className="flex flex-wrap gap-2">
          {period === 'custom' && (
            <>
              <input type="date" value={from} max={to || today} onChange={(e) => (setFrom(e.target.value), reset())} aria-label="From date" className={cn(inputClasses, 'h-10 w-40')} />
              <input type="date" value={to} min={from} max={today} onChange={(e) => (setTo(e.target.value), reset())} aria-label="To date" className={cn(inputClasses, 'h-10 w-40')} />
            </>
          )}
          <select value={category} onChange={(e) => (setCategory(e.target.value), reset())} aria-label="Type of activity" className={cn(inputClasses, 'h-10 w-40')}>
            <option value="">All activity</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select value={role} onChange={(e) => (setRole(e.target.value), reset())} aria-label="Done by" className={cn(inputClasses, 'h-10 w-36')}>
            <option value="">Everyone</option>
            {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_PLURALS[r]}
              </option>
            ))}
          </select>
          <input
            type="search"
            value={q}
            onChange={(e) => (setQ(e.target.value), reset())}
            placeholder="Search name or action"
            aria-label="Search the activity log"
            className={cn(inputClasses, 'h-10 w-full sm:w-56')}
          />
        </div>
      </div>
      <Card className={cn('overflow-hidden', list.refreshing && data && 'opacity-80')}>
        {list.error && !data && !isLocked(list.error) ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : (
          <DataList
            rows={data?.items}
            loading={list.loading}
            rowKey={(a) => a.id}
            columns={[
              { key: 'at', header: 'When', cell: (a) => <span className="whitespace-nowrap">{formatDateTime(a.at)}</span> },
              { key: 'who', header: 'Who', cell: (a) => <Who a={a} /> },
              { key: 'what', header: 'What happened', cell: (a) => <What a={a} /> },
              {
                key: 'device',
                header: 'Device',
                className: 'hidden xl:table-cell',
                cell: (a) => (
                  <div className="text-[12px] text-muted">
                    <p>{a.device ?? '—'}</p>
                    <p>{a.ip ?? ''}</p>
                  </div>
                ),
              },
            ]}
            mobile={(a) => (
              <div className="space-y-1">
                <What a={a} />
                <p className="text-[12px] text-muted">
                  {a.name ?? 'Someone not signed in'} · {formatDateTime(a.at)}
                  {a.device ? ` · ${a.device}` : ''}
                </p>
              </div>
            )}
            empty={<EmptyState icon={History} title="No activity" description="Nothing matches these filters in this period." />}
          />
        )}
        {data && data.total > 0 && (
          <div className="border-t border-line px-4">
            <Pagination page={data.page} pages={data.pages} total={data.total} limit={data.limit} onPage={setPage} onLimit={(l) => (setLimit(l), reset())} sizes={[50, 100]} />
          </div>
        )}
      </Card>
    </>
  )
}

const FAILED = new Set(['LOGIN_FAILED', 'SECURITY_UNLOCK_FAILED'])

function Who({ a }: { a: ActivityEntry }) {
  if (!a.name) return <span className="text-muted">Not signed in</span>
  return (
    <div className="min-w-0">
      <p className="truncate font-medium text-ink">{a.name}</p>
      {a.role && <p className="text-[12px] text-muted">{ROLE_LABELS[a.role]}</p>}
    </div>
  )
}

function What({ a }: { a: ActivityEntry }) {
  return (
    <div className="min-w-0">
      <p className={cn('flex flex-wrap items-center gap-1.5', FAILED.has(a.action) ? 'font-semibold text-danger-700 dark:text-danger-300' : 'text-ink')}>
        <Pill tone={FAILED.has(a.action) ? 'red' : a.category === 'Sign-in' || a.category === 'Security' ? 'violet' : 'slate'}>{a.category}</Pill>
        {a.summary}
      </p>
      {a.target && <p className="mt-0.5 truncate text-[12px] text-muted">{a.target}</p>}
    </div>
  )
}
