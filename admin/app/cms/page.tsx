import { AdminShell } from '@/components/layout/admin-shell';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';

export default function CmsPage() {
  return (
    <AdminShell>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Banner & Content CMS</h2>
          <p className="mt-1 text-sm text-gray-500">Homepage banners, promo content, legal pages, and campaign placements.</p>
        </div>
        <Button>New Banner</Button>
      </div>
      <Card>
        <CardTitle>Active Placements</CardTitle>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {['Home Hero', 'Promo Carousel', 'Checkout Notice'].map((item) => (
            <div key={item} className="rounded-xl border border-gray-100 p-4">
              <p className="font-medium text-gray-800">{item}</p>
              <p className="mt-1 text-sm text-gray-500">Ready for CMS API integration.</p>
            </div>
          ))}
        </div>
      </Card>
    </AdminShell>
  );
}
