'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FileText, X, ZoomIn } from 'lucide-react';

type Props = {
  url?: string | null;
  orderNumber: string;
};

/** Robust PDF detection: ignores query strings / hashes (e.g. receipt.pdf?token=…#p=2). */
function isPdfUrl(url: string): boolean {
  try {
    const path = new URL(url, 'http://x').pathname;
    return /\.pdf$/i.test(path);
  } catch {
    return /\.pdf(\?|#|$)/i.test(url);
  }
}

function StatusBadge({ uploaded }: { uploaded: boolean }) {
  return uploaded ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 ring-1 ring-green-200">
      Uploaded
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500 ring-1 ring-gray-200">
      No Receipt
    </span>
  );
}

/**
 * Payment-receipt cell: a status badge + (if present) a lazy 60px thumbnail / PDF chip.
 * Clicking opens a preview modal (Download, Open in New Tab, image zoom, PDF preview).
 * Reuses the existing Payment.manualReceiptUrl — no new endpoint/storage/column.
 */
export function ReceiptCell({ url, orderNumber }: Props) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const pdf = url ? isPdfUrl(url) : false;

  return (
    <div className="flex flex-col items-start gap-1.5">
      <StatusBadge uploaded={!!url} />

      {url ? (
        pdf ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            aria-label={`Preview receipt for ${orderNumber}`}
          >
            <FileText className="h-4 w-4 text-red-500" /> PDF
          </button>
        ) : (
          <div className="relative h-[60px] w-[60px]">
            {!loaded ? <div className="absolute inset-0 animate-pulse rounded-md bg-gray-200" /> : null}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={`Receipt for ${orderNumber}`}
              loading="lazy"
              onLoad={() => setLoaded(true)}
              onClick={() => setOpen(true)}
              className={`h-[60px] w-[60px] cursor-zoom-in rounded-md object-cover ring-1 ring-gray-200 transition hover:ring-[#465fff] ${loaded ? '' : 'opacity-0'}`}
            />
          </div>
        )
      ) : null}

      {open && url ? (
        <ReceiptModal url={url} pdf={pdf} orderNumber={orderNumber} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}

function ReceiptModal({
  url,
  pdf,
  orderNumber,
  onClose,
}: {
  url: string;
  pdf: boolean;
  orderNumber: string;
  onClose: () => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [zoomed, setZoomed] = useState(false);

  // Accessibility: focus trap + ESC + restore focus + body scroll lock.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';

    const focusables = () =>
      modalRef.current
        ? Array.from(
            modalRef.current.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];

    focusables()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Payment receipt for ${orderNumber}`}
      onClick={onClose}
    >
      <div
        ref={modalRef}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-gray-900">Payment receipt · {orderNumber}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-gray-400 hover:bg-gray-100"
            aria-label="Close preview"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex min-h-[260px] flex-1 items-center justify-center overflow-auto bg-gray-50 p-4">
          {pdf ? (
            <iframe title={`Receipt PDF for ${orderNumber}`} src={url} className="h-[70vh] w-full rounded-md border-0" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={`Receipt for ${orderNumber}`}
              onClick={() => setZoomed((z) => !z)}
              className={
                zoomed
                  ? 'w-auto max-w-none cursor-zoom-out rounded-md'
                  : 'max-h-[70vh] w-auto cursor-zoom-in rounded-md object-contain'
              }
            />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-100 px-4 py-3">
          {!pdf ? (
            <button
              type="button"
              onClick={() => setZoomed((z) => !z)}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <ZoomIn className="h-4 w-4" /> {zoomed ? 'Fit' : 'Zoom'}
            </button>
          ) : null}
          <a
            href={url}
            download
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Download className="h-4 w-4" /> Download
          </a>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <ExternalLink className="h-4 w-4" /> Open in New Tab
          </a>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
