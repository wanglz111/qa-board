export type User = { email: string };

export type PreviewCase = {
  code: string;
  position: number;
  title: string;
  module: string | null;
  priority: string | null;
};

export type ImportPreview = {
  ticket_id: string;
  detected_format: string;
  count: number;
  cases: PreviewCase[];
  fields: string[];
  errors: string[];
  warnings: string[];
};

export type Group = {
  id: string;
  name: string;
  source_name: string;
  source_version: string;
  count: number;
  created_at: string;
};

export type GroupCase = PreviewCase & {
  id: string;
  layer: string | null;
  preconditions: string | null;
  test_data: string | null;
  steps: string | null;
  expected: string | null;
};

export type GroupProgress = {
  passed: number;
  failed: number;
  skipped: number;
  untested: number;
};

export type AttemptResult = "通过" | "不通过" | "未执行";

export type Attempt = {
  id: string;
  label: string;
  sequence: number;
  state: "started" | "committed";
  result: AttemptResult | null;
  note: string | null;
  console_text: string | null;
  created_at: string;
};

export type SubmitPayload = {
  result: AttemptResult;
  note: string | null;
  console_text: string | null;
  idempotency_key: string;
};

export type Screenshot = {
  id: string;
  attempt_id: string;
  storage_key: string;
  mime: string;
  size_bytes: number;
  created_at: string;
};

export type LarkCheck = {
  base_name: string | null;
  execution_table_name: string | null;
  bug_table_name: string | null;
  execution_fields: Record<string, string>;
  bug_fields: Record<string, string>;
  required_execution_fields: string[];
  required_bug_fields: string[];
  schema_errors: string[];
  read_errors: string[];
  schema_fingerprint: string | null;
  target_fingerprint: string | null;
};

export type LarkConfirmation = {
  group_id: string;
  base_token: string;
  execution_table_id: string;
  bug_table_id: string;
  base_name: string;
  execution_table_name: string;
  bug_table_name: string;
  schema_fingerprint: string;
  target_fingerprint: string;
  confirmed_at: string;
  valid: boolean;
};

export type LarkConfirmationState = {
  confirmed: boolean;
  confirmation: LarkConfirmation | null;
  current: {
    base_token: string | null;
    execution_table_id: string | null;
    bug_table_id: string | null;
    base_name: string | null;
    execution_table_name: string | null;
    bug_table_name: string | null;
    schema_fingerprint: string | null;
    target_fingerprint: string | null;
    schema_errors: string[];
    read_errors: string[];
  };
};

export type SyncStatus = {
  confirmed: boolean;
  queued: number;
  synced: number;
  failed: number;
  uncertain: number;
  last_error_kind: string | null;
  pending_attempts: number;
  detail: string;
};

export type LegacyAttachment = {
  index: number;
  name: string | null;
  mime: string | null;
};

export type LegacyResult = {
  record_id: string | null;
  case_text: string;
  result: string | null;
  note: string | null;
  console_text: string | null;
  observed_at: number | null;
  ref_id: string;
  attachments: LegacyAttachment[];
};

export type LegacyBug = {
  record_id: string | null;
  description: string;
  status: string | null;
  priority: string | null;
  matched_by: string;
};

export type LegacyHistory = {
  available: boolean;
  code: string;
  read_errors: string[];
  source_table_name: string | null;
  base_name?: string | null;
  bug_table_name?: string | null;
  read_at: string;
  certainty: "verified" | "uncertain";
  uncertainty: string | null;
  ambiguous: boolean;
  original: LegacyResult[];
  retests: LegacyResult[];
  bugs: LegacyBug[];
  unknown_count: number;
};

export type LarkConfirmPayload = {
  base_token: string;
  execution_table_id: string;
  bug_table_id: string;
  schema_fingerprint: string;
  target_fingerprint: string;
  allow_writes: boolean;
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let csrfToken: string | null = null;
let csrfRequest: Promise<string> | null = null;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "same-origin" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      csrfToken = null;
      csrfRequest = null;
      window.dispatchEvent(new Event("testdeck:unauthorized"));
    }
    throw new ApiError(response.status, body.detail ?? `请求失败 (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function mutation<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!csrfToken) {
    csrfRequest ??= request<{ csrf_token: string }>("/api/auth/csrf").then((body) => body.csrf_token);
    try {
      csrfToken = await csrfRequest;
    } finally {
      csrfRequest = null;
    }
  }
  const headers = new Headers(init.headers);
  headers.set("X-CSRF-Token", csrfToken);
  return request<T>(path, { ...init, headers });
}

export const api = {
  me: () => request<User>("/api/auth/me"),
  login: async (email: string, password: string) => {
    csrfToken = null;
    csrfRequest = null;
    return request<User>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
  },
  logout: async () => {
    await mutation<void>("/api/auth/logout", { method: "POST" });
    csrfToken = null;
    csrfRequest = null;
  },
  preview: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return mutation<ImportPreview>("/api/import/preview", { method: "POST", body });
  },
  confirm: (ticketId: string, name: string, mapping: Record<string, string>) =>
    mutation<{ id: string; count: number }>("/api/import/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket_id: ticketId, name, mapping })
    }),
  groups: () => request<Group[]>("/api/groups"),
  cases: (groupId: string) => request<GroupCase[]>(`/api/groups/${groupId}/cases`),
  progress: (groupId: string) => request<GroupProgress>(`/api/groups/${groupId}/progress`),
  attempts: (groupId: string, code: string) =>
    request<Attempt[]>(`/api/groups/${groupId}/cases/${encodeURIComponent(code)}/attempts`),
  submitAttempt: (groupId: string, code: string, payload: SubmitPayload) =>
    mutation<Attempt>(`/api/groups/${groupId}/cases/${encodeURIComponent(code)}/attempts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  reserveRetest: (groupId: string, code: string) =>
    mutation<Attempt>(`/api/groups/${groupId}/cases/${encodeURIComponent(code)}/retest`, {
      method: "POST"
    }),
  submitReserved: (attemptId: string, payload: SubmitPayload) =>
    mutation<Attempt>(`/api/attempts/${attemptId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  uploadScreenshot: (attemptId: string, file: File) => {
    const body = new FormData();
    body.append("image", file);
    return mutation<Screenshot>(`/api/attempts/${attemptId}/screenshots`, {
      method: "POST",
      body
    });
  },
  screenshotUrl: (screenshotId: string) => `/api/screenshots/${screenshotId}`,
  reportUrl: (groupId: string, format: "csv" | "xlsx") =>
    `/api/groups/${groupId}/reports.${format}`,
  larkCheck: () => request<LarkCheck>("/api/lark/check"),
  larkConfirmation: (groupId: string) =>
    request<LarkConfirmationState>(`/api/groups/${groupId}/lark/confirmation`),
  confirmLark: (groupId: string, payload: LarkConfirmPayload) =>
    mutation<LarkConfirmation>(`/api/groups/${groupId}/lark/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  syncStatus: (groupId: string) => request<SyncStatus>(`/api/groups/${groupId}/sync`),
  enqueueSync: (groupId: string) =>
    mutation<{ queued: number }>(`/api/groups/${groupId}/sync/enqueue`, { method: "POST" }),
  legacyHistory: (groupId: string, code: string) =>
    request<LegacyHistory>(
      `/api/groups/${groupId}/cases/${encodeURIComponent(code)}/lark-history`
    ),
  legacyAttachmentUrl: (refId: string, index: number) =>
    `/api/lark/history/${refId}/attachments/${index}`
};
