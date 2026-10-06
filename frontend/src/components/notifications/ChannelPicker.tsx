import { BellRing, Mail, MessageCircle } from 'lucide-react'
import { useApi } from '@/hooks/useApi'
import { messagesApi } from '@/services/endpoints'
import type { MessagesOverview, SendChannel } from '@/types'
import { cn } from '@/utils/cn'

/** Which channels can carry a message right now (WhatsApp / email are on once their keys are on the server). */
export function useChannels() {
  const overview = useApi('messages', () => messagesApi.overview())
  const live = (s?: MessagesOverview['whatsapp']) => !!s && s.configured && s.enabled
  return {
    loading: overview.loading && !overview.data,
    whatsapp: live(overview.data?.whatsapp),
    email: live(overview.data?.email),
  }
}

const OPTIONS: { value: SendChannel; label: string; icon: typeof BellRing }[] = [
  { value: 'APP', label: 'Member app', icon: BellRing },
  { value: 'WHATSAPP', label: 'WhatsApp', icon: MessageCircle },
  { value: 'EMAIL', label: 'Email', icon: Mail },
]

/** "Send by" toggles for announcements and offers. */
export function ChannelPicker({ value, onChange }: { value: SendChannel[]; onChange: (value: SendChannel[]) => void }) {
  const channels = useChannels()
  const available = (c: SendChannel) => c === 'APP' || (c === 'WHATSAPP' ? channels.whatsapp : channels.email)
  const toggle = (c: SendChannel) => onChange(value.includes(c) ? value.filter((v) => v !== c) : [...value, c])
  const off = OPTIONS.filter((o) => !available(o.value)).map((o) => o.label)
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-sm font-semibold text-ink">Send by</legend>
      <div className="flex flex-wrap gap-2">
        {OPTIONS.map(({ value: option, label, icon: Icon }) => {
          const on = value.includes(option)
          const usable = available(option)
          return (
            <button
              key={option}
              type="button"
              aria-pressed={on}
              disabled={!usable}
              onClick={() => toggle(option)}
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                on ? 'border-primary bg-primary text-on-primary' : 'border-line-strong bg-surface text-ink hover:bg-subtle',
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </button>
          )
        })}
      </div>
      {!channels.loading && off.length > 0 && (
        <p className="text-[13px] text-muted">
          {off.join(' and ')} {off.length === 1 ? 'isn’t' : 'aren’t'} connected yet: the server needs {off.length === 1 ? 'its keys' : 'their keys'} (see the README).
        </p>
      )}
    </fieldset>
  )
}
