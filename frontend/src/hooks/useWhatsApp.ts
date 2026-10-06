import { useConfig } from '@/contexts/ConfigContext'
import { useToast } from '@/contexts/ToastContext'
import { openWhatsApp, whatsAppNumber } from '@/utils/whatsapp'

/** Send a ready-typed WhatsApp message to a member's phone (free: staff press Send in WhatsApp). */
export function useWhatsApp() {
  const config = useConfig()
  const toast = useToast()
  return (phone: string | null | undefined, text: string) => {
    if (!openWhatsApp(whatsAppNumber(phone, config.country_code || '91'), text)) {
      toast.error('No phone number', { description: 'Add the member’s mobile number to send on WhatsApp.' })
    }
  }
}
