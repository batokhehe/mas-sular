'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { ToppingForm } from '@/app/toppings/components/topping-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { createAdminTopping } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, runWithFeedback } from '@/lib/admin-alert';
import type { ToppingPayload } from '@/lib/toppings/topping-form';

export default function NewToppingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const createTopping = useMutation({
    mutationFn: (input: ToppingPayload) => createAdminTopping(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-toppings'] });
      router.push('/toppings');
    },
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.toppingCreate}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Add Topping</h2>
        <p className="mt-1 text-sm text-gray-500">Create an optional extra customers can add to a product.</p>
      </div>
      <ToppingForm
        onSubmit={async (payload) => {
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.create,
            success: ADMIN_SUCCESS_MESSAGES.created('Topping'),
            action: () => createTopping.mutateAsync(payload),
          });
        }}
        submitLabel={createTopping.isPending ? 'Creating...' : 'Create Topping'}
        isSubmitting={createTopping.isPending}
      />
    </AdminShell>
  );
}
