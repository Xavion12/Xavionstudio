import { zodResolver } from '@hookform/resolvers/zod'
import { Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { TextField, TextareaField } from '@/components/ui/Field'
import { useToast } from '@/contexts/ToastContext'
import { invalidate } from '@/hooks/useApi'
import { notificationsApi } from '@/services/endpoints'
import { offerSchema, type OfferValues } from '@/schemas/training'
import type { SendChannel } from '@/types'
import { applyServerErrors } from '@/utils/forms'
import { ChannelPicker, useChannels } from './ChannelPicker'

const MAX = 1000

/** A message to one member: in the app and / or by WhatsApp and email. Admin only. */
export function NotifyDialog({ open, onClose, memberId, memberName }: { open: boolean; onClose: () => void; memberId: number | null; memberName?: string }) {
  const toast = useToast()
  const live = useChannels()
  const [channels, setChannels] = useState<SendChannel[]>(['APP'])
  const { register, handleSubmit, reset, setError, control, formState } = useForm<OfferValues>({ resolver: zodResolver(offerSchema), defaultValues: { title: '', message: '' } })
  const message = useWatch({ control, name: 'message' }) ?? ''

  useEffect(() => {
    if (open) reset({ title: '', message: '' })
  }, [open, reset])
  useEffect(() => {
    if (open) setChannels(['APP', ...(live.whatsapp ? ['WHATSAPP' as const] : []), ...(live.email ? ['EMAIL' as const] : [])])
  }, [open, live.whatsapp, live.email])

  const submit = handleSubmit(async (values) => {
    if (!memberId) return
    if (!channels.length) {
      toast.error('Choose at least one way to send it')
      return
    }
    try {
      const result = await notificationsApi.send({ message: values.message.trim(), title: values.title.trim() || null, channels, member_ids: [memberId] })
      invalidate(`member:${memberId}`, 'notifications', 'messages')
      const by = [result.delivered ? 'the app' : '', result.whatsapp ? 'WhatsApp' : '', result.email ? 'email' : ''].filter(Boolean)
      if (by.length) toast.success('Message sent', { description: `By ${by.join(', ')}.` })
      else
        toast.warning('Not delivered', {
          description: `${memberName ?? 'This member'} has no app login, phone or email for the chosen channels, or turned messages off.`,
        })
      onClose()
    } catch (error) {
      if (!applyServerErrors(error, setError)) toast.fromError(error)
    }
  })

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Send a message"
      description={memberName}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="notify-form" icon={Send} loading={formState.isSubmitting}>
            Send
          </Button>
        </>
      }
    >
      <form id="notify-form" onSubmit={submit} className="space-y-4" noValidate>
        <ChannelPicker value={channels} onChange={setChannels} />
        <TextField label="Title" placeholder="Email subject (optional)" maxLength={80} error={formState.errors.title?.message} {...register('title')} />
        <TextareaField
          label="Message"
          required
          rows={4}
          maxLength={MAX}
          placeholder="e.g. Your membership ends on Friday — renew at the desk or in the app."
          hint={`${message.length}/${MAX}`}
          error={formState.errors.message?.message}
          {...register('message')}
          data-autofocus
        />
      </form>
    </Dialog>
  )
}
