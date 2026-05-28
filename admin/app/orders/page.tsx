import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Card, CardTitle } from '@/components/ui/card';

export default function OrdersPage() {
  return (
    <AdminShell>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Order Management</h2>
        <p className="mt-1 text-sm text-gray-500">Track checkout, fulfillment, delivery, and customer support states.</p>
      </div>
      <Card>
        <CardTitle>Recent Orders</CardTitle>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                <th className="py-3 font-medium">Order</th>
                <th className="py-3 font-medium">Customer</th>
                <th className="py-3 font-medium">Status</th>
                <th className="py-3 font-medium">Payment</th>
                <th className="py-3 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['BN-20260528-00001', 'Naufal', 'Processing', 'Waiting Verification', 'Rp 106.000'],
                ['BN-20260528-00002', 'Sular', 'Delivering', 'Paid', 'Rp 125.000'],
              ].map((row) => (
                <tr key={row[0]} className="border-b border-gray-50 last:border-0">
                  <td className="py-4 font-medium text-gray-800">{row[0]}</td>
                  <td className="py-4 text-gray-500">{row[1]}</td>
                  <td className="py-4">
                    <Badge tone="brand">{row[2]}</Badge>
                  </td>
                  <td className="py-4 text-gray-500">{row[3]}</td>
                  <td className="py-4 text-right font-semibold text-gray-900">{row[4]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </AdminShell>
  );
}
