'use client';

/**
 * Phase Admin-1 — shared SweetAlert2 helper for the standalone admin app.
 *
 * Canonical flow per mutation: confirm → showLoading → mutation → showSuccess / showError.
 * Confirmations return a boolean (or are gated by isConfirmed); success is a
 * non-blocking toast; errors are a blocking modal. extractErrorMessage adapts to
 * this app's ApiError shape (Error & { status }) from lib/api.ts.
 */
import Swal from 'sweetalert2';
import type { ApiError } from '@/lib/api';

const COLORS = {
  danger: '#dc2626', // red-600 — destructive
  primary: '#111827', // gray-900 — neutral / info
  cancel: '#6b7280', // gray-500
} as const;

// Non-blocking success toast (top-right, auto-dismiss). Replaces any open modal.
const Toast = Swal.mixin({
  toast: true,
  position: 'top-end',
  showConfirmButton: false,
  timer: 2200,
  timerProgressBar: true,
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------- Confirmations ----------------

export async function confirmDelete(entity = 'item'): Promise<boolean> {
  const res = await Swal.fire({
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
  });
  return res.isConfirmed;
}

export async function confirmApprove(opts: { title?: string; text?: string } = {}): Promise<boolean> {
  const res = await Swal.fire({
    icon: 'question',
    title: opts.title ?? 'Setujui item ini?',
    text: opts.text,
    showCancelButton: true,
    confirmButtonText: 'Konfirmasi',
    cancelButtonText: 'Batal',
    confirmButtonColor: COLORS.primary,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  });
  return res.isConfirmed;
}

export async function confirmReject(opts: { title?: string; text?: string } = {}): Promise<boolean> {
  const res = await Swal.fire({
    icon: 'warning',
    title: opts.title ?? 'Tolak item ini?',
    text: opts.text,
    showCancelButton: true,
    confirmButtonText: 'Tolak',
    cancelButtonText: 'Batal',
    confirmButtonColor: COLORS.danger,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  });
  return res.isConfirmed;
}

export async function confirmUpdate(opts: { title?: string; text?: string } = {}): Promise<boolean> {
  const res = await Swal.fire({
    icon: 'question',
    title: opts.title ?? 'Simpan perubahan?',
    text: opts.text,
    showCancelButton: true,
    confirmButtonText: 'Simpan',
    cancelButtonText: 'Batal',
    confirmButtonColor: COLORS.primary,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  });
  return res.isConfirmed;
}

/** Status transition confirm — renders "CURRENT → NEW". */
export async function confirmStatusChange(
  current: string,
  next: string,
  opts: { title?: string } = {},
): Promise<boolean> {
  const res = await Swal.fire({
    icon: 'question',
    title: opts.title ?? 'Ubah status?',
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
  });
  return res.isConfirmed;
}

// ---------------- Canonical copy ----------------

/** Loading-modal titles, one per mutation kind. */
export const ADMIN_LOADING_MESSAGES = {
  create: 'Membuat...',
  update: 'Menyimpan...',
  delete: 'Menghapus...',
  verify: 'Memverifikasi...',
  reject: 'Menolak...',
  statusUpdate: 'Memperbarui...',
} as const;

/** Success copy. Entity-specific create/delete are builders; the rest are fixed strings. */
export const ADMIN_SUCCESS_MESSAGES = {
  created: (entity: string) => `${entity} berhasil dibuat`,
  updated: 'Perubahan berhasil disimpan',
  deleted: (entity: string) => `${entity} berhasil dihapus`,
  paymentVerified: 'Pembayaran berhasil diverifikasi',
  paymentRejected: 'Pembayaran berhasil ditolak',
  orderStatusUpdated: 'Status pesanan berhasil diperbarui',
} as const;

// ---------------- Feedback ----------------

/** Blocking loading modal. Closed explicitly by the next showSuccess/showError. */
export function showLoading(title: string = ADMIN_LOADING_MESSAGES.update): void {
  void Swal.fire({
    title,
    allowOutsideClick: false,
    allowEscapeKey: false,
    didOpen: () => Swal.showLoading(),
  });
}

/** Non-blocking success toast. Explicitly closes any open (loading) modal first. */
export function showSuccess(message: string): void {
  Swal.close();
  void Toast.fire({ icon: 'success', title: message });
}

/** Blocking error modal. Explicitly closes any open (loading) modal first. */
export function showError(error: unknown): Promise<unknown> {
  Swal.close();
  return Swal.fire({
    icon: 'error',
    title: 'Operasi gagal',
    text: extractErrorMessage(error),
    confirmButtonColor: COLORS.primary,
  });
}

// ---------------- Mutation wrapper ----------------

export interface RunWithFeedbackOptions<T = unknown> {
  /** Optional pre-flight confirm; returning false aborts before any loading/mutation. */
  confirm?: () => Promise<boolean>;
  /** Loading-modal title (use ADMIN_LOADING_MESSAGES). */
  loading: string;
  /**
   * Success toast message. A function variant receives the action's resolved value,
   * so callers (e.g. bulk verify) can build a message from aggregated results.
   */
  success: string | ((result: T) => string);
  /** The mutation to run (e.g. () => mutation.mutateAsync(args)). */
  action: () => Promise<T>;
}

/**
 * Phase Admin-4 — single feedback flow: confirm? → showLoading → action → showSuccess,
 * catch → showError. The loading modal is ALWAYS closed in `finally`; success/error
 * are rendered afterward. Returns true on success, false on abort/error.
 */
export async function runWithFeedback<T = unknown>(opts: RunWithFeedbackOptions<T>): Promise<boolean> {
  if (opts.confirm && !(await opts.confirm())) return false;

  showLoading(opts.loading);
  let result: T | undefined;
  let caught: unknown;
  let ok = false;
  try {
    result = await opts.action();
    ok = true;
  } catch (error) {
    caught = error;
  } finally {
    Swal.close(); // always dismiss the loading modal
  }

  if (ok) {
    showSuccess(typeof opts.success === 'function' ? opts.success(result as T) : opts.success);
  } else {
    void showError(caught);
  }
  return ok;
}

// ---------------- Error message extraction ----------------

/** This app's api() already folds the backend body.message into Error.message; fall back to status, then generic. */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message) return error.message;
    const status = (error as ApiError).status;
    if (typeof status === 'number') return statusFallback(status);
  }
  return 'Terjadi kesalahan. Silakan coba lagi.';
}

function statusFallback(status: number): string {
  switch (status) {
    case 400:
      return 'Permintaan tidak valid. Periksa kembali formulir lalu coba lagi.';
    case 401:
      return 'Sesi Anda telah berakhir. Silakan masuk kembali.';
    case 403:
      return 'Anda tidak memiliki izin untuk melakukan tindakan ini.';
    case 404:
      return 'Data yang diminta tidak ditemukan.';
    case 409:
      return 'Tindakan ini bertentangan dengan kondisi data saat ini. Muat ulang halaman lalu coba lagi.';
    case 422:
      return 'Data yang dikirim ditolak. Periksa kembali lalu coba lagi.';
    case 500:
      return 'Terjadi kesalahan di server. Silakan coba lagi.';
    default:
      return 'Terjadi kesalahan. Silakan coba lagi.';
  }
}
