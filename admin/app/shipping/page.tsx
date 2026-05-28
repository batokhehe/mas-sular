import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Card, CardTitle } from '@/components/ui/card';

export default function ShippingPage() {
  return (
    <AdminShell>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Shipping Management</h2>
        <p className="mt-1 text-sm text-gray-500">Provider rates, Paxel/JNE tracking, shipment exceptions, and labels.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {['Paxel', 'JNE'].map((provider) => (
          <Card key={provider}>
            <div className="flex items-center justify-between">
              <CardTitle>{provider}</CardTitle>
              <Badge tone="success">Connected</Badge>
            </div>
            <p className="mt-3 text-sm text-gray-500">Rates and tracking provider abstraction is ready in backend shipping module.</p>
          </Card>
        ))}
      </div>
    </AdminShell>
  );
}
