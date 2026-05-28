import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';

export default function PaymentsPage() {
  return (
    <AdminShell>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Payment Verification</h2>
          <p className="mt-1 text-sm text-gray-500">Manual transfer queue and future gateway webhook reconciliation.</p>
        </div>
        <Button>Verify Selected Payment</Button>
      </div>
      <Card>
        <CardTitle>Manual Transfer Queue</CardTitle>
        <div className="mt-4 space-y-3">
          {['BN-20260528-00001', 'BN-20260528-00004', 'BN-20260528-00009'].map((order) => (
            <div key={order} className="flex items-center justify-between rounded-xl border border-gray-100 p-4">
              <div>
                <p className="font-medium text-gray-800">{order}</p>
                <p className="text-sm text-gray-500">Receipt uploaded, waiting admin review</p>
              </div>
              <Badge tone="brand">Waiting Verification</Badge>
            </div>
          ))}
        </div>
      </Card>
    </AdminShell>
  );
}
