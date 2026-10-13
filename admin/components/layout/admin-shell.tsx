'use client';

import Link from 'next/link';
import { ReactNode, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useAdminAuthStatus, useAdminPermissions, useAdminProfile } from '@/lib/auth';
import { hasAllPermissions } from '@/lib/permissions';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

export function AdminShell({
  children,
  requiredPermissions = [],
  variant = 'default',
}: {
  children: ReactNode;
  requiredPermissions?: readonly string[];
  /**
   * 'document': the same session and permission checks, without the sidebar/topbar
   * chrome - for printable pages (P3 packing slip).
   */
  variant?: 'default' | 'document';
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const hasRedirectedToLogin = useRef(false);
  const { isInitialized, hasToken } = useAdminAuthStatus();
  const profileQuery = useAdminProfile({ enabled: isInitialized && hasToken });
  const permissions = useAdminPermissions();

  useEffect(() => {
    if (hasToken) {
      hasRedirectedToLogin.current = false;
      return;
    }

    if (isInitialized && !hasRedirectedToLogin.current) {
      hasRedirectedToLogin.current = true;
      queryClient.removeQueries({ queryKey: ['admin-profile'] });
      router.replace('/login');
    }
  }, [hasToken, isInitialized, queryClient, router]);

  if (!isInitialized || (isInitialized && !hasToken) || profileQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white">
        <p className="text-sm text-gray-500">{hasToken ? 'Memuat sesi admin...' : 'Mengalihkan ke halaman masuk...'}</p>
      </div>
    );
  }

  if (profileQuery.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
        <div className="max-w-md rounded-2xl border border-red-100 bg-white p-6 text-sm text-gray-700 shadow-sm">
          <h1 className="text-lg font-semibold text-gray-900">Gagal memuat sesi admin</h1>
          <p className="mt-2 text-red-600">{profileQuery.error.message}</p>
          <Link href="/login" className="mt-4 inline-flex font-medium text-[#465fff] hover:text-indigo-700">
            Kembali ke halaman masuk
          </Link>
        </div>
      </div>
    );
  }

  if (variant === 'document') {
    if (!hasAllPermissions(permissions, requiredPermissions)) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-white p-4">
          <div className="max-w-md rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
            <h1 className="text-base font-semibold text-red-900">Izin diperlukan</h1>
            <p className="mt-1">Peran Anda tidak memiliki akses ke halaman admin ini.</p>
          </div>
        </div>
      );
    }
    return <>{children}</>;
  }

  if (!hasAllPermissions(permissions, requiredPermissions)) {
    return (
      <div>
        <Sidebar />
        <main className="min-h-screen md:pl-[290px]">
          <Topbar />
          <div className="p-4 md:p-6 xl:p-8">
            <div className="rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
              <h1 className="text-base font-semibold text-red-900">Izin diperlukan</h1>
              <p className="mt-1">Peran Anda tidak memiliki akses ke halaman admin ini.</p>
            </div>
          </div>
        </main>
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
