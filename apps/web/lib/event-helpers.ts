import { stroopsToXlm } from './api';

const NON_MONETARY_PATTERNS = [
  'tariff',
  'exposure',
  'register',
  'status',
  'required_changed',
  'bond_updated',
  'document',
  'verification',
];

export function isNonMonetaryEventKind(kind: string): boolean {
  if (!kind) return false;
  const normalized = kind.toLowerCase();
  return NON_MONETARY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * Returns contextual text for event log amounts:
 * - Valid positive amounts render as `${amount} XLM`
 * - Non-monetary event kinds (tariff updates, registrations, status changes) render as 'no amount'
 * - Monetary event kinds with missing/falsy amounts or ambiguous kinds render as '—'
 */
export function getEventAmountLabel(event: { kind: string; amount: string | null }): string {
  if (event.amount && event.amount !== '0') {
    const num = Number(event.amount);
    if (!Number.isNaN(num) && num > 0) {
      return `${stroopsToXlm(event.amount)} XLM`;
    }
  }

  if (isNonMonetaryEventKind(event.kind)) {
    return 'no amount';
  }

  return '—';
}
