import { AdminShell } from '@/components/layout/admin-shell';
import { Card, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';

export default function AnalyticsPage() {
  return (
    <AdminShell>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Analytics Overview</h2>
        <p className="mt-1 text-sm text-gray-500">Sales, conversion, product performance, and acquisition metrics.</p>
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardTitle>Revenue Trend</CardTitle>
          <div className="mt-6 grid h-72 grid-cols-10 items-end gap-3">
            {[42, 68, 51, 77, 62, 90, 72, 83, 64, 96].map((height, index) => (
              <div key={index} className="flex h-full items-end rounded-t-lg bg-indigo-50">
                <div className="w-full rounded-t-lg bg-[#465fff]" style={{ height: `${height}%` }} />
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <CardTitle>Acquisition Channels</CardTitle>
          <div className="mt-5 space-y-4">
            {[
              ['Search', 72],
              ['Social', 58],
              ['Referral', 31],
              ['Direct', 44],
            ].map(([label, value]) => (
              <div key={label}>
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-gray-600">{label}</span>
                  <span className="font-medium text-gray-900">{value}%</span>
                </div>
                <Progress value={Number(value)} />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </AdminShell>
  );
}
