'use client';

import { ReactNode, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isAdminAuthenticated } from '@/lib/auth';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

export function AdminShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    if (!isAdminAuthenticated()) {
      router.replace('/login');
      return;
    }
    setAuthChecked(true);
  }, [router]);

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white">
        <p className="text-sm text-gray-500">Checking admin authentication...</p>
      </div>
    );
  }

  return (
    <div>
      <Sidebar />
      <main className="min-h-screen md:pl-[290px]">
        <Topbar />
        <div className="p-4 md:p-6 xl:p-8">{children}</div>
      </main>
    </div>
  );
}
