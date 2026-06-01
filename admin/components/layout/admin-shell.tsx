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
}: {
  children: ReactNode;
  requiredPermissions?: readonly string[];
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
        <p className="text-sm text-gray-500">{hasToken ? 'Loading admin session...' : 'Redirecting to login...'}</p>
      </div>
    );
  }

  if (profileQuery.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
        <div className="max-w-md rounded-2xl border border-red-100 bg-white p-6 text-sm text-gray-700 shadow-sm">
          <h1 className="text-lg font-semibold text-gray-900">Unable to load admin session</h1>
          <p className="mt-2 text-red-600">{profileQuery.error.message}</p>
          <Link href="/login" className="mt-4 inline-flex font-medium text-[#465fff] hover:text-indigo-700">
            Back to login
          </Link>
        </div>
      </div>
    );
  }

  if (!hasAllPermissions(permissions, requiredPermissions)) {
    return (
      <div>
        <Sidebar />
        <main className="min-h-screen md:pl-[290px]">
          <Topbar />
          <div className="p-4 md:p-6 xl:p-8">
            <div className="rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
              <h1 className="text-base font-semibold text-red-900">Permission required</h1>
              <p className="mt-1">Your role does not have access to this admin page.</p>
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
