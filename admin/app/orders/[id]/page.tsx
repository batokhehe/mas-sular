'use client';

import { ButtonHTMLAttributes, ReactNode, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import {
  ShoppingCart, CreditCard, UploadCloud, CheckCircle2, Boxes, Truck, PackageCheck, XCircle, Circle,
  MapPin, Phone, Mail, ExternalLink, Download, RefreshCw, Printer, MessageSquare, Trash2, Pencil, ClipboardList,
} from 'lucide-react';
import { PermissionGate } from '@/components/auth/permission-gate';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import {
  fetchAdminOrder, fetchOrderOperations, fetchOrderNotes, createOrderNote, updateOrderNote, deleteOrderNote,
  updateAdminOrderStatus, retryShipment, verifyAdminPayment, rejectAdminPayment,
} from '@/lib/admin';
import { formatAdminAddressLine } from '@/lib/format-address';
import { ShipmentTimeline } from '@/app/orders/components/shipment-timeline';
import { useAdminProfile } from '@/lib/auth';
import { formatRupiah } from '@/lib/utils/number';
import {
  ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, confirmApprove, confirmReject, runWithFeedback,
} from '@/lib/admin-alert';

const rp = formatRupiah;
const dt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export default function OrderDetailPage() {
  const params = useParams();
  const orderId = typeof params?.id === 'string' ? params.id : undefined;
  const qc = useQueryClient();
  const profile = useAdminProfile();
  const adminId = profile.data?.id;

  const orderQ = useQuery({
    queryKey: ['admin-order', orderId],
    queryFn: () => (orderId ? fetchAdminOrder(orderId) : Promise.reject(new Error('Missing order ID'))),
    enabled: Boolean(orderId),
    retry: false,
  });
  const opsQ = useQuery({
    queryKey: ['admin-order-ops', orderId],
    queryFn: () => fetchOrderOperations(orderId as string),
    enabled: Boolean(orderId),
    retry: false,
  });
  const notesQ = useQuery({
    queryKey: ['admin-order-notes', orderId],
    queryFn: () => fetchOrderNotes(orderId as string),
    enabled: Boolean(orderId),
    retry: false,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-order', orderId] });
    qc.invalidateQueries({ queryKey: ['admin-order-ops', orderId] });
    qc.invalidateQueries({ queryKey: ['admin-orders'] });
  };
  const verifyM = useMutation({ mutationFn: (pid: string) => verifyAdminPayment(pid), onSuccess: refresh });
  const rejectM = useMutation({ mutationFn: (pid: string) => rejectAdminPayment(pid), onSuccess: refresh });
  const retryM = useMutation({ mutationFn: () => retryShipment(orderId as string), onSuccess: refresh });
  const cancelM = useMutation({ mutationFn: () => updateAdminOrderStatus(orderId as string, 'CANCELLED'), onSuccess: refresh });

  // ----- internal notes -----
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const refreshNotes = () => qc.invalidateQueries({ queryKey: ['admin-order-notes', orderId] });
  const addNoteM = useMutation({ mutationFn: (body: string) => createOrderNote(orderId as string, body), onSuccess: () => { setDraft(''); refreshNotes(); } });
  const editNoteM = useMutation({ mutationFn: (v: { id: string; body: string }) => updateOrderNote(orderId as string, v.id, v.body), onSuccess: () => { setEditing(null); refreshNotes(); } });
  const delNoteM = useMutation({ mutationFn: (noteId: string) => deleteOrderNote(orderId as string, noteId), onSuccess: refreshNotes });

  if (orderQ.isLoading) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.orders}>
        <OrderSkeleton />
      </AdminShell>
    );
  }
  if (orderQ.isError || !orderQ.data) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.orders}>
        <Card><p className="p-6 text-sm text-red-600">Unable to load order details. Please try again later.</p></Card>
      </AdminShell>
    );
  }

  const order = orderQ.data;
  const ops = opsQ.data;
  const actions = ops?.availableActions;
  const payment = order.payment;
  // Latest gateway attempt, if this order was paid through a provider.
  const gateway = payment?.gatewayTransactions?.[0] ?? null;
  const businessTotal = order.totalPrice;
  const uniqueCode = payment?.uniqueCode ?? null;
  const transferAmount = payment?.amount ?? businessTotal;
  const mapsQuery = order.address ? encodeURIComponent(`${order.address.recipientName} ${formatAdminAddressLine(order.address)}`) : '';

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.orders}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Order {order.orderNumber}</h2>
          <p className="mt-1 text-sm text-gray-500">Placed {dt(order.createdAt)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={order.status === 'CANCELLED' ? 'danger' : order.status === 'DELIVERED' ? 'success' : 'brand'}>{order.status}</Badge>
          <Badge tone={payment?.status === 'PAID' ? 'success' : payment?.status === 'FAILED' ? 'danger' : 'brand'}>Payment: {payment?.status ?? '—'}</Badge>
          {order.shipment ? <Badge tone={order.shipment.status === 'FAILED' ? 'danger' : order.shipment.status === 'DELIVERED' ? 'success' : 'brand'}>Ship: {order.shipment.status}</Badge> : null}
        </div>
      </div>

      {/* SECTION 9 — Quick Actions (only valid ones) */}
      <Card className="mb-5">
        <CardTitle>Quick Actions</CardTitle>
        <div className="mt-4 flex flex-wrap gap-2">
          {actions?.verifyPayment && payment ? (
            <PermissionGate permissions={ROUTE_PERMISSIONS.paymentVerify}>
              <Button onClick={() => runWithFeedback({ confirm: () => confirmApprove({ title: 'Verify Payment?', text: 'Marks the payment PAID and moves the order to PROCESSING.' }), loading: ADMIN_LOADING_MESSAGES.verify, success: ADMIN_SUCCESS_MESSAGES.paymentVerified, action: () => verifyM.mutateAsync(payment.id) })} disabled={verifyM.isPending}>Verify Payment</Button>
            </PermissionGate>
          ) : null}
          {actions?.rejectPayment && payment ? (
            <PermissionGate permissions={ROUTE_PERMISSIONS.paymentReject}>
              <ActionButton onClick={() => runWithFeedback({ confirm: () => confirmReject({ title: 'Reject Payment?', text: 'Rejects the payment and restores inventory.' }), loading: ADMIN_LOADING_MESSAGES.reject, success: ADMIN_SUCCESS_MESSAGES.paymentRejected, action: () => rejectM.mutateAsync(payment.id) })} disabled={rejectM.isPending}>Reject Payment</ActionButton>
            </PermissionGate>
          ) : null}
          {actions?.retryShipment ? (
            <PermissionGate permissions={ROUTE_PERMISSIONS.shipmentCreate}>
              <ActionButton icon={RefreshCw} onClick={() => runWithFeedback({ loading: 'Creating shipment...', success: 'Shipment retry completed', action: () => retryM.mutateAsync() })} disabled={retryM.isPending}>Retry Shipment</ActionButton>
            </PermissionGate>
          ) : null}
          {actions?.cancelOrder ? (
            <PermissionGate permissions={ROUTE_PERMISSIONS.orderUpdate}>
              <ActionButton icon={XCircle} onClick={() => runWithFeedback({ confirm: () => confirmReject({ title: 'Cancel Order?', text: 'Cancels the order and restores reserved inventory.' }), loading: ADMIN_LOADING_MESSAGES.statusUpdate, success: ADMIN_SUCCESS_MESSAGES.orderStatusUpdated, action: () => cancelM.mutateAsync() })} disabled={cancelM.isPending}>Cancel Order</ActionButton>
          </PermissionGate>
          ) : null}
          {actions?.downloadReceipt && payment?.manualReceiptUrl ? (
            <a href={payment.manualReceiptUrl} target="_blank" rel="noreferrer"><ActionButton icon={Download}>Download Receipt</ActionButton></a>
          ) : null}
          {actions?.openTracking && order.shipment?.trackingUrl ? (
            <a href={order.shipment.trackingUrl} target="_blank" rel="noreferrer"><ActionButton icon={ExternalLink}>Open Tracking</ActionButton></a>
          ) : null}
          <ActionButton icon={Printer} onClick={() => window.print()}>Print Invoice</ActionButton>
          <ActionButton icon={Printer} onClick={() => window.print()}>Print Packing Slip</ActionButton>
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-[1.35fr_0.65fr]">
        <div className="space-y-5">
          {/* SECTION 1 — Order Summary */}
          <Section title="Order Summary" icon={ClipboardList}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Order Number" value={order.orderNumber} />
              <Field label="Order Status" value={order.status} />
              <Field label="Payment Status" value={payment?.status ?? '—'} />
              <Field label="Shipment Status" value={order.shipment?.status ?? '—'} />
              <Field label="Customer" value={order.user?.name ?? 'Guest'} />
              <Field label="Created At" value={dt(order.createdAt)} />
              <Field label="Business Total" value={rp(businessTotal)} />
              <Field label="Transfer Amount" value={rp(transferAmount)} strong />
              <Field label="Unique Code" value={uniqueCode != null ? String(uniqueCode) : '—'} />
              <Field label="Payment Method" value={payment?.method ?? order.paymentMethod} />
              <Field label="Voucher" value={order.voucherCode ?? '—'} />
              <Field label="Discount" value={rp(order.voucherDiscountAmount ?? 0)} />
              <Field label="Shipping" value={rp(order.shippingCost ?? order.deliveryFee ?? 0)} />
              <Field label="Outlet" value={order.reservations?.[0]?.outlet?.name ?? order.outletId ?? '—'} />
            </div>
          </Section>

          {/* SECTION 3 — Ordered Items */}
          <Section title="Ordered Items" icon={ShoppingCart}>
            <div className="space-y-3">
              {order.items.map((item) => {
                const reservation = order.reservations?.find((r) => r.product?.id === item.productId);
                return (
                  <div key={item.id} className="flex gap-3 rounded-xl border border-gray-100 p-3">
                    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-gray-100">
                      {item.product?.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.product.imageUrl} alt={item.productName} className="h-full w-full object-cover" />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-gray-900">{item.productName}</p>
                      <p className="text-xs text-gray-400">SKU {item.product?.sku ?? '—'}</p>
                      <p className="mt-1 text-sm text-gray-500">Qty {item.quantity} × {rp(item.unitPrice)}</p>
                      {item.toppings.length > 0 ? <p className="text-xs text-gray-500">Toppings: {item.toppings.map((t) => t.name).join(', ')}</p> : null}
                      {reservation ? (
                        <p className="mt-1 text-xs text-indigo-600">Reserved {reservation.reservedQty} @ {reservation.outlet?.name ?? 'outlet'} ({reservation.status})</p>
                      ) : null}
                    </div>
                    <p className="text-sm font-semibold text-gray-900">{rp(item.unitPrice * item.quantity)}</p>
                  </div>
                );
              })}
            </div>
          </Section>

          {/* SECTION 4 — Payment */}
          <Section title="Payment" icon={CreditCard}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Payment Status" value={payment?.status ?? '—'} />
              <Field label="Transfer Amount" value={rp(transferAmount)} strong />
              <Field label="Business Total" value={rp(businessTotal)} />
              <Field label="Unique Code" value={uniqueCode != null ? String(uniqueCode) : '—'} />
              <Field label="Payment Account" value={ops?.paymentAccount ? `${ops.paymentAccount.bankName} · ${ops.paymentAccount.accountNumber}` : '—'} />
              <Field label="Transfer Date" value={dt(payment?.transactions?.find((t) => t.status === 'WAITING_VERIFICATION')?.createdAt)} />
              <Field label="Verified At" value={dt(payment?.verifiedAt)} />
              <Field label="Verified By" value={payment?.verifiedByUserId ?? auditActor(ops, 'payment.verified') ?? '—'} />
            </div>

            {/* Phase 4 — gateway attempt (READ-ONLY: no retry, no resend, no webhook). */}
            {gateway ? (
              <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
                <p className="mb-3 text-xs uppercase text-gray-400">Payment Gateway</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Payment Method" value={order.paymentMethod ?? "—"} />
                  <Field label="Payment Channel" value={gateway.channelCode} />
                  <Field label="Gateway Provider" value={gateway.provider} />
                  <Field label="Provider Status" value={gateway.status} />
                  <Field label="Gateway Transaction ID" value={gateway.providerTransactionId ?? gateway.providerReference ?? '—'} />
                  <Field label="Expires At" value={dt(gateway.expiryAt)} />
                  {gateway.vaNumber ? <Field label="Virtual Account" value={gateway.vaNumber} /> : null}
                  {gateway.failureReason ? <Field label="Failure Reason" value={gateway.failureReason} /> : null}
                </div>
              </div>
            ) : null}
            {payment?.manualReceiptUrl ? (
              <div className="mt-4">
                <p className="mb-2 text-xs uppercase text-gray-400">Receipt</p>
                <div className="flex items-center gap-3">
                  <a href={payment.manualReceiptUrl} target="_blank" rel="noreferrer" className="block h-24 w-24 overflow-hidden rounded-lg border border-gray-200">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={payment.manualReceiptUrl} alt="Receipt" className="h-full w-full object-cover" />
                  </a>
                  <div className="flex flex-col gap-2">
                    <a href={payment.manualReceiptUrl} target="_blank" rel="noreferrer"><ActionButton icon={ExternalLink}>Preview</ActionButton></a>
                    <a href={payment.manualReceiptUrl} download><ActionButton icon={Download}>Download</ActionButton></a>
                  </div>
                </div>
              </div>
            ) : null}
          </Section>

          {/* SECTION 5 — Shipment */}
          {order.shipment ? (
            <Section title="Shipment" icon={Truck}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Courier" value={order.shipment.provider} />
                <Field label="Service" value={order.shippingServiceName ?? order.shipment.service} />
                <Field label="Tracking Number" value={order.shipment.trackingNumber ?? 'Not assigned'} />
                <Field label="Shipment Status" value={order.shipment.status} />
              </div>
              <div className="mt-3">
                <ShipmentTimeline currentStatus={order.shipment.status} history={order.shipment.history} />
              </div>
            </Section>
          ) : null}

          {/* SECTION 6 — Unified Timeline */}
          <Section title="Timeline" icon={Circle}>
            {opsQ.isLoading ? (
              <p className="text-sm text-gray-500">Loading timeline…</p>
            ) : !ops || ops.timeline.length === 0 ? (
              <p className="text-sm text-gray-500">No timeline events yet.</p>
            ) : (
              <ol className="relative space-y-4 border-l border-gray-200 pl-6">
                {ops.timeline.map((e, i) => (
                  <li key={`${e.type}-${i}`} className="relative">
                    <span className="absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full bg-white ring-1 ring-gray-200">
                      <TimelineIcon type={e.type} />
                    </span>
                    <p className="text-sm font-medium text-gray-900">{e.title}</p>
                    <p className="text-sm text-gray-500">{e.description}</p>
                    <p className="mt-0.5 text-xs text-gray-400">{dt(e.at)} · {e.actor}</p>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>

        <div className="space-y-5">
          {/* SECTION 2 — Customer Information */}
          <Section title="Customer" icon={Phone}>
            <div className="space-y-2 text-sm">
              <p className="font-medium text-gray-900">{order.user?.name ?? 'Guest'}</p>
              <p className="flex items-center gap-2 text-gray-500"><Phone className="h-3.5 w-3.5" /> {order.address?.phone ?? order.user?.phone ?? '—'}</p>
              <p className="flex items-center gap-2 text-gray-500"><Mail className="h-3.5 w-3.5" /> {order.user?.email ?? '—'}</p>
              {order.address ? (
                <div className="rounded-xl bg-gray-50 p-3">
                  <p className="font-medium text-gray-800">{order.address.recipientName}</p>
                  <p className="text-gray-500">{formatAdminAddressLine(order.address)}</p>
                  <p className="text-gray-500">Postal: {order.address.postalCode ?? '—'}</p>
                  {mapsQuery ? (
                    <a href={`https://www.google.com/maps/search/?api=1&query=${mapsQuery}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-[#465fff]">
                      <MapPin className="h-3.5 w-3.5" /> Open in Google Maps
                    </a>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-gray-100 p-3">
                  <p className="text-xs text-gray-400">Total Orders</p>
                  <p className="text-lg font-semibold text-gray-900">{ops?.customerHistory.totalOrders ?? '—'}</p>
                </div>
                <div className="rounded-xl border border-gray-100 p-3">
                  <p className="text-xs text-gray-400">Lifetime Revenue</p>
                  <p className="text-lg font-semibold text-gray-900">{ops ? rp(ops.customerHistory.lifetimeRevenue) : '—'}</p>
                </div>
              </div>
            </div>
          </Section>

          {/* SECTION 10 — Internal Notes */}
          <Section title="Internal Notes" icon={MessageSquare}>
            <PermissionGate permissions={ROUTE_PERMISSIONS.orderUpdate} fallback={<p className="text-sm text-gray-500">View only.</p>}>
              <div className="mb-3">
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder="Add an internal note (visible to admins only)…" className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#465fff]" />
                <Button className="mt-2" disabled={!draft.trim() || addNoteM.isPending} onClick={() => addNoteM.mutate(draft.trim())}>Add Note</Button>
              </div>
            </PermissionGate>
            <div className="space-y-2">
              {notesQ.data && notesQ.data.length > 0 ? notesQ.data.map((n) => (
                <div key={n.id} className="rounded-xl border border-gray-100 p-3 text-sm">
                  {editing?.id === n.id ? (
                    <div>
                      <textarea value={editing.body} onChange={(e) => setEditing({ id: n.id, body: e.target.value })} rows={2} className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm" />
                      <div className="mt-2 flex gap-2">
                        <Button className="h-8" disabled={editNoteM.isPending} onClick={() => editNoteM.mutate({ id: n.id, body: editing.body.trim() })}>Save</Button>
                        <button className="text-xs text-gray-500" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="whitespace-pre-wrap text-gray-700">{n.body}</p>
                      <div className="mt-2 flex items-center justify-between">
                        <p className="text-xs text-gray-400">{n.adminName} · {dt(n.createdAt)}</p>
                        {n.adminId === adminId ? (
                          <span className="flex gap-2">
                            <button className="text-gray-400 hover:text-gray-700" onClick={() => setEditing({ id: n.id, body: n.body })}><Pencil className="h-3.5 w-3.5" /></button>
                            <button className="text-gray-400 hover:text-red-600" onClick={() => runWithFeedback({ confirm: () => confirmReject({ title: 'Delete note?', text: 'This cannot be undone.' }), loading: 'Deleting…', success: 'Note deleted', action: () => delNoteM.mutateAsync(n.id) })}><Trash2 className="h-3.5 w-3.5" /></button>
                          </span>
                        ) : null}
                      </div>
                    </>
                  )}
                </div>
              )) : <p className="text-sm text-gray-500">No internal notes yet.</p>}
            </div>
          </Section>

          {/* SECTION 7 — Activity Log */}
          <Section title="Activity Log" icon={ClipboardList} defaultOpen={false}>
            {opsQ.isLoading ? <p className="text-sm text-gray-500">Loading…</p> : !ops || ops.auditLogs.length === 0 ? (
              <p className="text-sm text-gray-500">No audit records.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {ops.auditLogs.map((a) => (
                  <li key={a.id} className="rounded-lg bg-gray-50 p-2.5">
                    <p className="font-medium text-gray-800">{a.action}</p>
                    <p className="text-xs text-gray-400">{a.entity} · {a.ipAddress ?? 'system'} · {dt(a.createdAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* SECTION 8 — Notification History */}
          <Section title="Notification History" icon={Mail} defaultOpen={false}>
            {opsQ.isLoading ? <p className="text-sm text-gray-500">Loading…</p> : !ops || ops.notifications.length === 0 ? (
              <p className="text-sm text-gray-500">No notifications sent.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {ops.notifications.map((n) => (
                  <li key={n.id} className="flex items-center justify-between rounded-lg bg-gray-50 p-2.5">
                    <div>
                      <p className="font-medium text-gray-800">{n.channel} · {n.template}</p>
                      <p className="text-xs text-gray-400">{n.sentAt ? `Sent ${dt(n.sentAt)}` : `Created ${dt(n.createdAt)}`} · retries {n.attempts}</p>
                    </div>
                    <Badge tone={n.status === 'SENT' ? 'success' : n.status === 'FAILED' ? 'danger' : 'brand'}>{n.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </AdminShell>
  );
}

/* ---------------- helpers ---------------- */

function auditActor(ops: { auditLogs: Array<{ action: string; after?: unknown }> } | undefined, action: string): string | null {
  const row = ops?.auditLogs.find((a) => a.action === action);
  const after = row?.after as { verifiedByAdminId?: string } | undefined;
  return after?.verifiedByAdminId ?? null;
}

function Section({ title, icon: Icon, children, defaultOpen = true }: { title: string; icon: typeof Mail; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <Card>
      <details open={defaultOpen} className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between">
          <span className="flex items-center gap-2"><Icon className="h-4 w-4 text-gray-400" /><CardTitle>{title}</CardTitle></span>
          <span className="text-gray-300 transition group-open:rotate-180">▾</span>
        </summary>
        <div className="mt-4">{children}</div>
      </details>
    </Card>
  );
}

function Field({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-xs uppercase text-gray-400">{label}</p>
      <p className={`mt-1 ${strong ? 'text-base font-semibold text-gray-900' : 'text-sm font-medium text-gray-800'}`}>{value}</p>
    </div>
  );
}

function ActionButton({ children, icon: Icon, ...props }: { children: ReactNode; icon?: typeof Mail } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} className="inline-flex h-10 items-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-gray-700 ring-1 ring-gray-200 transition hover:bg-gray-50 disabled:opacity-50">
      {Icon ? <Icon className="h-4 w-4" /> : null}
      {children}
    </button>
  );
}

function TimelineIcon({ type }: { type: string }) {
  const cls = 'h-3.5 w-3.5';
  if (type.startsWith('order.created')) return <ShoppingCart className={`${cls} text-indigo-500`} />;
  if (type === 'payment.uploaded') return <UploadCloud className={`${cls} text-blue-500`} />;
  if (type === 'payment.verified') return <CheckCircle2 className={`${cls} text-emerald-500`} />;
  if (type.startsWith('payment')) return <CreditCard className={`${cls} text-blue-500`} />;
  if (type.startsWith('inventory')) return <Boxes className={`${cls} text-amber-500`} />;
  if (type === 'shipment.delivered') return <PackageCheck className={`${cls} text-emerald-500`} />;
  if (type.startsWith('shipment')) return <Truck className={`${cls} text-indigo-500`} />;
  if (type === 'order.cancelled') return <XCircle className={`${cls} text-red-500`} />;
  return <Circle className={`${cls} text-gray-400`} />;
}

function OrderSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-48 animate-pulse rounded bg-gray-200" />
      <div className="grid gap-5 xl:grid-cols-[1.35fr_0.65fr]">
        <Card className="h-64 animate-pulse"><div className="h-full w-full rounded bg-gray-100" /></Card>
        <Card className="h-64 animate-pulse"><div className="h-full w-full rounded bg-gray-100" /></Card>
      </div>
    </div>
  );
}
