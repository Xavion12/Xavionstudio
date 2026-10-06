import { useState } from 'react'
import { useToast } from '@/contexts/ToastContext'
import { downloadReceipt, receiptFileName, receiptPdf } from '@/services/documents'
import { paymentsApi, portalApi } from '@/services/endpoints'
import { saveBlob } from '@/utils/download'
import { receiptMessage, whatsAppLink } from '@/utils/whatsapp'

/** Phones (Android / iOS) can hand a PDF file to WhatsApp through the share sheet. */
export const canSharePdf =
  typeof navigator !== 'undefined' &&
  typeof navigator.canShare === 'function' &&
  (() => {
    try {
      return navigator.canShare({ files: [new File(['%PDF-'], 'test.pdf', { type: 'application/pdf' })] })
    } catch {
      return false
    }
  })()

/** Receipts: save the PDF, send it on WhatsApp (free: opens the chat with the message typed), or share the PDF file. */
export function useReceipt(scope: 'staff' | 'member' = 'staff') {
  const toast = useToast()
  const [busy, setBusy] = useState<number | null>(null)
  const fetchReceipt = (id: number) => (scope === 'member' ? portalApi.receipt(id) : paymentsApi.receipt(id))

  const download = async (payment: { id: number }) => {
    setBusy(payment.id)
    try {
      await downloadReceipt(await fetchReceipt(payment.id))
    } catch (error) {
      toast.fromError(error, "We couldn't create the receipt. Please try again.")
    } finally {
      setBusy(null)
    }
  }

  /** Opens WhatsApp to the member with the receipt message ready; staff press Send. */
  const whatsapp = async (payment: { id: number }) => {
    // Open the window during the click (browsers block pop-ups opened after a network wait).
    const win = window.open('', '_blank')
    setBusy(payment.id)
    try {
      const receipt = await fetchReceipt(payment.id)
      if (!receipt.member_whatsapp) {
        win?.close()
        toast.error('No phone number', { description: 'Add the member’s mobile number to send on WhatsApp.' })
        return
      }
      const link = whatsAppLink(receipt.member_whatsapp, receiptMessage(receipt))
      if (win) win.location.href = link
      else window.location.href = link
    } catch (error) {
      win?.close()
      toast.fromError(error, "We couldn't prepare the WhatsApp message. Please try again.")
    } finally {
      setBusy(null)
    }
  }

  /** The PDF itself through the phone's share sheet (pick WhatsApp and the member); saves it where sharing isn't possible. */
  const share = async (payment: { id: number }) => {
    setBusy(payment.id)
    try {
      const receipt = await fetchReceipt(payment.id)
      const blob = await receiptPdf(receipt)
      const file = new File([blob], receiptFileName(receipt), { type: 'application/pdf' })
      if (canSharePdf && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: `Receipt ${receipt.receipt_number}`, text: receiptMessage(receipt) })
          return
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return // the user closed the sheet
        }
      }
      saveBlob(blob, file.name)
      toast.success('Receipt saved', { description: 'Attach the PDF in WhatsApp from your downloads.' })
    } catch (error) {
      toast.fromError(error, "We couldn't create the receipt. Please try again.")
    } finally {
      setBusy(null)
    }
  }

  return { busy, download, whatsapp, share }
}
