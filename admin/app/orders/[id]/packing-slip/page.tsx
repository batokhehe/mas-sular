'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Printer, RefreshCw } from 'lucide-react';
import { AdminShell } from '@/components/layout/admin-shell';
import { Code128Barcode } from '@/components/orders/code128-barcode';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchPackingSlip, PackingSlipView } from '@/lib/admin';
import { barcodeValue, PACKING_SLIP_ERROR_MESSAGE, packingSlipErrorKind } from '@/lib/orders/packing-slip-view';

/**
 * P3 Packing Slip — a printable A4 document (same idea as the customer invoice page):
 * no admin navigation, a "Cetak / Simpan PDF" button hidden in print, and the
 * browser's print dialog for paper or PDF. Data comes from the read-only
 * GET /admin/orders/:id/packing-slip (Order.read); nothing is stored or cached.
 */
export default function PackingSlipPage() {
  const params = useParams();
  const orderId = typeof params?.id === 'string' ? params.id : '';
  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.orders} variant="document">
      <PackingSlipScreen orderId={orderId} />
    </AdminShell>
  );
}

/* A4 portrait with ~12 mm margins; screen and print share the same document. */
const PRINT_CSS = `
@page { size: A4 portrait; margin: 12mm; }
@media print {
  html, body { background: #ffffff !important; }
  .packing-slip { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .packing-slip thead { display: table-header-group; }
  .packing-slip tr, .packing-slip .avoid-break { break-inside: avoid; page-break-inside: avoid; }
}
`;

function PackingSlipScreen({ orderId }: { orderId: string }) {
  const query = useQuery({
    queryKey: ['admin-packing-slip', orderId],
    queryFn: () => fetchPackingSlip(orderId),
    enabled: Boolean(orderId),
    retry: false,
    gcTime: 0, // customer data: do not keep it in the client cache after leaving
  });

  return (
    <div className="min-h-screen bg-gray-100 px-4 py-6 print:bg-white print:p-0">
      <style>{PRINT_CSS}</style>
      {query.isLoading ? (
        <SlipSkeleton />
      ) : query.isError || !query.data ? (
        <SlipError error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : (
        <>
          <div className="mx-auto mb-4 flex max-w-[210mm] justify-end print:hidden">
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-gray-900 px-4 text-sm font-medium text-white hover:bg-gray-700"
            >
              <Printer className="h-4 w-4" /> Cetak / Simpan PDF
            </button>
          </div>
          <PackingSlipDocument slip={query.data} />
        </>
      )}
    </div>
  );
}

function PackingSlipDocument({ slip }: { slip: PackingSlipView }) {
  const barcode = barcodeValue(slip.shipment);
  return (
    <article className="packing-slip mx-auto max-w-[210mm] space-y-4 bg-white p-8 text-[13px] leading-snug text-black shadow-sm print:max-w-none print:p-0 print:shadow-none">
      {/* Header: brand | PACKING SLIP | order meta */}
      <header className="avoid-break grid grid-cols-[auto_1fr] items-start gap-6 border-2 border-black p-4 sm:grid-cols-[auto_1fr_auto]">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-black text-base font-bold text-white">BMS</div>
          <div className="text-sm font-semibold">Bakso Mas Sular</div>
        </div>
        <h1 className="self-center text-center text-2xl font-extrabold tracking-[0.2em]">PACKING SLIP</h1>
        <dl className="col-span-2 grid grid-cols-[auto_auto_1fr] gap-x-2 gap-y-1 sm:col-span-1">
          <MetaRow label="Nomor Order" value={slip.orderNumber} strong />
          <MetaRow label="Tanggal" value={slip.orderDate} />
          <MetaRow label="Outlet" value={slip.outlet} />
        </dl>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 print:grid-cols-2">
        {/* Recipient */}
        <section className="avoid-break border-2 border-black p-4" aria-labelledby="slip-recipient">
          <h2 id="slip-recipient" className="mb-3 border-b border-black pb-1 text-sm font-extrabold tracking-wider">PENERIMA</h2>
          <dl className="grid grid-cols-[auto_auto_1fr] gap-x-2 gap-y-1">
            <MetaRow label="Nama" value={slip.recipient.name} strong />
            <MetaRow label="Alamat" value={slip.recipient.address} />
            {slip.recipient.regionLines.map((line) => (
              <MetaRow key={line} label="" value={line} />
            ))}
            <MetaRow label="Kode pos" value={slip.recipient.postalCode} />
            <MetaRow label="No. WA" value={slip.recipient.phone} />
          </dl>
        </section>

        {/* Items: No. | Nama Produk | Qty — toppings as indented sub-lines, no prices */}
        <section className="border-2 border-black p-4" aria-labelledby="slip-items">
          <h2 id="slip-items" className="mb-3 border-b border-black pb-1 text-sm font-extrabold tracking-wider">DAFTAR PESANAN</h2>
          <table className="w-full table-fixed border-collapse">
            <thead>
              <tr className="border-b border-black text-left">
                <th scope="col" className="w-10 py-1 pr-2 font-bold">No.</th>
                <th scope="col" className="py-1 pr-2 font-bold">Nama Produk</th>
                <th scope="col" className="w-12 py-1 text-right font-bold">Qty</th>
              </tr>
            </thead>
            <tbody>
              {slip.items.map((item) => (
                <tr key={item.no} className="border-b border-gray-400 align-top last:border-0">
                  <td className="py-1.5 pr-2">{item.no}</td>
                  <td className="py-1.5 pr-2 break-words">
                    <span className="font-semibold">{item.productName}</span>
                    {item.toppings.length > 0 ? (
                      <ul className="mt-0.5 space-y-0.5 pl-4 text-xs text-gray-700" aria-label="Topping">
                        {item.toppings.map((topping) => (
                          <li key={topping} className="break-words">+ {topping}</li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                  <td className="py-1.5 text-right font-semibold tabular-nums">{item.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      {/* Shipment: AWB + status left, barcode of the exact AWB right */}
      <section className="avoid-break border-2 border-black p-4" aria-labelledby="slip-shipment">
        <h2 id="slip-shipment" className="mb-3 border-b border-black pb-1 text-sm font-extrabold tracking-wider">PENGIRIMAN</h2>
        <div className="grid grid-cols-1 items-center gap-4 sm:grid-cols-[1fr_auto] print:grid-cols-[1fr_auto]">
          <dl className="grid grid-cols-[auto_auto_1fr] gap-x-2 gap-y-1">
            <MetaRow label="Resi / AWB" value={slip.shipment.awbLabel} strong />
            <MetaRow label="Status" value={slip.shipment.statusLabel} />
          </dl>
          {barcode ? (
            <div className="w-[90mm] max-w-full justify-self-end text-center">
              <Code128Barcode value={barcode} className="h-16 w-full" />
              <p className="mt-1 break-all font-mono text-sm tracking-wider">{barcode}</p>
            </div>
          ) : null}
        </div>
      </section>
    </article>
  );
}

function MetaRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <>
      <dt className="whitespace-nowrap text-gray-700">{label}</dt>
      <dd className="text-gray-700">{label ? ':' : ''}</dd>
      <dd className={`min-w-0 break-words ${strong ? 'font-bold' : ''}`}>{value}</dd>
    </>
  );
}

function SlipSkeleton() {
  return (
    <div className="mx-auto max-w-[210mm] space-y-4 bg-white p-8 shadow-sm" aria-busy="true" aria-label="Memuat packing slip">
      <div className="h-20 animate-pulse rounded bg-gray-100" />
      <div className="grid grid-cols-2 gap-4">
        <div className="h-48 animate-pulse rounded bg-gray-100" />
        <div className="h-48 animate-pulse rounded bg-gray-100" />
      </div>
      <div className="h-28 animate-pulse rounded bg-gray-100" />
    </div>
  );
}

function SlipError({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying: boolean }) {
  const kind = packingSlipErrorKind(error);
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-red-100 bg-white p-6 text-sm shadow-sm" role="alert">
      <h1 className="text-base font-semibold text-gray-900">{PACKING_SLIP_ERROR_MESSAGE[kind]}</h1>
      {kind === 'other' ? (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className="h-4 w-4" /> Coba lagi
        </button>
      ) : null}
    </div>
  );
}
