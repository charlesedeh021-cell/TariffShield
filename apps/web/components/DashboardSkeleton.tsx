/**
 * Animated skeleton for the importer dashboard (#1062). Shared between the
 * route-level Suspense boundary (app/app/loading.tsx) and the in-page state
 * where the importer record has loaded but its detail is still being fetched,
 * so both loading phases look identical instead of degrading to plain text.
 */
export function DashboardSkeleton() {
  return (
    <main className="max-w-5xl mx-auto px-6 py-10 animate-pulse">
      <div className="h-4 w-24 rounded bg-border" />
      <div className="mt-2 h-7 w-64 rounded bg-border" />
      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 rounded-lg border border-border bg-card" />
        ))}
      </div>
      <div className="mt-4 h-16 rounded-lg border border-border bg-card" />
    </main>
  );
}
