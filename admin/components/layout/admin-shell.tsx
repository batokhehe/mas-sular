import { ReactNode } from 'react';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

export function AdminShell({ children }: { children: ReactNode }) {
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
