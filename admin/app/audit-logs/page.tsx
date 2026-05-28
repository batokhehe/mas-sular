import { AdminShell } from '@/components/layout/admin-shell';
import { Card, CardTitle } from '@/components/ui/card';

export default function AuditLogsPage() {
  return (
    <AdminShell>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Audit Logs</h2>
        <p className="mt-1 text-sm text-gray-500">Immutable operational trail for admin changes and payment verification.</p>
      </div>
      <Card>
        <CardTitle>Latest Activity</CardTitle>
        <div className="mt-4 space-y-3">
          {['Payment verified', 'Product stock updated', 'Banner published'].map((event) => (
            <div key={event} className="rounded-xl border border-gray-100 p-4 text-sm text-gray-600">{event}</div>
          ))}
        </div>
      </Card>
    </AdminShell>
  );
}
