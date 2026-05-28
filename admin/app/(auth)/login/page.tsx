import { Button } from '@/components/ui/button';

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <section className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="mb-6">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-[#465fff] font-bold text-white">BN</div>
          <h1 className="text-xl font-semibold text-gray-900">Admin Login</h1>
          <p className="mt-1 text-sm text-gray-500">Google OAuth only, enforced by the backend.</p>
        </div>
        <Button className="w-full">Continue with Google</Button>
      </section>
    </main>
  );
}
