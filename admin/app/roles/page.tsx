import { AdminShell } from '@/components/layout/admin-shell';
import { Card, CardTitle } from '@/components/ui/card';

export default function RolesPage() {
  return (
    <AdminShell>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Role & Permission Management</h2>
        <p className="mt-1 text-sm text-gray-500">RBAC matrix for admin, manager, staff, and customer capabilities.</p>
      </div>
      <Card>
        <CardTitle>Permission Matrix</CardTitle>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          {['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF'].map((role) => (
            <div key={role} className="rounded-xl bg-gray-50 p-4 text-sm font-medium text-gray-700">{role}</div>
          ))}
        </div>
      </Card>
    </AdminShell>
  );
}
