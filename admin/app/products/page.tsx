import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';

export default function ProductsPage() {
  return (
    <AdminShell>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Product Management</h2>
          <p className="mt-1 text-sm text-gray-500">Catalog, stock, pricing, toppings, and product visibility.</p>
        </div>
        <Button>Add Product</Button>
      </div>
      <Card>
        <CardTitle>Products</CardTitle>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                <th className="py-3 font-medium">SKU</th>
                <th className="py-3 font-medium">Name</th>
                <th className="py-3 font-medium">Category</th>
                <th className="py-3 font-medium">Stock</th>
                <th className="py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['BASO_URAT_JUMBO', 'Baso Urat Jumbo', 'Baso Urat', '50', 'Active'],
                ['BASO_MERCON_SUPER_PEDAS', 'Baso Mercon Super Pedas', 'Baso Mercon', '35', 'Active'],
                ['FROZEN_BASO_URAT_20PCS', 'Frozen Baso Urat', 'Baso Frozen', '100', 'Active'],
              ].map((row) => (
                <tr key={row[0]} className="border-b border-gray-50 last:border-0">
                  <td className="py-4 font-medium text-gray-800">{row[0]}</td>
                  <td className="py-4 text-gray-600">{row[1]}</td>
                  <td className="py-4 text-gray-500">{row[2]}</td>
                  <td className="py-4 text-gray-500">{row[3]}</td>
                  <td className="py-4">
                    <Badge tone="success">{row[4]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </AdminShell>
  );
}
