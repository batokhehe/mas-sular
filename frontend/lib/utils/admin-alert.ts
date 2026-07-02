'use client'

import Swal from 'sweetalert2'
import withReactContent from 'sweetalert2-react-content'
import { ApiError } from '@/lib/api/client'

// One configured instance — no SweetAlert config is duplicated across pages.
const swal = withReactContent(Swal)

const COLORS = {
  danger: '#dc2626', // red-600  — destructive confirms
  primary: '#111827', // gray-900 — neutral confirms / info
  cancel: '#6b7280', // gray-500
} as const

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------- Confirmations ----------------

/** Destructive delete confirm. Title defaults to "Delete Item?" per spec. */
export async function confirmDelete(entity = 'Item'): Promise<boolean> {
  const res = await swal.fire({
    icon: 'warning',
    title: `Delete ${entity}?`,
    text: 'This action cannot be undone.',
    showCancelButton: true,
    confirmButtonText: 'Delete',
    cancelButtonText: 'Cancel',
    confirmButtonColor: COLORS.danger,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
    focusCancel: true,
  })
  return res.isConfirmed
}

export async function confirmVerifyPayment(): Promise<boolean> {
  const res = await swal.fire({
    icon: 'question',
    title: 'Verify Payment?',
    text: 'This payment will be marked as PAID and the order will move to PROCESSING.',
    showCancelButton: true,
    confirmButtonText: 'Verify',
    cancelButtonText: 'Cancel',
    confirmButtonColor: COLORS.primary,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return res.isConfirmed
}

/** Reject confirm with an optional reason captured in the same modal. */
export async function confirmRejectPayment(): Promise<{ confirmed: boolean; note?: string }> {
  const res = await swal.fire({
    icon: 'warning',
    title: 'Reject Payment?',
    text: 'This payment will be rejected and inventory will be restored.',
    input: 'textarea',
    inputPlaceholder: 'Reason (optional)',
    inputAttributes: { 'aria-label': 'Rejection reason' },
    showCancelButton: true,
    confirmButtonText: 'Reject',
    cancelButtonText: 'Cancel',
    confirmButtonColor: COLORS.danger,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return { confirmed: res.isConfirmed, note: (res.value as string)?.trim() || undefined }
}

/** Status transition confirm — shows "CURRENT → NEW". Used for order + shipment status. */
export async function confirmStatusChange(
  current: string,
  next: string,
  opts: { title?: string } = {},
): Promise<boolean> {
  const res = await swal.fire({
    icon: 'question',
    title: opts.title ?? 'Update Order Status?',
    html: `<div style="font-size:15px;letter-spacing:.3px">
        <span style="font-weight:700">${escapeHtml(current)}</span>
        <span style="margin:0 8px;color:${COLORS.cancel}">&rarr;</span>
        <span style="font-weight:700">${escapeHtml(next)}</span>
      </div>`,
    showCancelButton: true,
    confirmButtonText: 'Update',
    cancelButtonText: 'Cancel',
    confirmButtonColor: COLORS.primary,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return res.isConfirmed
}

export async function confirmCreate(): Promise<boolean> {
  const res = await swal.fire({
    icon: 'question',
    title: 'Create data?',
    showCancelButton: true,
    confirmButtonText: 'Create',
    cancelButtonText: 'Cancel',
    confirmButtonColor: COLORS.primary,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return res.isConfirmed
}

export async function confirmUpdate(): Promise<boolean> {
  const res = await swal.fire({
    icon: 'question',
    title: 'Save changes?',
    showCancelButton: true,
    confirmButtonText: 'Save',
    cancelButtonText: 'Cancel',
    confirmButtonColor: COLORS.primary,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return res.isConfirmed
}

export async function confirmCancel(): Promise<boolean> {
  const res = await swal.fire({
    icon: 'warning',
    title: 'Cancel this item?',
    showCancelButton: true,
    confirmButtonText: 'Cancel',
    // The confirm button is "Cancel"; label the dismiss button "No" to avoid two "Cancel"s.
    cancelButtonText: 'No',
    confirmButtonColor: COLORS.danger,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
    focusCancel: true,
  })
  return res.isConfirmed
}

/** Generic approve confirm (domain pages may use a richer action-specific confirmer). */
export async function confirmApprove(): Promise<boolean> {
  const res = await swal.fire({
    icon: 'question',
    title: 'Approve this item?',
    showCancelButton: true,
    confirmButtonText: 'Approve',
    cancelButtonText: 'Cancel',
    confirmButtonColor: COLORS.primary,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return res.isConfirmed
}

export async function confirmReject(): Promise<boolean> {
  const res = await swal.fire({
    icon: 'warning',
    title: 'Reject this item?',
    showCancelButton: true,
    confirmButtonText: 'Reject',
    cancelButtonText: 'Cancel',
    confirmButtonColor: COLORS.danger,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return res.isConfirmed
}

export async function confirmActivate(): Promise<boolean> {
  const res = await swal.fire({
    icon: 'question',
    title: 'Activate this item?',
    showCancelButton: true,
    confirmButtonText: 'Activate',
    cancelButtonText: 'Cancel',
    confirmButtonColor: COLORS.primary,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return res.isConfirmed
}

export async function confirmDeactivate(): Promise<boolean> {
  const res = await swal.fire({
    icon: 'warning',
    title: 'Deactivate this item?',
    showCancelButton: true,
    confirmButtonText: 'Deactivate',
    cancelButtonText: 'Cancel',
    confirmButtonColor: COLORS.danger,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return res.isConfirmed
}

// ---------------- Canonical success messages ----------------

/** Centralized success copy for admin mutations (use with showSuccess). */
export const ADMIN_SUCCESS_MESSAGES = {
  create: 'Data created successfully',
  update: 'Changes saved successfully',
  delete: 'Data deleted successfully',
  approve: 'Item approved successfully',
  reject: 'Item rejected successfully',
  cancel: 'Item cancelled successfully',
  activate: 'Item activated successfully',
  deactivate: 'Item deactivated successfully',
} as const

// ---------------- Feedback ----------------

export function showSuccess(title: string, text: string): Promise<unknown> {
  return swal.fire({ icon: 'success', title, text, confirmButtonColor: COLORS.primary })
}

export function showError(error: unknown): Promise<unknown> {
  return swal.fire({
    icon: 'error',
    title: 'Operation Failed',
    text: extractErrorMessage(error),
    confirmButtonColor: COLORS.primary,
  })
}

/** Blocking loading modal; replaced automatically by the next showSuccess/showError. */
export function showLoading(title = 'Processing...'): void {
  void swal.fire({
    title,
    allowOutsideClick: false,
    allowEscapeKey: false,
    didOpen: () => Swal.showLoading(),
  })
}

export function closeAlert(): void {
  Swal.close()
}

// ---------------- Error message extraction ----------------

/** ApiError.message → backend body message → status fallback → generic fallback. */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: string | string[] } | undefined
    const bodyMessage = Array.isArray(body?.message) ? body?.message.join(', ') : body?.message
    return bodyMessage || error.message || statusFallback(error.status)
  }
  if (error instanceof Error && error.message) return error.message
  return 'Something went wrong. Please try again.'
}

function statusFallback(status: number): string {
  switch (status) {
    case 400:
      return 'Invalid request. Please check the form and try again.'
    case 401:
      return 'Your session has expired. Please sign in again.'
    case 403:
      return 'You do not have permission to perform this action.'
    case 404:
      return 'The requested item was not found.'
    case 409:
      return 'This action conflicts with the current state. Please refresh and try again.'
    case 422:
      return 'The submitted data was rejected. Please review and try again.'
    case 500:
      return 'Something went wrong on our end. Please try again.'
    default:
      return 'Something went wrong. Please try again.'
  }
}
