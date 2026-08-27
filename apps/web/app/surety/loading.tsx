export default function Loading() {
  return (
    <main className="max-w-5xl mx-auto px-6 py-10 animate-pulse">
      <div className="h-7 w-48 rounded bg-border" />
      <div className="mt-2 h-4 w-96 rounded bg-border" />

      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-20 rounded-lg border border-border bg-card p-4">
            <div className="h-3 w-20 rounded bg-border" />
            <div className="mt-2 h-6 w-24 rounded bg-border" />
          </div>
        ))}
      </div>

      <div className="mt-8">
        <div className="divide-y divide-border rounded-lg border border-border bg-card">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-4 px-4 py-4">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-40 rounded bg-border" />
                <div className="h-3 w-56 rounded bg-border" />
                <div className="h-3 w-72 rounded bg-border" />
              </div>
              <div className="h-4 w-12 rounded bg-border" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
