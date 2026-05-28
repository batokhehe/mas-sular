import { AdminShell } from '@/components/layout/admin-shell';
import { Card, CardTitle } from '@/components/ui/card';

export default function UsersPage() {
  return (
    <AdminShell>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">User Management</h2>
        <p className="mt-1 text-sm text-gray-500">Customers, admins, addresses, and role assignments.</p>
      </div>
      <Card>
        <CardTitle>Users</CardTitle>
        <div className="mt-4 rounded-xl border border-gray-100 p-4 text-sm text-gray-500">Google-authenticated customer and admin accounts will appear here.</div>
      </Card>
    </AdminShell>
  );
}
