import { redirect } from 'next/navigation';

// Server-side, so admin permissions are unknown here. /dashboard forwards admins
// without Dashboard.read to their first accessible page (lib/navigation.ts).
export default function Page() {
  redirect('/dashboard');
}
