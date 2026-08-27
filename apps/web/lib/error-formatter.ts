import { ApiError } from './api';

export interface FormattedError {
  userMessage: string;
  rawMessage: string;
  isTechnical: boolean;
}

const KNOWN_ERROR_MAPPINGS: Array<{ pattern: RegExp | string; friendly: string }> = [
  // Registration & Sanctions
  {
    pattern: /only importer accounts can register/i,
    friendly: 'Only registered importer accounts can perform this action.',
  },
  {
    pattern: /importer already registered/i,
    friendly: 'An importer entity has already been registered for this user account.',
  },
  {
    pattern: /sanctions screening/i,
    friendly:
      'Registration could not be completed because compliance screening requirements were not met.',
  },
  {
    pattern: /OFAC/i,
    friendly:
      'Registration could not be completed because compliance screening requirements were not met.',
  },
  {
    pattern: /high risk by AML/i,
    friendly: 'Registration could not be completed due to account compliance policies.',
  },
  {
    pattern: /Bond validation failed/i,
    friendly:
      'Your customs bond details could not be validated. Please check the bond number and try again.',
  },

  // KYC & Compliance
  {
    pattern: /KYC approval required/i,
    friendly: 'KYC verification must be completed before performing this action.',
  },
  {
    pattern: /pending AML review/i,
    friendly:
      'This transaction is temporarily paused for standard compliance review. Please try again shortly.',
  },

  // Deposits & Top-ups & Withdrawals
  {
    pattern: /insufficient (collateral|balance|funds)/i,
    friendly: 'Your account does not have sufficient balance for this transaction.',
  },
  {
    pattern: /exceeds available excess/i,
    friendly: 'The requested withdrawal amount exceeds your available excess collateral.',
  },
  {
    pattern: /cannot withdraw below required/i,
    friendly: 'Withdrawal cannot reduce your balance below the required collateral threshold.',
  },
  {
    pattern: /collateral is locked/i,
    friendly: 'Withdrawals are currently restricted while active customs claims are pending.',
  },

  // Tariffs & HTS
  {
    pattern: /HTS rate validation failed/i,
    friendly: 'Tariff data validation failed: one or more HTS rates appear to be underreported.',
  },
  {
    pattern: /underreported/i,
    friendly: 'Tariff entry failed: one or more duty rate items were flagged as underreported.',
  },
  {
    pattern: /CBP validation failed/i,
    friendly:
      'Customs & Border Protection (CBP) rate validation failed. Please review your tariff entries.',
  },

  // Signatures & Deadlines
  {
    pattern: /72-hour signing deadline/i,
    friendly: 'The 72-hour signature window has expired. Please request a new document.',
  },
  {
    pattern: /already has a completed signature/i,
    friendly: 'This bond document has already been signed and completed.',
  },

  // Common inputs & limits
  { pattern: /invalid input/i, friendly: 'Please check the entered information and try again.' },
  {
    pattern: /rate limit exceeded|too many auth attempts/i,
    friendly: 'Too many requests. Please wait a few minutes before trying again.',
  },
  { pattern: /not found/i, friendly: 'The requested entity or record could not be found.' },
];

const TECHNICAL_PATTERNS = [
  /duplicate key value/i,
  /violates unique constraint/i,
  /ECONNREFUSED/i,
  /HTTP 5\d\d/i,
  /Internal Server Error/i,
  /pg_query_params/i,
  /stack trace/i,
  /null value in column/i,
  /syntax error/i,
  /uncaught (exception|typeerror|referenceerror)/i,
  /failed to fetch/i,
  /networkerror/i,
];

export function isTechnicalErrorMessage(msg: string): boolean {
  return TECHNICAL_PATTERNS.some((pattern) => pattern.test(msg));
}

export function formatApiError(error: unknown): FormattedError {
  if (
    typeof error === 'object' &&
    error !== null &&
    'userMessage' in error &&
    'rawMessage' in error
  ) {
    return error as FormattedError;
  }

  let rawMessage = 'An unknown error occurred';
  if (error instanceof ApiError) {
    rawMessage = error.message;
  } else if (error instanceof Error) {
    rawMessage = error.message;
  } else if (typeof error === 'string' && error.trim().length > 0) {
    rawMessage = error;
  }

  // 1. Check known friendly mappings
  for (const mapping of KNOWN_ERROR_MAPPINGS) {
    const matches =
      typeof mapping.pattern === 'string'
        ? rawMessage.toLowerCase().includes(mapping.pattern.toLowerCase())
        : mapping.pattern.test(rawMessage);

    if (matches) {
      return {
        userMessage: mapping.friendly,
        rawMessage,
        isTechnical: false,
      };
    }
  }

  // 2. Check if technical error
  if (isTechnicalErrorMessage(rawMessage)) {
    return {
      userMessage:
        'An unexpected system error occurred. Please try again or contact support if the issue persists.',
      rawMessage,
      isTechnical: true,
    };
  }

  // 3. Fallback: Return raw message if it's already user-understandable
  return {
    userMessage: rawMessage,
    rawMessage,
    isTechnical: false,
  };
}
