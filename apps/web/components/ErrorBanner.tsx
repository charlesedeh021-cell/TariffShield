'use client';

import { useState } from 'react';
import { formatApiError, type FormattedError } from '@/lib/error-formatter';

export function ErrorBanner({ error, className = '' }: { error: unknown; className?: string }) {
  const [showDetails, setShowDetails] = useState(false);

  if (!error) return null;

  const formatted: FormattedError =
    typeof error === 'object' && error !== null && 'userMessage' in error && 'rawMessage' in error
      ? (error as FormattedError)
      : formatApiError(error);

  return (
    <div
      className={`rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger ${className}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium flex-1">{formatted.userMessage}</p>
        <button
          type="button"
          onClick={() => setShowDetails(!showDetails)}
          className="text-xs underline text-danger/80 hover:text-danger shrink-0 font-mono"
        >
          {showDetails ? 'Hide details' : 'Details'}
        </button>
      </div>
      {showDetails && (
        <div className="mt-2 rounded bg-background/80 p-2 font-mono text-xs text-muted border border-border overflow-x-auto">
          <p className="font-semibold text-foreground mb-1">Technical detail:</p>
          <p className="break-all">{formatted.rawMessage}</p>
        </div>
      )}
    </div>
  );
}
