// Next.js route-level Suspense boundary (issue #256) — automatically wraps
// app/app/page.tsx so the server can stream this skeleton as the initial
// HTML response immediately, before the client component hydrates and
// fetches importer data. See the note in page.tsx for why the page itself
// stays a Client Component rather than an async Server Component.
import { DashboardSkeleton } from '@/components/DashboardSkeleton';

export default function Loading() {
  return <DashboardSkeleton />;
}
