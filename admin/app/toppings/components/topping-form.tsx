'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import {
  AdminTopping,
  TOPPING_NAME_MAX,
  ToppingFormValues,
  ToppingPayload,
  toppingFormValues,
  validateToppingForm,
} from '@/lib/toppings/topping-form';

type ToppingFormProps = {
  initialValues?: Partial<AdminTopping>;
  onSubmit: (payload: ToppingPayload) => Promise<void>;
  /** Passed only when the admin holds the delete permission. */
  onDelete?: () => Promise<void>;
  isSubmitting?: boolean;
  isDeleting?: boolean;
  submitLabel: string;
};

const inputClass =
  'w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white';

export function ToppingForm({ initialValues, onSubmit, onDelete, isSubmitting, isDeleting, submitLabel }: ToppingFormProps) {
  const [values, setValues] = useState<ToppingFormValues>(() => toppingFormValues(initialValues));
  const [errors, setErrors] = useState<Partial<Record<keyof ToppingFormValues, string>>>({});

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = validateToppingForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    await onSubmit(result.payload);
  };

  return (
    <Card>
      <CardTitle>{submitLabel}</CardTitle>
      <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-2 text-sm text-gray-700" htmlFor="topping-name">
            <span>Name</span>
            <input
              id="topping-name"
              value={values.name}
              maxLength={TOPPING_NAME_MAX}
              onChange={(event) => setValues((current) => ({ ...current, name: event.target.value }))}
              className={inputClass}
              aria-invalid={Boolean(errors.name)}
              required
            />
            {errors.name ? <span className="block text-xs text-red-600">{errors.name}</span> : null}
          </label>

          <label className="space-y-2 text-sm text-gray-700" htmlFor="topping-price">
            <span>Price (Rp)</span>
            <input
              id="topping-price"
              inputMode="numeric"
              value={values.price}
              onChange={(event) => setValues((current) => ({ ...current, price: event.target.value }))}
              className={inputClass}
              aria-invalid={Boolean(errors.price)}
              placeholder="5000"
              required
            />
            {errors.price ? (
              <span className="block text-xs text-red-600">{errors.price}</span>
            ) : (
              <span className="block text-xs text-gray-400">A price change applies to new orders only.</span>
            )}
          </label>

          <label className="flex items-center gap-3 text-sm text-gray-700" htmlFor="topping-active">
            <input
              id="topping-active"
              type="checkbox"
              checked={values.isActive}
              onChange={(event) => setValues((current) => ({ ...current, isActive: event.target.checked }))}
              className="size-4 rounded border-gray-300"
            />
            <span>
              Active
              <span className="block text-xs text-gray-400">Only active toppings are offered to customers.</span>
            </span>
          </label>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={isSubmitting}>
            {submitLabel}
          </Button>
          {onDelete ? (
            <Button
              type="button"
              className="bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50"
              disabled={isDeleting}
              onClick={onDelete}
            >
              Delete
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
