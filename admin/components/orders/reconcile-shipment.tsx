'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, ClipboardCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { reconcileShipment } from '@/lib/admin';
import { confirmApprove, confirmReject, runWithFeedback } from '@/lib/admin-alert';
import { buildReconcilePayload, capturedAwb, EMPTY_RECONCILE_FORM, RECONCILE_GUIDANCE } from '@/lib/shipments/reconcile';
import type { ReconcileForm, ReconcilableShipment } from '@/lib/shipments/reconcile';

/**
 * Admin Order Detail: resolve an UNKNOWN shipment (courier booking outcome unknown).
 *
 * Calls ONLY the dedicated reconcile endpoint, which never calls the courier and
 * enforces the evidence rules server-side. There is deliberately no Retry and no
 * status edit for such a shipment: either could book the order a second time.
 */
export function ReconcileShipmentAction({
  orderId,
  shipment,
  onDone,
}: {
  orderId: string;
  shipment: ReconcilableShipment;
  onDone: () => void;
}) {
  const captured = capturedAwb(shipment.metadata);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ReconcileForm>(EMPTY_RECONCILE_FORM);
  const [errors, setErrors] = useState<string[]>([]);
  const reconcileM = useMutation({
    mutationFn: (input: Parameters<typeof reconcileShipment>[1]) => reconcileShipment(orderId, input),
    onSuccess: () => {
      setOpen(false);
      setForm(EMPTY_RECONCILE_FORM);
      onDone();
    },
  });
  const set = <K extends keyof ReconcileForm>(key: K, value: ReconcileForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = () => {
    const built = buildReconcilePayload(form, captured);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors([]);
    const payload = built.payload;
    void runWithFeedback({
      confirm: () =>
        payload.outcome === 'booked'
          ? confirmApprove({ title: 'Catat AWB dari kurir?', text: `AWB ${payload.trackingNumber} dicatat dan pesanan berstatus Dikirim.` })
          : confirmReject({
              title: 'Tandai tidak ada booking?',
              text: 'Pengiriman akan bisa dicoba ulang dan sistem akan membuat booking BARU ke kurir. Lanjutkan hanya jika kurir sudah mengonfirmasi tidak ada booking aktif.',
            }),
      loading: 'Menyimpan rekonsiliasi...',
      success: 'Rekonsiliasi pengiriman tersimpan',
      action: () => reconcileM.mutateAsync(payload),
    });
  };

  return (
    <div className="w-full rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900" data-testid="reconcile-shipment">
      <p className="flex items-center gap-1.5 font-semibold">
        <AlertTriangle className="h-4 w-4" /> {RECONCILE_GUIDANCE.title}
      </p>
      <p className="mt-1">{RECONCILE_GUIDANCE.intro}</p>
      {captured ? <p className="mt-1 font-medium">{RECONCILE_GUIDANCE.cancelFirst(captured.trackingNumber)}</p> : null}

      {!open ? (
        <Button type="button" className="mt-2" onClick={() => setOpen(true)}>
          <ClipboardCheck className="mr-1.5 h-4 w-4" /> Rekonsiliasi Pengiriman
        </Button>
      ) : (
        <div className="mt-3 space-y-3">
          <fieldset className="space-y-1">
            <legend className="font-medium">Hasil pengecekan ke kurir</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="reconcile-outcome" checked={form.outcome === 'booked'} onChange={() => set('outcome', 'booked')} />
              <span><b>Kurir punya booking</b> - {RECONCILE_GUIDANCE.booked}</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="reconcile-outcome" checked={form.outcome === 'not_booked'} onChange={() => set('outcome', 'not_booked')} />
              <span><b>Tidak ada booking</b> - {RECONCILE_GUIDANCE.notBooked}</span>
            </label>
          </fieldset>

          {form.outcome === 'booked' ? (
            <div className="space-y-2">
              <label className="block">
                AWB dari kurir
                <input
                  className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-sm"
                  value={form.trackingNumber}
                  placeholder={captured?.trackingNumber ?? 'mis. 0291492600000777'}
                  onChange={(e) => set('trackingNumber', e.target.value)}
                />
              </label>
              {captured ? (
                <Button type="button" className="bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50" onClick={() => set('trackingNumber', captured.trackingNumber)}>Gunakan AWB {captured.trackingNumber}</Button>
              ) : null}
            </div>
          ) : null}

          {form.outcome === 'not_booked' ? (
            <div className="space-y-2">
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={form.confirmNoActiveBooking} onChange={(e) => set('confirmNoActiveBooking', e.target.checked)} />
                <span>Kurir sudah mengonfirmasi <b>tidak ada booking aktif</b> untuk pesanan ini.</span>
              </label>
              <label className="block">
                Referensi konfirmasi kurir (nomor tiket CS / ID kasus / referensi portal)
                <input
                  className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-sm"
                  value={form.courierCheckReference}
                  maxLength={200}
                  onChange={(e) => set('courierCheckReference', e.target.value)}
                />
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={form.cancelledAtCourier} onChange={(e) => set('cancelledAtCourier', e.target.checked)} />
                <span>
                  {captured
                    ? <>AWB <b>{captured.trackingNumber}</b> sudah <b>dibatalkan ke kurir</b> (wajib).</>
                    : <>Booking yang pernah diterima kurir untuk pesanan ini sudah <b>dibatalkan ke kurir</b>.</>}
                </span>
              </label>
              {!captured ? <p className="text-amber-800">{RECONCILE_GUIDANCE.serverMayRequireCancel}</p> : null}
            </div>
          ) : null}

          {form.outcome ? (
            <label className="block">
              Catatan (opsional)
              <textarea
                className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-sm"
                rows={2}
                maxLength={500}
                value={form.note}
                onChange={(e) => set('note', e.target.value)}
              />
            </label>
          ) : null}

          {errors.length ? (
            <ul className="list-disc space-y-0.5 pl-5 text-red-700" role="alert">
              {errors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          ) : null}

          <div className="flex gap-2">
            <Button type="button" onClick={submit} disabled={reconcileM.isPending}>Simpan Rekonsiliasi</Button>
            <Button type="button" className="bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50" onClick={() => { setOpen(false); setErrors([]); }}>Batal</Button>
          </div>
        </div>
      )}
    </div>
  );
}
