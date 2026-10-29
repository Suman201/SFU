import {
  ERROR_CATALOG,
  errorReason,
  type AppErrorCode,
  type PublicErrorCode,
} from '@native-sfu/contracts';
export const ERROR_AREAS = [
  'Forms & files',
  'Account & access',
  'Network & services',
  'Application',
  'Classroom & devices',
] as const;
export type ErrorArea = (typeof ERROR_AREAS)[number];
interface GuideContent {
  name: string;
  area: ErrorArea;
  explanation: string;
  causes: string[];
  userSteps: string[];
  developerChecks: string[];
  example: string;
  related: AppErrorCode[];
}
/** Every emitted public code must have an authored guide; adding a code fails compilation until documented. */
export const ERROR_GUIDES = {
  VALIDATION_FAILED: {
    name: 'Form validation failed',
    area: 'Forms & files',
    explanation:
      'The server understood the request but one or more fields did not meet its validation rules. This is usually a correctable input problem.',
    causes: [
      'A required field is empty or has the wrong format.',
      'A nested field, date or timezone is invalid.',
      'The page sent a field the API does not accept.',
    ],
    userSteps: [
      'Open the error details and review the listed fields.',
      'Correct those fields while keeping a copy of any longer text.',
      'Submit the form again after correcting the details.',
    ],
    developerChecks: [
      'Inspect the response errors array for field paths and constraint messages; nested fields use dot-separated paths.',
      'Compare the submitted field names and types with the endpoint DTO. The backend rejects unknown fields.',
      'Check client/server version alignment when the UI sends a field that the deployed API rejects.',
    ],
    example:
      'HTTP 400 or 422\ncode: VALIDATION_FAILED\nerrors: [{ field: "timeZone", message: "timeZone must be a valid IANA time-zone" }]',
    related: ['INVALID_REQUEST', 'CONFLICT'],
  },
  INVALID_REQUEST: {
    name: 'Request could not be accepted',
    area: 'Forms & files',
    explanation:
      'The requested action does not meet the API requirements. The response message may explain a business rule or an unsupported operation.',
    causes: [
      'An action is invalid for the current state of an item.',
      'Required request information is missing.',
      'The client and API disagree about the supported operation.',
    ],
    userSteps: [
      'Read the specific message shown with the error.',
      'Review the selected item and the details you entered.',
      'If the action still fails, share the code and reference privately with support.',
    ],
    developerChecks: [
      'Inspect the HTTP status and public response message; this is the fallback for otherwise unmapped 4xx responses.',
      'Check controller/service preconditions for the operation.',
      'Do not bypass server validation to make the UI appear successful. Correct the request or the business-rule handling.',
    ],
    example:
      'A page submits an operation that the current API does not support.\nThe action remains incomplete until the request is corrected.',
    related: ['VALIDATION_FAILED', 'CONFLICT'],
  },
  INVALID_CREDENTIALS: {
    name: 'Sign-in details were not accepted',
    area: 'Account & access',
    explanation:
      'The sign-in endpoint returned HTTP 401. The email/password combination could not be verified; the code does not reveal whether a particular email exists.',
    causes: [
      'The email address or password was entered incorrectly.',
      'An old saved password was used.',
      'The wrong account details were selected in a password manager.',
    ],
    userSteps: [
      'Check the email address and keyboard settings.',
      'Enter the password again or use the password-reset flow.',
      'Use the teacher or student sign-in page appropriate to your account.',
    ],
    developerChecks: [
      'Confirm the failure is from the sign-in endpoint rather than an expired protected-resource session.',
      'Keep sign-in responses generic; never disclose account existence or log submitted passwords.',
      'If correct test credentials fail, inspect account state and authentication configuration using authorized server access.',
    ],
    example:
      'POST /api/v1/auth/login → HTTP 401\ncode: INVALID_CREDENTIALS\nNo password or account-existence information belongs in this response.',
    related: ['AUTHENTICATION_REQUIRED', 'ACCESS_DENIED'],
  },
  AUTHENTICATION_REQUIRED: {
    name: 'Authentication is required',
    area: 'Account & access',
    explanation:
      'A protected action could not verify the current session. Sign-in may be missing, expired or revoked. This is different from having insufficient permission.',
    causes: [
      'The user is signed out.',
      'The session expired or was revoked.',
      'Token renewal could not restore a valid session.',
    ],
    userSteps: [
      'Keep a copy of any unsaved work.',
      'Sign in again with the correct account.',
      'Return to the original page and check its state before repeating a change.',
    ],
    developerChecks: [
      'Check whether the final protected request returned 401 after authentication attempted recovery.',
      'Verify the Authorization header is sent only to the configured API origin.',
      'Inspect session expiry/revocation and issuer/audience configuration. Never disable authentication or copy tokens into public reports.',
    ],
    example:
      'GET a protected resource → HTTP 401\ncode: AUTHENTICATION_REQUIRED\nA successful sign-in can restore access; it does not change permissions.',
    related: ['INVALID_CREDENTIALS', 'ACCESS_DENIED'],
  },
  ACCESS_DENIED: {
    name: 'Permission was denied',
    area: 'Account & access',
    explanation:
      'The account does not have permission for this resource or action. Being signed in does not automatically grant enrollment, teacher ownership or administrator access.',
    causes: [
      'A student is not actively enrolled in the batch.',
      'A teacher tries to manage another teacher’s class.',
      'An account without an admin role opens a protected admin resource.',
    ],
    userSteps: [
      'Check that you are using the intended account.',
      'Check your enrollment or ask the teacher/administrator to review access.',
      'Share the error reference privately if the access appears incorrect.',
    ],
    developerChecks: [
      'Inspect the server’s role, ownership and active-enrollment checks for the requested resource.',
      'Verify the authenticated account ID against the resource membership; do not trust role labels or IDs supplied by the browser.',
      'Preserve HTTP 403 and server enforcement. Hiding a control is not an access-control fix.',
    ],
    example:
      'A signed-in student requests the admin error log → HTTP 403\ncode: ACCESS_DENIED\nPublic encyclopedia pages remain readable without admin access.',
    related: ['AUTHENTICATION_REQUIRED', 'RESOURCE_NOT_FOUND'],
  },
  RESOURCE_NOT_FOUND: {
    name: 'Resource was not found',
    area: 'Account & access',
    explanation:
      'The requested item could not be found or is no longer available. The link may be outdated, the item may have been removed, or its identifier may be invalid.',
    causes: [
      'An old class, recording or document link was opened.',
      'The item was removed or unpublished.',
      'A resource identifier does not match an existing record.',
    ],
    userSteps: [
      'Return to the appropriate list and open the item from there.',
      'Check the link with the person who shared it.',
      'If the item should still exist, send its error reference privately to support.',
    ],
    developerChecks: [
      'Check the requested resource identifier and the route version.',
      'Distinguish a missing required resource from an intentional optional-content fallback.',
      'For optional CMS content, handle the expected 404 explicitly instead of presenting a false failure.',
    ],
    example:
      'GET a removed resource → HTTP 404 or 410\ncode: RESOURCE_NOT_FOUND\nThe code describes the resource failure, not an individual incident.',
    related: ['ACCESS_DENIED', 'INVALID_REQUEST'],
  },
  CONFLICT: {
    name: 'Action conflicts with current state',
    area: 'Forms & files',
    explanation:
      'The server rejected a change because the item’s current state conflicts with the request. Repeating the same write without reviewing the latest state may fail again.',
    causes: [
      'Another edit changed the item after the page loaded.',
      'A batch became full or an enrollment already exists.',
      'A classroom or recording operation is incompatible with its current state.',
    ],
    userSteps: [
      'Read the specific conflict message.',
      'Preserve unsaved work, then review the latest state.',
      'Reapply only the changes that are still needed. For whiteboard conflicts, follow the in-class backup/recovery controls.',
    ],
    developerChecks: [
      'Inspect expected-version, current-state and uniqueness checks for the operation.',
      'Keep optimistic-concurrency and capacity checks authoritative on the server.',
      'Do not automatically replay the failed mutation. Re-fetch state and require an intentional reconciliation when work could be overwritten.',
    ],
    example:
      'A reschedule uses an outdated expectedScheduledAt value → HTTP 409\ncode: CONFLICT\nReview the current schedule before submitting another change.',
    related: ['VALIDATION_FAILED', 'REQUEST_TIMEOUT'],
  },
  REQUEST_TOO_LARGE: {
    name: 'Request exceeds the size limit',
    area: 'Forms & files',
    explanation:
      'An upload or request body is larger than a supported limit. A proxy, body parser or feature-specific validator may reject it before the operation runs.',
    causes: [
      'A selected file exceeds the upload limit.',
      'A board snapshot or other request body is too large.',
      'The ingress/proxy limit is lower than the application’s intended limit.',
    ],
    userSteps: [
      'Check the size limit shown beside the upload control.',
      'Choose or export a smaller file without discarding the original.',
      'For board saves, preserve a local backup and share the reference with support.',
    ],
    developerChecks: [
      'Identify which layer returned 413: reverse proxy, endpoint body parser or upload validation.',
      'Compare feature-specific limits across ingress and backend configuration.',
      'Do not raise limits globally without checking memory use and the intended upload requirements.',
    ],
    example:
      'A request body exceeds the endpoint limit → HTTP 413\ncode: REQUEST_TOO_LARGE\nNo fixed upload size is implied by this code.',
    related: ['UNSUPPORTED_FILE_TYPE', 'INVALID_REQUEST'],
  },
  UNSUPPORTED_FILE_TYPE: {
    name: 'File type is not supported',
    area: 'Forms & files',
    explanation:
      'The file or request content format is not accepted by this operation. Renaming an extension does not convert the file’s actual format.',
    causes: [
      'The chosen format is not supported by the upload feature.',
      'The request Content-Type does not match the expected format.',
      'The file contents do not match the declared type.',
    ],
    userSteps: [
      'Check the supported formats shown in the feature.',
      'Export the file into a supported format using its original application.',
      'Upload the converted file and retain the original.',
    ],
    developerChecks: [
      'Compare accepted MIME types and actual content checks with the frontend file picker.',
      'Check Content-Type handling, including multipart uploads.',
      'Keep server-side file validation; a browser file extension filter alone is insufficient.',
    ],
    example:
      'An endpoint rejects an unsupported content format → HTTP 415\ncode: UNSUPPORTED_FILE_TYPE',
    related: ['REQUEST_TOO_LARGE', 'VALIDATION_FAILED'],
  },
  RATE_LIMITED: {
    name: 'Too many requests',
    area: 'Network & services',
    explanation:
      'The request rate exceeded a limit. The server temporarily blocks further attempts for that endpoint or client to protect service availability.',
    causes: [
      'An action was submitted repeatedly.',
      'A client retry/polling loop is sending too many requests.',
      'Several users share a network address used by the rate limiter.',
    ],
    userSteps: [
      'Stop repeating the action and wait before trying again.',
      'Follow a retry delay if the application shows one.',
      'If ordinary use repeatedly triggers this error, share the reference with support.',
    ],
    developerChecks: [
      'Inspect the endpoint’s throttle configuration and Retry-After header when supplied.',
      'Look for duplicate subscriptions, polling storms and immediate retry loops.',
      'Check proxy trust and rate-limit identity for shared networks; do not solve the issue by removing protection globally.',
    ],
    example:
      'Too many issue reports in a short interval → HTTP 429\ncode: RATE_LIMITED\nWait for the endpoint’s limit window to reset.',
    related: ['REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE'],
  },
  REQUEST_TIMEOUT: {
    name: 'Action timed out',
    area: 'Network & services',
    explanation:
      'The action did not finish or receive acknowledgement within the allowed time. A timeout does not prove that the server failed to apply a change.',
    causes: [
      'A server or dependency is responding slowly.',
      'The network interrupted a response.',
      'A classroom acknowledgement did not arrive before its deadline.',
    ],
    userSteps: [
      'Check whether the requested action has already completed.',
      'Preserve unsaved work while checking the connection.',
      'Retry only after confirming that repeating the action will not create a duplicate change.',
    ],
    developerChecks: [
      'Distinguish an HTTP 408/504 from a classroom acknowledgement deadline.',
      'Correlate available request IDs with dependency latency and server logs.',
      'Use idempotency and state reconciliation where required. Increasing timeouts alone does not resolve a slow or stuck operation.',
    ],
    example:
      'HTTP 408/504, or a classroom acknowledgement timeout\ncode: REQUEST_TIMEOUT\nThe final operation state may still need reconciliation.',
    related: ['NETWORK_ERROR', 'CONFLICT'],
  },
  SERVICE_UNAVAILABLE: {
    name: 'Service is temporarily unavailable',
    area: 'Network & services',
    explanation:
      'The server or an intermediary could not provide the service. This can result from an unavailable backend, an unhealthy upstream or a required feature that is not configured.',
    causes: [
      'The API is restarting or unavailable.',
      'A gateway cannot reach its upstream service.',
      'A required dependency or optional integration is not ready.',
    ],
    userSteps: [
      'Wait briefly and check the page again.',
      'If you submitted a change, check whether it saved before resubmitting.',
      'Share the reference if service does not recover.',
    ],
    developerChecks: [
      'Determine whether the 502/503 originated at ingress or inside the API.',
      'Check backend/dependency health and the relevant feature configuration.',
      'An ingress failure may not have an API incident record; inspect gateway logs as well as application logs.',
    ],
    example:
      'The gateway cannot reach the API → HTTP 502\ncode: SERVICE_UNAVAILABLE\nThe public encyclopedia remains readable while the API is down.',
    related: ['NETWORK_ERROR', 'INTERNAL_ERROR'],
  },
  INTERNAL_ERROR: {
    name: 'Unexpected server error',
    area: 'Application',
    explanation:
      'The server encountered an unexpected failure. Public responses omit the original exception message to avoid exposing private data. The reference helps an authorized developer trace the occurrence.',
    causes: [
      'An unexpected exception occurred while processing the action.',
      'A database operation failed unexpectedly.',
      'A dependency failure was not handled by the feature.',
    ],
    userSteps: [
      'Check the current state before repeating a submitted change.',
      'Copy the error details if the failure continues.',
      'Send the reference privately to support; the public code page cannot retrieve a personal incident.',
    ],
    developerChecks: [
      'Search the private admin error log or structured application_error logs using requestId.',
      'Inspect the sanitized exception name, file/line frames and developer explanation where available.',
      'If the database incident write is unavailable, use server logs. Diagnose the cause before replaying a mutation.',
    ],
    example:
      'HTTP 500\ncode: INTERNAL_ERROR\nrequestId: <private occurrence reference>\nOnly the code belongs in the public documentation URL.',
    related: ['INVALID_RESPONSE', 'SERVICE_UNAVAILABLE'],
  },
  INVALID_RESPONSE: {
    name: 'Response could not be read',
    area: 'Application',
    explanation:
      'The HTTP response arrived, but the page could not interpret it as the expected data. Even a successful HTTP status can accompany an unreadable response.',
    causes: [
      'A proxy returned HTML where JSON was expected.',
      'The API response is malformed.',
      'Frontend and backend deployments use incompatible response formats.',
    ],
    userSteps: [
      'Check whether the action completed before trying it again.',
      'Keep a copy of any unsaved work.',
      'Share the error reference with support if refreshing later does not help.',
    ],
    developerChecks: [
      'Inspect status, Content-Type and response format privately in developer tools.',
      'Check SPA fallback/proxy routing so API URLs do not return index.html.',
      'Verify the API envelope and the deployed client version; do not treat HTTP 200 alone as proof of a successful action.',
    ],
    example:
      'HTTP 200 with HTML instead of the expected JSON\ncode: INVALID_RESPONSE',
    related: ['INTERNAL_ERROR', 'CLIENT_ERROR'],
  },
  NETWORK_ERROR: {
    name: 'Network connection failed',
    area: 'Network & services',
    explanation:
      'The browser could not obtain an HTTP response from Sapiovian. This code cannot by itself distinguish loss of internet, a blocked connection, a certificate issue or a server that could not be reached.',
    causes: [
      'The device is offline or the connection was interrupted.',
      'The API address cannot be reached.',
      'CORS, a certificate or a network policy blocked access.',
    ],
    userSteps: [
      'Check your internet connection and whether other sites load.',
      'Return to the page and check whether the previous action completed.',
      'Retry intentionally after the connection recovers; copy the reference if the issue persists.',
    ],
    developerChecks: [
      'Inspect the failed request in the browser Network panel. Angular status 0 means no usable HTTP response reached the client.',
      'Check the configured API origin, TLS certificate and CORS policy without exposing credentials.',
      'A request that never reached the API will have no matching server request log. Client diagnostics and timing may be needed.',
    ],
    example:
      'Browser request fails without an HTTP response\nstatusCode: 0\ncode: NETWORK_ERROR\nA generated client reference is not a server request ID.',
    related: ['SERVICE_UNAVAILABLE', 'REQUEST_TIMEOUT'],
  },
  CLIENT_ERROR: {
    name: 'Unexpected page error',
    area: 'Application',
    explanation:
      'An uncaught browser or Angular error prevented part of the page from continuing. It may be a rendering, navigation or application-code problem rather than a failed API request.',
    causes: [
      'Page code threw an unhandled exception.',
      'A lazy-loaded screen could not initialize.',
      'An unhandled asynchronous rejection reached the global error handler.',
    ],
    userSteps: [
      'Preserve any unsaved work before reloading.',
      'Reload only when ready and note the action that triggered the issue.',
      'Share the code and reference privately if the same steps reproduce it.',
    ],
    developerChecks: [
      'Inspect the client report’s file/line coordinates and reproduce the triggering action.',
      'Use matching privately held source maps when the deployed bundle is minified.',
      'An authenticated runtime report is best effort. Offline, guest or startup errors may only have copyable diagnostics.',
    ],
    example:
      'An uncaught page exception reaches the global error handler\ncode: CLIENT_ERROR\nOriginal exception messages are not copied into public incident reports.',
    related: ['INVALID_RESPONSE', 'INTERNAL_ERROR'],
  },
  DEVICE_PERMISSION_DENIED: {
    name: 'Camera or microphone access blocked',
    area: 'Classroom & devices',
    explanation:
      'The browser or operating system did not grant access to a requested camera or microphone. This code can appear even when the device is connected.',
    causes: [
      'Site camera/microphone permission is blocked.',
      'System privacy settings deny access to the browser or app.',
      'A device access request was declined.',
    ],
    userSteps: [
      'Allow the required camera or microphone in site and system privacy settings.',
      'Return to device setup and run the device test again.',
      'Choose the intended input device. Do not leave an ongoing class just to change a device setting.',
    ],
    developerChecks: [
      'Check the original media permission error and whether the page runs in a secure context.',
      'Check browser and desktop OS privacy permissions separately.',
      'Preserve contextual device recovery controls; do not repeatedly request permission in an automatic loop.',
    ],
    example:
      'A camera test is denied by the browser\ncode: DEVICE_PERMISSION_DENIED\nA connected camera does not imply permission has been granted.',
    related: ['DEVICE_NOT_FOUND', 'DEVICE_BUSY'],
  },
  DEVICE_NOT_FOUND: {
    name: 'Selected device is unavailable',
    area: 'Classroom & devices',
    explanation:
      'The selected camera or microphone could not be found, or its requested constraints could not be satisfied. A previously selected device may no longer be connected.',
    causes: [
      'A USB or wireless device disconnected.',
      'The saved device selection refers to an unavailable input.',
      'The selected capture constraints cannot be met.',
    ],
    userSteps: [
      'Reconnect the device and refresh the device list.',
      'Select another device or System default.',
      'Run the device preview/test again to confirm the selection.',
    ],
    developerChecks: [
      'Inspect NotFoundError or OverconstrainedError from media capture.',
      'Refresh enumerated devices and invalidate stale device selections.',
      'Avoid logging device labels or unique device identifiers in public diagnostics.',
    ],
    example:
      'A saved camera device selection no longer exists\ncode: DEVICE_NOT_FOUND',
    related: ['DEVICE_PERMISSION_DENIED', 'DEVICE_BUSY'],
  },
  DEVICE_BUSY: {
    name: 'Device could not be started',
    area: 'Classroom & devices',
    explanation:
      'The selected camera or microphone could not start. Another app may be using it, but this is also the fallback for other device-start failures; it does not prove exclusive use by another app.',
    causes: [
      'Another application is using the device.',
      'A driver or operating-system capture error occurred.',
      'Device setup failed for a reason other than a recognized permission or missing-device error.',
    ],
    userSteps: [
      'Close other applications that may be using the camera or microphone.',
      'Reconnect or select another device and retry its test.',
      'If the issue continues, use the contextual device message and share the error reference.',
    ],
    developerChecks: [
      'Inspect the original media error name in an authorized debugging session; the busy code is a fallback classification.',
      'Check whether existing preview/live tracks are correctly reused or released.',
      'Do not stop classroom-owned tracks merely to test a second preview.',
    ],
    example:
      'The selected camera fails to start after device selection\ncode: DEVICE_BUSY\nInspect the device-specific message before assuming the cause.',
    related: ['DEVICE_NOT_FOUND', 'DEVICE_PERMISSION_DENIED'],
  },
  CLASSROOM_ERROR: {
    name: 'Classroom action was interrupted',
    area: 'Classroom & devices',
    explanation:
      'A classroom signalling action was rejected or did not complete successfully. This general code preserves the existing classroom-specific recovery message and operation details.',
    causes: [
      'The classroom state changed before the action completed.',
      'The action is not permitted for the participant.',
      'A signalling operation failed during a connection or room transition.',
    ],
    userSteps: [
      'Read the contextual message inside the classroom.',
      'Check connection status, class state and teacher permission where required.',
      'Use the classroom’s recovery controls and preserve your work before reloading.',
    ],
    developerChecks: [
      'Inspect the acknowledgement’s original typed code/details in the classroom flow and the reported operation name.',
      'Correlate participant membership, permissions and room/connection state using authorized logs.',
      'Keep typed acknowledgement errors intact. A client-generated reference is not a server request ID; timeout failures have their own guide.',
    ],
    example:
      'A classroom signalling acknowledgement rejects an action\ncode: CLASSROOM_ERROR\noperation: <classroom event name>\nThe public URL contains no room or participant identifiers.',
    related: ['REQUEST_TIMEOUT', 'ACCESS_DENIED', 'NETWORK_ERROR'],
  },
} satisfies Record<AppErrorCode, GuideContent>;
export type ErrorGuide = GuideContent & {
  code: PublicErrorCode;
  reason: AppErrorCode;
  title: string;
  message: string;
  nextStep: string;
};
export const ALL_ERROR_GUIDES: ErrorGuide[] = (
  Object.keys(ERROR_CATALOG) as AppErrorCode[]
).map((reason) => ({
  ...ERROR_CATALOG[reason],
  ...ERROR_GUIDES[reason],
  reason,
  example: ERROR_GUIDES[reason].example.includes(`code: ${reason}`)
    ? ERROR_GUIDES[reason].example.replaceAll(
        `code: ${reason}`,
        `code: ${ERROR_CATALOG[reason].code}\nreason: ${reason}`,
      )
    : `code: ${ERROR_CATALOG[reason].code}\nreason: ${reason}\n${ERROR_GUIDES[reason].example}`,
}));
export function findErrorGuide(code: string | null): ErrorGuide | undefined {
  const reason = errorReason(code?.toUpperCase());
  return ALL_ERROR_GUIDES.find((guide) => guide.reason === reason);
}
