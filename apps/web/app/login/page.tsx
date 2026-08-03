'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Nav } from '@/components/Nav';
import { api, ApiError } from '@/lib/api';
import { setSession } from '@/lib/auth';

export default function Login() {
  const router = useRouter();
  const [form, setForm] = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { token, user } = await api.login(form);
      setSession(token, user);
      router.push(user.role === 'surety_admin' ? '/surety' : '/app');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Nav />
      <main className="max-w-md mx-auto px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">Log in</h1>
        <form onSubmit={onSubmit} className="mt-8 space-y-4">
          <label className="block">
            <span className="block text-sm font-medium">Email</span>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
              className="mt-1 block w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="block text-sm font-medium">Password</span>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
              className="mt-1 block w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
          </label>
          {error ? (
            <p className="rounded border border-danger bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-accent px-4 py-2.5 text-accent-foreground hover:opacity-90 disabled:opacity-50 text-sm font-medium"
          >
            {loading ? 'Logging in…' : 'Log in'}
          </button>
        </form>
        <p className="mt-6 text-sm text-muted">
          No account?{' '}
          <Link href="/signup" className="text-accent hover:underline">
            Sign up
          </Link>
        </p>
      </main>
    </>
  );
}
