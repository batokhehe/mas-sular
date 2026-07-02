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

export async function confirmDelete(entity = 'Item'): Promise<boolean> {
  const res = await Swal.fire({
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
  });
  return res.isConfirmed;
}

export async function confirmApprove(opts: { title?: string; text?: string } = {}): Promise<boolean> {
  const res = await Swal.fire({
    icon: 'question',
    title: opts.title ?? 'Approve this item?',
    text: opts.text,
    showCancelButton: true,
    confirmButtonText: 'Confirm',
    cancelButtonText: 'Cancel',
    confirmButtonColor: COLORS.primary,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  });
  return res.isConfirmed;
}

export async function confirmReject(opts: { title?: string; text?: string } = {}): Promise<boolean> {
  const res = await Swal.fire({
    icon: 'warning',
    title: opts.title ?? 'Reject this item?',
    text: opts.text,
    showCancelButton: true,
    confirmButtonText: 'Reject',
    cancelButtonText: 'Cancel',
    confirmButtonColor: COLORS.danger,
    cancelButtonColor: COLORS.cancel,
    reverseButtons: true,
  });
  return res.isConfirmed;
}

export async function confirmUpdate(opts: { title?: string; text?: string } = {}): Promise<boolean> {
  const res = await Swal.fire({
    icon: 'question',
    title: opts.title ?? 'Save changes?',
    text: opts.text,
    showCancelButton: true,
    confirmButtonText: 'Save',
    cancelButtonText: 'Cancel',
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
    title: opts.title ?? 'Update Status?',
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
  });
  return res.isConfirmed;
}

// ---------------- Canonical copy ----------------

/** Loading-modal titles, one per mutation kind. */
export const ADMIN_LOADING_MESSAGES = {
  create: 'Creating...',
  update: 'Saving...',
  delete: 'Deleting...',
  verify: 'Verifying...',
  reject: 'Rejecting...',
  statusUpdate: 'Updating...',
} as const;

/** Success copy. Entity-specific create/delete are builders; the rest are fixed strings. */
export const ADMIN_SUCCESS_MESSAGES = {
  created: (entity: string) => `${entity} created successfully`,
  updated: 'Changes saved successfully',
  deleted: (entity: string) => `${entity} deleted successfully`,
  paymentVerified: 'Payment verified successfully',
  paymentRejected: 'Payment rejected successfully',
  orderStatusUpdated: 'Order status updated successfully',
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
    title: 'Operation Failed',
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
  return 'Something went wrong. Please try again.';
}

function statusFallback(status: number): string {
  switch (status) {
    case 400:
      return 'Invalid request. Please check the form and try again.';
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 403:
      return 'You do not have permission to perform this action.';
    case 404:
      return 'The requested item was not found.';
    case 409:
      return 'This action conflicts with the current state. Please refresh and try again.';
    case 422:
      return 'The submitted data was rejected. Please review and try again.';
    case 500:
      return 'Something went wrong on our end. Please try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
