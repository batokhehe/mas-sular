import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Card, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ArrowDown, ArrowUp, CreditCard, PackageCheck, ShoppingBag, Users } from 'lucide-react';

const stats = [
  { label: 'Unique Customers', value: '24.7K', change: '+20%', tone: 'success' as const, icon: Users },
  { label: 'Total Orders', value: '55.9K', change: '+4%', tone: 'success' as const, icon: ShoppingBag },
  { label: 'Payment Issues', value: '54', change: '-1.59%', tone: 'danger' as const, icon: CreditCard },
  { label: 'Fulfillment Time', value: '2h 56m', change: '+7%', tone: 'success' as const, icon: PackageCheck },
];

export default function DashboardPage() {
  return (
    <AdminShell>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          const TrendIcon = stat.tone === 'success' ? ArrowUp : ArrowDown;
          return (
            <Card key={stat.label}>
              <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-gray-100 text-gray-700">
                <Icon className="h-5 w-5" />
              </div>
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-sm text-gray-500">{stat.label}</p>
                  <p className="mt-2 text-2xl font-semibold text-gray-900">{stat.value}</p>
                </div>
                <Badge tone={stat.tone} className="gap-1">
                  <TrendIcon className="h-3 w-3" />
                  {stat.change}
                </Badge>
              </div>
              <p className="mt-2 text-xs text-gray-400">Vs last month</p>
            </Card>
          );
        })}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
        <Card className="min-h-[360px]">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Analytics</CardTitle>
              <p className="mt-1 text-sm text-gray-500">Visitor analytics of last 30 days</p>
            </div>
            <div className="flex rounded-xl bg-gray-100 p-1 text-sm">
              {['Monthly', 'Quarterly', 'Annually'].map((item, index) => (
                <button key={item} className={index === 0 ? 'rounded-lg bg-white px-3 py-1.5 text-gray-900 shadow-sm' : 'px-3 py-1.5 text-gray-500'}>
                  {item}
                </button>
              ))}
            </div>
          </div>
          <div className="grid h-64 grid-cols-12 items-end gap-3 border-b border-gray-100 pb-4">
            {[45, 70, 52, 88, 62, 74, 58, 92, 66, 78, 54, 84].map((height, index) => (
              <div key={index} className="flex h-full items-end rounded-t-lg bg-indigo-50">
                <div className="w-full rounded-t-lg bg-[#465fff]" style={{ height: `${height}%` }} />
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardTitle>Active Users</CardTitle>
          <div className="mt-6 flex items-center justify-center">
            <div className="flex h-40 w-40 items-center justify-center rounded-full border-[18px] border-indigo-100">
              <div className="text-center">
                <p className="text-3xl font-semibold text-gray-900">364</p>
                <p className="text-xs text-gray-500">Live visitors</p>
              </div>
            </div>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-gray-50 p-3">
              <p className="text-xl font-semibold">224</p>
              <p className="text-xs text-gray-500">Avg, Daily</p>
            </div>
            <div className="rounded-xl bg-gray-50 p-3">
              <p className="text-xl font-semibold">1.4K</p>
              <p className="text-xs text-gray-500">Avg, Weekly</p>
            </div>
          </div>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card>
          <CardTitle>Top Channels</CardTitle>
          <div className="mt-5 space-y-4">
            {[
              ['Google', '4.7K', 79],
              ['Instagram', '3.4K', 62],
              ['WhatsApp', '2.9K', 51],
              ['Direct', '1.5K', 34],
            ].map(([name, value, progress]) => (
              <div key={name}>
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-gray-600">{name}</span>
                  <span className="font-medium text-gray-900">{value}</span>
                </div>
                <Progress value={Number(progress)} />
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardTitle>Sessions By Device</CardTitle>
          <div className="mt-5 space-y-4">
            {[
              ['Mobile', 68],
              ['Desktop', 24],
              ['Tablet', 8],
            ].map(([name, value]) => (
              <div key={name}>
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-gray-600">{name}</span>
                  <span className="font-medium text-gray-900">{value}%</span>
                </div>
                <Progress value={Number(value)} />
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardTitle>Customers Demographic</CardTitle>
          <p className="mt-1 text-sm text-gray-500">Number of customers by city</p>
          <div className="mt-5 space-y-4">
            {[
              ['Jakarta', '2,379 Customers', 79],
              ['Bandung', '589 Customers', 23],
              ['Bekasi', '412 Customers', 17],
            ].map(([city, customers, value]) => (
              <div key={city} className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-gray-800">{city}</p>
                  <p className="text-xs text-gray-500">{customers}</p>
                </div>
                <Badge tone="brand">{value}%</Badge>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="mt-6">
        <div className="mb-4 flex items-center justify-between">
          <CardTitle>Recent Orders</CardTitle>
          <button className="text-sm font-medium text-[#465fff]">See all</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                <th className="py-3 font-medium">Products</th>
                <th className="py-3 font-medium">Category</th>
                <th className="py-3 font-medium">Payment</th>
                <th className="py-3 font-medium">Status</th>
                <th className="py-3 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Baso Urat Jumbo', 'Baso Urat', 'Bank Transfer', 'Processing', 'Rp 106.000'],
                ['Frozen Mix', 'Baso Frozen', 'QRIS', 'Completed', 'Rp 125.000'],
                ['Baso Mercon Level 5', 'Baso Mercon', 'COD', 'Delivering', 'Rp 55.000'],
                ['Baso Keju Mozarella', 'Baso Keju', 'Bank Transfer', 'Waiting Verification', 'Rp 53.000'],
              ].map((row) => (
                <tr key={row[0]} className="border-b border-gray-50 last:border-0">
                  <td className="py-4 font-medium text-gray-800">{row[0]}</td>
                  <td className="py-4 text-gray-500">{row[1]}</td>
                  <td className="py-4 text-gray-500">{row[2]}</td>
                  <td className="py-4">
                    <Badge tone={row[3] === 'Completed' ? 'success' : 'brand'}>{row[3]}</Badge>
                  </td>
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
