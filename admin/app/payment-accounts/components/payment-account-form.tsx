'use client';

import { useState } from 'react';
import { AdminPaymentAccount } from '@/lib/admin';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';

export type PaymentAccountFormValues = {
  bankName: string;
  bankCode?: string;
  accountName: string;
  accountNumber: string;
  logoUrl?: string;
  notes?: string;
  isVisible: boolean;
  displayOrder: number;
};

type Props = {
  initialValues?: Partial<AdminPaymentAccount>;
  onSubmit: (values: PaymentAccountFormValues) => Promise<void>;
  onDelete?: () => Promise<void>;
  isSubmitting?: boolean;
  isDeleting?: boolean;
  submitLabel: string;
};

function toNumber(value: string) {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

const inputClass =
  'w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white';

export function PaymentAccountForm({ initialValues, onSubmit, onDelete, isSubmitting, isDeleting, submitLabel }: Props) {
  const [values, setValues] = useState<PaymentAccountFormValues>({
    bankName: initialValues?.bankName ?? '',
    bankCode: initialValues?.bankCode ?? '',
    accountName: initialValues?.accountName ?? '',
    accountNumber: initialValues?.accountNumber ?? '',
    logoUrl: initialValues?.logoUrl ?? '',
    notes: initialValues?.notes ?? '',
    isVisible: initialValues?.isVisible ?? true,
    displayOrder: initialValues?.displayOrder ?? 0,
  });

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit({
      ...values,
      bankCode: values.bankCode?.trim() || undefined,
      logoUrl: values.logoUrl?.trim() || undefined,
      notes: values.notes?.trim() || undefined,
    });
  };

  return (
    <Card>
      <CardTitle>{submitLabel}</CardTitle>
      <form onSubmit={handleSubmit} className="mt-4 space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-2 text-sm text-gray-700">
            <span>Bank Name</span>
            <input value={values.bankName} onChange={(e) => setValues((c) => ({ ...c, bankName: e.target.value }))} className={inputClass} required />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Bank Code</span>
            <input value={values.bankCode ?? ''} onChange={(e) => setValues((c) => ({ ...c, bankCode: e.target.value }))} className={inputClass} placeholder="e.g. 014" />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Account Name</span>
            <input value={values.accountName} onChange={(e) => setValues((c) => ({ ...c, accountName: e.target.value }))} className={inputClass} required />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Account Number</span>
            <input value={values.accountNumber} onChange={(e) => setValues((c) => ({ ...c, accountNumber: e.target.value }))} className={inputClass} required />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Logo URL</span>
            <input value={values.logoUrl ?? ''} onChange={(e) => setValues((c) => ({ ...c, logoUrl: e.target.value }))} className={inputClass} />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Display Order</span>
            <input type="number" min={0} value={values.displayOrder} onChange={(e) => setValues((c) => ({ ...c, displayOrder: toNumber(e.target.value) }))} className={inputClass} required />
          </label>
          <label className="space-y-2 text-sm text-gray-700 lg:col-span-2">
            <span>Notes</span>
            <input value={values.notes ?? ''} onChange={(e) => setValues((c) => ({ ...c, notes: e.target.value }))} className={inputClass} />
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={values.isVisible} onChange={(e) => setValues((c) => ({ ...c, isVisible: e.target.checked }))} className="h-4 w-4 rounded border-gray-300 text-[#465fff] focus:ring-[#465fff]" />
            <span>Visible</span>
          </label>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={isSubmitting}>
            {submitLabel}
          </Button>
          {onDelete ? (
            <Button type="button" className="bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50" disabled={isDeleting} onClick={onDelete}>
              Delete
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
