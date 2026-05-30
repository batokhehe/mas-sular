'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { AdminRole } from '@/lib/admin';

export type RoleFormValues = {
  name: string;
  description?: string;
  permissionIds: string[];
};

interface RoleFormProps {
  permissions: Array<{ id: string; action: string; subject: string }>;
  initialValues?: Partial<AdminRole>;
  onSubmit: (values: RoleFormValues) => Promise<void>;
  submitLabel: string;
  isSubmitting?: boolean;
}

export function RoleForm({
  permissions,
  initialValues,
  onSubmit,
  submitLabel,
  isSubmitting,
}: RoleFormProps) {
  const [name, setName] = useState(initialValues?.name ?? '');
  const [description, setDescription] = useState(initialValues?.description ?? '');
  const [permissionIds, setPermissionIds] = useState<string[]>(
    initialValues?.permissions?.map((assignment) => assignment.permission.id) ?? [],
  );

  const togglePermission = (permissionId: string) => {
    setPermissionIds((current) =>
      current.includes(permissionId)
        ? current.filter((id) => id !== permissionId)
        : [...current, permissionId],
    );
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit({ name, description, permissionIds });
  };

  return (
    <Card>
      <CardTitle>{submitLabel}</CardTitle>
      <form onSubmit={handleSubmit} className="mt-4 space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-2 text-sm text-gray-700">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700 col-span-full">
            <span>Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>
        </div>

        <div className="space-y-3">
          <p className="text-xs uppercase tracking-wide text-gray-500">Permissions</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {permissions.map((permission) => (
              <label
                key={permission.id}
                className="inline-flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700"
              >
                <input
                  type="checkbox"
                  checked={permissionIds.includes(permission.id)}
                  onChange={() => togglePermission(permission.id)}
                  className="h-4 w-4 rounded border-gray-300 text-[#465fff] focus:ring-[#465fff]"
                />
                <span>{permission.subject}:{permission.action}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={isSubmitting}>{submitLabel}</Button>
        </div>
      </form>
    </Card>
  );
}
