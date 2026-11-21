'use client';

import { RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Printer } from 'lucide-react';
import { Code128Barcode } from '@/components/orders/code128-barcode';
import { barcodeSize, encodeCode128 } from '@/lib/barcode/code128';
import { PRINT_RESI_CSS } from '@/lib/orders/print-resi-css';
import {
  courierLogoSrc, INITIAL_FIT, MAS_SULAR_LOGO_SRC, nextFitStep, PRINT_RESI_BLOCKER_MESSAGE, PrintResiItem,
  PrintResiOrderInput, printResiBlocker, PrintResiView, RESI_PAGE, RESI_SCALES, ResiFitState, toPrintResiView,
} from '@/lib/orders/print-resi-view';

/**
 * Print Resi — Admin Order Detail action.
 *
 * READ-ONLY: renders the order the page ALREADY loaded (no request of its own) into a
 * print-only 100 x 150 mm sheet portalled to <body>, then opens the browser print
 * dialog. No navigation, no mutation, no shipment/booking endpoint, no state outside
 * this component. The sheet and its stylesheet exist only while a print job runs.
 */
export function PrintResiAction({ order }: { order: PrintResiOrderInput }) {
  const blocker = printResiBlocker(order);
  const view = useMemo(() => toPrintResiView(order), [order]);
  const barcodeBelowMinimum = useMemo(() => {
    const encoding = encodeCode128(view.shipment.awb ?? '');
    return encoding ? !barcodeSize(encoding.totalModules, RESI_PAGE.barcodeMaxWidthMm).meetsMinimum : false;
  }, [view]);
  // 0 = idle; each click starts a fresh job (a new key re-runs the fit from scratch).
  const [job, setJob] = useState(0);
  const [unresolved, setUnresolved] = useState(false);

  useEffect(() => {
    if (!job) return;
    const done = () => setJob(0);
    window.addEventListener('afterprint', done);
    return () => window.removeEventListener('afterprint', done);
  }, [job]);

  const print = (fit: ResiFitState) => {
    setUnresolved(fit.unresolved);
    window.print();
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        data-action="print-resi"
        disabled={blocker !== null}
        title={blocker ? PRINT_RESI_BLOCKER_MESSAGE[blocker] : 'Cetak resi / packing slip 100 x 150 mm'}
        onClick={() => setJob((n) => n + 1)}
        className="inline-flex h-10 items-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-gray-700 ring-1 ring-gray-200 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Printer className="h-4 w-4" /> Print Resi
      </button>
      {blocker ? (
        <p role="status" className="max-w-xs text-right text-xs text-amber-700">{PRINT_RESI_BLOCKER_MESSAGE[blocker]}</p>
      ) : barcodeBelowMinimum ? (
        <p role="status" className="max-w-xs text-right text-xs text-amber-700">{BARCODE_BELOW_MINIMUM_MESSAGE}</p>
      ) : unresolved ? (
        <p role="status" className="max-w-xs text-right text-xs text-amber-700">Isi resi terlalu panjang untuk satu label; periksa pratinjau cetak.</p>
      ) : null}
      {job > 0 && blocker === null && typeof document !== 'undefined'
        ? createPortal(<PrintResiDocument key={job} view={view} onReady={print} />, document.body)
        : null}
    </div>
  );
}

/** Shown (never silently) when the AWB only fits the label below the 0.25 mm safe bar width. */
export const BARCODE_BELOW_MINIMUM_MESSAGE =
  'Peringatan: barcode resi ini lebih kecil dari 0,25 mm per garis agar muat di label 100 mm. Gunakan printer 300 dpi dan uji pindai sebelum dikirim.';

/** Measure → adjust until it fits, wait for the logos, then hand over to print. */
function PrintResiDocument({ view, onReady }: { view: PrintResiView; onReady: (fit: ResiFitState) => void }) {
  const [fit, setFit] = useState<ResiFitState>(INITIAL_FIT);
  const rootRef = useRef<HTMLDivElement>(null);
  const recipientRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const steps = useRef(0);
  const printed = useRef(false);

  useLayoutEffect(() => {
    if (fit.done) return;
    const recipient = recipientRef.current;
    const items = itemsRef.current;
    if (!recipient || !items) return;
    steps.current += 1;
    const limit = items.getBoundingClientRect().bottom + 0.5;
    const rows = Array.from(items.querySelectorAll<HTMLElement>('[data-resi-item]'));
    const measurement = {
      recipientOverflow: recipient.scrollHeight > recipient.clientHeight + 1,
      itemsOverflow: items.scrollHeight > items.clientHeight + 1,
      itemsFitting: rows.filter((row) => row.getBoundingClientRect().bottom <= limit).length,
      totalItems: view.items.length,
    };
    // Bounded: every step strictly advances the state; the guard only protects against a browser bug.
    setFit((state) => (steps.current > 100 ? { ...state, done: true, unresolved: true } : nextFitStep(state, measurement)));
  }, [fit, view]);

  useEffect(() => {
    if (!fit.done || printed.current) return;
    let cancelled = false;
    const images = Array.from(rootRef.current?.querySelectorAll('img') ?? []);
    void Promise.all(
      images.map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            }),
      ),
    ).then(() => {
      if (cancelled || printed.current) return;
      printed.current = true;
      onReady(fit);
    });
    return () => {
      cancelled = true;
    };
  }, [fit, onReady]);

  return (
    <div ref={rootRef} className="print-resi-root" aria-hidden="true" data-print-resi="">
      <style>{PRINT_RESI_CSS}</style>
      <PrintResiSheets view={view} fit={fit} recipientRef={recipientRef} itemsRef={itemsRef} />
    </div>
  );
}

export function PrintResiSheets({
  view,
  fit,
  recipientRef,
  itemsRef,
}: {
  view: PrintResiView;
  fit: ResiFitState;
  recipientRef?: RefObject<HTMLDivElement | null>;
  itemsRef?: RefObject<HTMLDivElement | null>;
}) {
  const page1Count = fit.page1Items ?? view.items.length;
  const page1Items = view.items.slice(0, page1Count);
  const restItems = view.items.slice(page1Count);
  const hasContinuation = fit.recipientOnContinuation || restItems.length > 0;
  const totalPcs = view.items.reduce((sum, item) => sum + item.quantity, 0);
  const awb = view.shipment.awb ?? '';
  const encoding = encodeCode128(awb);
  const size = encoding ? barcodeSize(encoding.totalModules, RESI_PAGE.barcodeMaxWidthMm) : null;
  const logo = courierLogoSrc(view.shipment.courier);
  const r = view.recipient;

  return (
    <>
      <section className="resi-sheet" style={{ ['--resi-scale' as string]: RESI_SCALES[fit.scaleIndex] }}>
        <header className="resi-box resi-header">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="resi-logo" src={MAS_SULAR_LOGO_SRC} alt="Bakso Mas Sular" />
          <div>
            <h1 className="resi-title">PACKING SLIP</h1>
            <dl className="resi-meta">
              <dt>Nomer Order</dt><dd>:</dd><dd className="resi-strong resi-wrap">{view.orderNumber}</dd>
              <dt>Tanggal</dt><dd>:</dd><dd className="resi-wrap">{view.orderDate}</dd>
              <dt>Outlet</dt><dd>:</dd><dd className="resi-wrap">{view.outlet}</dd>
            </dl>
          </div>
        </header>

        <div className="resi-middle">
          <section className="resi-box resi-col" aria-label="Penerima">
            <h2 className="resi-h">PENERIMA</h2>
            <div ref={recipientRef} className="resi-col-body resi-wrap">
              {r.notice ? <p className="resi-source" data-recipient-source={r.source}>{r.notice}</p> : null}
              <p className="resi-name">{r.name}</p>
              {r.phone ? <p>{r.phone}</p> : null}
              {fit.recipientOnContinuation ? (
                <>
                  {r.regionLines.length ? <p>{r.regionLines.join(', ')}</p> : null}
                  {r.postalCode ? <p>{r.postalCode}</p> : null}
                  <p className="resi-continued">Alamat lengkap: lihat halaman 2.</p>
                </>
              ) : (
                <RecipientAddress recipient={r} />
              )}
            </div>
          </section>

          <section className="resi-box resi-col" aria-label="Daftar pesanan">
            <h2 className="resi-h">DAFTAR PESANAN <small>{totalPcs} pcs</small></h2>
            <div ref={itemsRef} className="resi-col-body resi-wrap">
              <ItemList items={page1Items} />
              {restItems.length > 0 ? (
                <p className="resi-continued">
                  {page1Count === 0 ? 'Daftar pesanan di halaman 2.' : `Berlanjut di halaman 2 (${restItems.length} item lagi).`}
                </p>
              ) : null}
            </div>
          </section>
        </div>

        <section className="resi-box resi-ship" aria-label="Pengiriman">
          <h2 className="resi-h">PENGIRIMAN</h2>
          <div className="resi-ship-row">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="resi-courier-logo" src={logo} alt={view.shipment.courierName} data-courier={view.shipment.courier ?? ''} />
            ) : (
              <span className="resi-courier-name">{view.shipment.courierName}</span>
            )}
            {view.shipment.serviceName ? <span className="resi-service resi-wrap">{view.shipment.serviceName}</span> : null}
          </div>
          <p className="resi-awb-line resi-wrap">
            Resi / AWB&nbsp;:&nbsp;<span className="resi-awb">{awb}</span>
          </p>
          {encoding && size ? (
            <>
              <Code128Barcode value={awb} className="resi-barcode" widthMm={size.widthMm} heightMm={RESI_PAGE.barcodeHeightMm} />
              <p className="resi-barcode-text resi-wrap">{awb}</p>
            </>
          ) : null}
        </section>
      </section>

      {hasContinuation ? (
        <section className="resi-sheet resi-sheet--continuation" style={{ ['--resi-scale' as string]: RESI_SCALES[fit.scaleIndex] }}>
          <div className="resi-box resi-cont-head resi-wrap">
            PACKING SLIP (lanjutan) · Nomer Order {view.orderNumber} · Resi {awb}
          </div>
          {fit.recipientOnContinuation ? (
            <section className="resi-box" aria-label="Penerima (lengkap)">
              <h2 className="resi-h">PENERIMA</h2>
              <div className="resi-col-body resi-wrap">
                {r.notice ? <p className="resi-source">{r.notice}</p> : null}
                <p className="resi-name">{r.name}</p>
                {r.phone ? <p>{r.phone}</p> : null}
                <RecipientAddress recipient={r} />
              </div>
            </section>
          ) : null}
          {restItems.length > 0 ? (
            <section className="resi-box" aria-label="Daftar pesanan (lanjutan)">
              <h2 className="resi-h">DAFTAR PESANAN (lanjutan)</h2>
              <div className="resi-col-body resi-wrap">
                <ItemList items={restItems} />
              </div>
            </section>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function RecipientAddress({ recipient }: { recipient: PrintResiView['recipient'] }) {
  return (
    <>
      {recipient.addressLines.map((line, index) => (
        <p key={`a-${index}`}>{line}</p>
      ))}
      {recipient.regionLines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {recipient.postalCode ? <p>Kode pos {recipient.postalCode}</p> : null}
      {recipient.note ? <p className="resi-note">Catatan: {recipient.note}</p> : null}
    </>
  );
}

function ItemList({ items }: { items: PrintResiItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="resi-items">
      {items.map((item) => (
        <li key={item.key} className="resi-item" data-resi-item="">
          <div className="resi-item-head">
            <span className="resi-qty">{item.quantity}×</span>
            <span className="resi-wrap">{item.productName}</span>
          </div>
          {item.options.length || item.toppings.length || item.notes ? (
            <ul className="resi-sub">
              {item.options.map((option) => (
                <li key={`o-${option}`}>{option}</li>
              ))}
              {item.toppings.map((topping, index) => (
                <li key={`t-${index}`}>+ {topping}</li>
              ))}
              {item.notes ? <li className="resi-note">Catatan: {item.notes}</li> : null}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
