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
export async function confirmDelete(entity = 'item'): Promise<boolean> {
  const res = await swal.fire({
    icon: 'warning',
    title: `Hapus ${entity}?`,
    text: 'Tindakan ini tidak dapat dibatalkan.',
    showCancelButton: true,
    confirmButtonText: 'Hapus',
    cancelButtonText: 'Batal',
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
    title: 'Verifikasi pembayaran?',
    text: 'Pembayaran ini akan ditandai Lunas dan pesanan akan berpindah ke status Diproses.',
    showCancelButton: true,
    confirmButtonText: 'Verifikasi',
    cancelButtonText: 'Batal',
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
    title: 'Tolak pembayaran?',
    text: 'Pembayaran ini akan ditolak dan stok akan dikembalikan.',
    input: 'textarea',
    inputPlaceholder: 'Alasan (opsional)',
    inputAttributes: { 'aria-label': 'Alasan penolakan' },
    showCancelButton: true,
    confirmButtonText: 'Tolak',
    cancelButtonText: 'Batal',
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
    title: opts.title ?? 'Ubah status pesanan?',
    html: `<div style="font-size:15px;letter-spacing:.3px">
        <span style="font-weight:700">${escapeHtml(current)}</span>
        <span style="margin:0 8px;color:${COLORS.cancel}">&rarr;</span>
        <span style="font-weight:700">${escapeHtml(next)}</span>
      </div>`,
    showCancelButton: true,
    confirmButtonText: 'Perbarui',
    cancelButtonText: 'Batal',
    confirmButtonColor: COLORS.primary,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return res.isConfirmed
}

export async function confirmCreate(): Promise<boolean> {
  const res = await swal.fire({
    icon: 'question',
    title: 'Buat data?',
    showCancelButton: true,
    confirmButtonText: 'Buat',
    cancelButtonText: 'Batal',
    confirmButtonColor: COLORS.primary,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return res.isConfirmed
}

export async function confirmUpdate(): Promise<boolean> {
  const res = await swal.fire({
    icon: 'question',
    title: 'Simpan perubahan?',
    showCancelButton: true,
    confirmButtonText: 'Simpan',
    cancelButtonText: 'Batal',
    confirmButtonColor: COLORS.primary,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return res.isConfirmed
}

export async function confirmCancel(): Promise<boolean> {
  const res = await swal.fire({
    icon: 'warning',
    title: 'Batalkan item ini?',
    showCancelButton: true,
    confirmButtonText: 'Batal',
    // The confirm button is "Batal"; label the dismiss button "Tidak" to avoid two "Batal"s.
    cancelButtonText: 'Tidak',
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
    title: 'Setujui item ini?',
    showCancelButton: true,
    confirmButtonText: 'Setujui',
    cancelButtonText: 'Batal',
    confirmButtonColor: COLORS.primary,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return res.isConfirmed
}

export async function confirmReject(): Promise<boolean> {
  const res = await swal.fire({
    icon: 'warning',
    title: 'Tolak item ini?',
    showCancelButton: true,
    confirmButtonText: 'Tolak',
    cancelButtonText: 'Batal',
    confirmButtonColor: COLORS.danger,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return res.isConfirmed
}

export async function confirmActivate(): Promise<boolean> {
  const res = await swal.fire({
    icon: 'question',
    title: 'Aktifkan item ini?',
    showCancelButton: true,
    confirmButtonText: 'Aktifkan',
    cancelButtonText: 'Batal',
    confirmButtonColor: COLORS.primary,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return res.isConfirmed
}

export async function confirmDeactivate(): Promise<boolean> {
  const res = await swal.fire({
    icon: 'warning',
    title: 'Nonaktifkan item ini?',
    showCancelButton: true,
    confirmButtonText: 'Nonaktifkan',
    cancelButtonText: 'Batal',
    confirmButtonColor: COLORS.danger,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  })
  return res.isConfirmed
}

// ---------------- Canonical success messages ----------------

/** Centralized success copy for admin mutations (use with showSuccess). */
export const ADMIN_SUCCESS_MESSAGES = {
  create: 'Data berhasil dibuat',
  update: 'Perubahan berhasil disimpan',
  delete: 'Data berhasil dihapus',
  approve: 'Item berhasil disetujui',
  reject: 'Item berhasil ditolak',
  cancel: 'Item berhasil dibatalkan',
  activate: 'Item berhasil diaktifkan',
  deactivate: 'Item berhasil dinonaktifkan',
} as const

// ---------------- Feedback ----------------

export function showSuccess(title: string, text: string): Promise<unknown> {
  return swal.fire({ icon: 'success', title, text, confirmButtonColor: COLORS.primary })
}

export function showError(error: unknown): Promise<unknown> {
  return swal.fire({
    icon: 'error',
    title: 'Operasi gagal',
    text: extractErrorMessage(error),
    confirmButtonColor: COLORS.primary,
  })
}

/** Blocking loading modal; replaced automatically by the next showSuccess/showError. */
export function showLoading(title = 'Memproses...'): void {
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
  return 'Terjadi kesalahan. Silakan coba lagi.'
}

function statusFallback(status: number): string {
  switch (status) {
    case 400:
      return 'Permintaan tidak valid. Periksa kembali formulir lalu coba lagi.'
    case 401:
      return 'Sesi Anda telah berakhir. Silakan masuk kembali.'
    case 403:
      return 'Anda tidak memiliki izin untuk melakukan tindakan ini.'
    case 404:
      return 'Data yang diminta tidak ditemukan.'
    case 409:
      return 'Tindakan ini bertentangan dengan kondisi data saat ini. Muat ulang halaman lalu coba lagi.'
    case 422:
      return 'Data yang dikirim ditolak. Periksa kembali lalu coba lagi.'
    case 500:
      return 'Terjadi kesalahan di server. Silakan coba lagi.'
    default:
      return 'Terjadi kesalahan. Silakan coba lagi.'
  }
}
