/** Stable public error codes. Keep recovery text safe for every app surface. */
export const ERROR_CATALOG = {
  VALIDATION_FAILED: {
    title: 'Check the form',
    message: 'Some details need your attention.',
    nextStep: 'Correct the highlighted fields and submit again.',
  },
  INVALID_REQUEST: {
    title: 'This action could not be completed',
    message: 'The request could not be accepted.',
    nextStep: 'Review your details and try the action again.',
  },
  INVALID_CREDENTIALS: {
    title: 'Check your sign-in details',
    message: 'The email or password is incorrect.',
    nextStep: 'Check your email and password, or reset your password.',
  },
  AUTHENTICATION_REQUIRED: {
    title: 'Please sign in again',
    message: 'Your session is no longer available.',
    nextStep: 'Sign in again, then return to this page.',
  },
  ACCESS_DENIED: {
    title: 'Access is restricted',
    message: 'Your account cannot perform this action.',
    nextStep:
      'Check that you are using the correct account, or contact your administrator.',
  },
  RESOURCE_NOT_FOUND: {
    title: 'This item is unavailable',
    message: 'It may have been removed or the link may be out of date.',
    nextStep: 'Return to the list and open the item again.',
  },
  CONFLICT: {
    title: 'Something has changed',
    message: 'This action conflicts with the current information.',
    nextStep: 'Review the latest information before submitting again.',
  },
  REQUEST_TOO_LARGE: {
    title: 'This file or request is too large',
    message: 'The upload exceeds the supported size.',
    nextStep: 'Choose a smaller file and upload it again.',
  },
  UNSUPPORTED_FILE_TYPE: {
    title: 'This file type is unsupported',
    message: 'The selected format cannot be used here.',
    nextStep: 'Choose one of the file types listed beside the upload field.',
  },
  RATE_LIMITED: {
    title: 'Please wait a moment',
    message: 'Too many requests were made in a short time.',
    nextStep: 'Wait a minute before trying again.',
  },
  REQUEST_TIMEOUT: {
    title: 'This is taking too long',
    message: 'The server did not finish the request in time.',
    nextStep: 'Check whether the action completed before trying it again.',
  },
  SERVICE_UNAVAILABLE: {
    title: 'Temporarily unavailable',
    message: 'This service cannot respond right now.',
    nextStep:
      'Wait a moment, then check the page again. If you submitted a change, check whether it saved first.',
  },
  INTERNAL_ERROR: {
    title: 'We could not complete this action',
    message: 'Something went wrong on our side.',
    nextStep:
      'Check whether your change saved before trying again. Share the reference if the problem continues.',
  },
  INVALID_RESPONSE: {
    title: 'Unexpected response',
    message: 'The server replied in a format this page could not read.',
    nextStep:
      'Check whether your change saved before trying again. Share the reference with support if it continues.',
  },
  NETWORK_ERROR: {
    title: 'Connection interrupted',
    message: 'We could not reach Sapiovian.',
    nextStep:
      'Check your internet connection. Before submitting again, check whether your previous action completed.',
  },
  CLIENT_ERROR: {
    title: 'Something went wrong on this page',
    message: 'A part of the page could not continue.',
    nextStep:
      'Keep a copy of any unsaved work. Reload only when you are ready; share the reference if it happens again.',
  },
  DEVICE_PERMISSION_DENIED: {
    title: 'Device access is blocked',
    message: 'The camera or microphone permission was not granted.',
    nextStep:
      'Allow device access in your browser or system settings, then retry the device test.',
  },
  DEVICE_NOT_FOUND: {
    title: 'Device not found',
    message: 'The selected camera or microphone is unavailable.',
    nextStep:
      'Connect the device, refresh the device list and select it again.',
  },
  DEVICE_BUSY: {
    title: 'Device is busy',
    message: 'The camera or microphone could not be started.',
    nextStep: 'Close other apps using the device and retry the device test.',
  },
  CLASSROOM_ERROR: {
    title: 'Classroom action interrupted',
    message: 'The classroom could not complete this action.',
    nextStep:
      'Check your connection and the classroom status before trying the action again.',
  },
} as const;
export type AppErrorCode = keyof typeof ERROR_CATALOG;
export type ErrorSource = 'server' | 'web' | 'desktop' | 'admin';
export interface ErrorField {
  field: string;
  message: string;
}
export interface ApiErrorBody {
  success: false;
  code: AppErrorCode;
  title: string;
  message: string;
  nextStep: string;
  errors: ErrorField[];
  statusCode: number;
  path: string;
  timestamp: string;
  requestId: string;
}
export interface ErrorIncident {
  id: string;
  reference: string;
  requestId?: string;
  code: AppErrorCode;
  source: ErrorSource;
  statusCode?: number;
  method?: string;
  operation?: string;
  path: string;
  title: string;
  message: string;
  nextStep: string;
  exceptionName?: string;
  diagnosticKind?: string;
  developerHint?: string;
  frames?: string[];
  userId?: string;
  status: 'open' | 'resolved';
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}
export interface ErrorIncidentPage {
  items: ErrorIncident[];
  total: number;
  page: number;
  limit: number;
}
export function isAppErrorCode(code: unknown): code is AppErrorCode {
  return (
    typeof code === 'string' &&
    Object.prototype.hasOwnProperty.call(ERROR_CATALOG, code)
  );
}
export function errorCodeForStatus(status: number): AppErrorCode {
  if (status === 0) return 'NETWORK_ERROR';
  if (status === 400 || status === 422) return 'VALIDATION_FAILED';
  if (status === 401) return 'AUTHENTICATION_REQUIRED';
  if (status === 403) return 'ACCESS_DENIED';
  if (status === 404 || status === 410) return 'RESOURCE_NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 413) return 'REQUEST_TOO_LARGE';
  if (status === 415) return 'UNSUPPORTED_FILE_TYPE';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 408 || status === 504) return 'REQUEST_TIMEOUT';
  if (status === 502 || status === 503) return 'SERVICE_UNAVAILABLE';
  return status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST';
}
/** Never retain URL queries, fragments, credentials, or arbitrary invalid paths. */
export function errorPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) return '/';
  try {
    const path = new URL(value, 'https://sapiovian.invalid').pathname;
    return path.startsWith('/') ? path.slice(0, 300) : '/';
  } catch {
    return '/';
  }
}
export function errorReference(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value)
    ? value
    : undefined;
}

/** File basenames and line/column only; no exception messages, URL queries or local paths. */
export function errorFrames(stack: unknown): string[] {
  if (typeof stack !== 'string') return [];
  return stack
    .split('\n')
    .slice(0, 30)
    .flatMap((line) => {
      const match = line.match(
        /(?:^|[\s/\\(@])([a-zA-Z0-9_.-]+\.(?:m?js|cjs|ts|tsx))(?:\?[^\s:)]*)?:(\d{1,8}):(\d{1,8})\)?\s*$/,
      );
      return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    })
    .slice(0, 16);
}
