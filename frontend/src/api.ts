export type User = { email: string };

export type PreviewCase = {
  code: string;
  position: number;
  title: string;
  module: string | null;
  priority: string | null;
  expect_absent?: string[];
  visual_check?: string;
  reference_asset_count?: number;
};

export type ImportPreview = {
  ticket_id: string;
  detected_format: string;
  count: number;
  cases: PreviewCase[];
  fields: string[];
  errors: string[];
  warnings: string[];
  title?: string | null;
  reference_asset_count?: number;
  reference_link_count?: number;
  prototype_version?: string | null;
};

export type ReferenceFocus = {
  label: string;
  note: string | null;
  box: [number, number, number, number] | null;
};

export type ReferenceAsset = {
  id: string;
  link_id: string;
  asset_key: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  asset_type: string;
  screen: string | null;
  state: string | null;
  prototype_version: string | null;
  role: "expected" | "locator";
  caption: string | null;
  focus: ReferenceFocus[];
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
  expect_absent: string[];
  visual_check: string;
  prototype_note: string | null;
  reference_assets: ReferenceAsset[];
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
  source: "execution" | "reconcile";
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

export type LarkResolved = {
  source_url: string;
  base_token: string;
  base_name: string;
  tables: { table_id: string; name: string }[];
  selected: { table_id: string | null; table_name: string | null; view_id: string | null };
  execution_fields: Record<string, string>;
  required_execution_fields: string[];
  schema_errors: string[];
  // A base can answer 200 and still explain why it yielded no tables.
  read_errors: string[];
};

export type LarkTarget = {
  group_id: string;
  source_url: string;
  execution_base_token: string;
  execution_base_name: string;
  execution_table_id: string;
  execution_table_name: string;
  bug_base_token: string;
  bug_base_name: string;
  bug_table_id: string;
  bug_table_name: string;
  schema_fingerprint: string | null;
  target_fingerprint: string;
  confirmed_at: string | null;
  confirmed: boolean;
};

export type LarkTargetState = {
  target: LarkTarget | null;
  live: { schema_errors: string[]; read_errors: string[] } | null;
  read_errors: string[];
};

export type TableRole = "execution" | "bug";

export type Table = { table_id: string; name: string };

export type ProvisionField = {
  name: string;
  type: number;
  type_name: string;
  properties: Record<string, unknown>;
};

export type ProvisionView = {
  name: string;
  exists: boolean;
  view_id: string | null;
};

export type ProvisionPlan = {
  roles: { execution: ProvisionField[]; bug: ProvisionField[] };
  // Whether each role's table already carries the provisioning view, so nobody
  // is offered a view that is already there.
  views?: { execution: ProvisionView; bug: ProvisionView };
};

export type ProvisionFieldsPayload = {
  role: TableRole;
  field_names: string[];
  create_view: boolean;
  acknowledge: boolean;
};

export type ProvisionFieldsResult = {
  created_fields: string[];
  view?: ProvisionView & { created: boolean };
  schema_errors: string[];
  target: LarkTarget;
};

// A refused run answers 409 with this object instead of a plain string: it
// carries the readable reason and the fields created before it stopped.
export type ProvisionFailureDetail = {
  reason: "provision_failed";
  message: string;
  created_fields: string[];
};

export type CreateTablePayload = {
  role: TableRole;
  base_token: string;
  table_name: string;
  acknowledge: boolean;
};

export type CreateTableResult = {
  table: Table;
  role: TableRole;
};

export type LarkTargetPayload = {
  source_url: string;
  execution_base_token: string;
  execution_table_id: string;
  execution_view_id?: string | null;
  bug_base_token: string;
  bug_table_id: string;
  expected_previous_fingerprint?: string | null;
  acknowledge_change?: boolean;
};

// The 409 body of a target save is a plain string for a refusal the page can
// show as-is, but an object when the administrator has to acknowledge a change.
export type LarkTargetChangeDetail = {
  reason: "target_changed" | "stale_page";
  diff: {
    changed: boolean;
    changed_keys: string[];
    previous: {
      execution_base_token: string;
      execution_table_id: string;
      bug_base_token: string;
      bug_table_id: string;
    } | null;
    next: {
      execution_base_token: string;
      execution_table_id: string;
      bug_base_token: string;
      bug_table_id: string;
    };
  };
};

export type SyncStatus = {
  confirmed: boolean;
  queued: number;
  synced: number;
  failed: number;
  uncertain: number;
  // Pending jobs whose last run could not prove the destination was still
  // approved: they wait for an administrator, which is a different decision
  // from retrying an ordinary failure.
  parked?: number;
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

export type ReconcileRow = {
  key: string;
  case_code: string;
  label: string;
  status: "same" | "local_only" | "remote_only" | "conflict" | "unmatched";
  differing: string[];
  local: { attempt_id: string; result: string | null; console_text: string | null } | null;
  remote: { record_id: string | null; result: string | null; console_text: string | null } | null;
  decision: "use_remote" | "use_local" | null;
};

export type ReconcileDiff = {
  source: "live" | "stored";
  source_table_name: string | null;
  read_errors: string[];
  rows: ReconcileRow[];
  counts: Record<ReconcileRow["status"], number>;
  unresolved: number;
};

export type ReconcileDecision = { key: string; action: "use_remote" | "use_local" };

export class ApiError extends Error {
  // ``detail`` stays raw because a refusal is a string while a change request
  // is an object; callers decide which shape they are looking at.
  constructor(public status: number, public detail: unknown) {
    super(typeof detail === "string" ? detail : `请求失败 (${status})`);
    this.name = "ApiError";
  }
}

let csrfToken: string | null = null;
let csrfRequest: Promise<string> | null = null;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: "same-origin" });
  } catch {
    // A rejected fetch is a transport failure; its native text is "Failed to
    // fetch", which tells an administrator nothing they can act on.
    throw new ApiError(0, "无法连接服务器，请重试");
  }
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
  referenceAssetUrl: (assetId: string) => `/api/case-reference-assets/${assetId}`,
  reportUrl: (groupId: string, format: "csv" | "xlsx") =>
    `/api/groups/${groupId}/reports.${format}`,
  resolveLark: (url: string) =>
    mutation<LarkResolved>("/api/lark/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    }),
  larkTarget: (groupId: string) =>
    request<LarkTargetState>(`/api/groups/${groupId}/lark/target`),
  saveLarkTarget: (groupId: string, payload: LarkTargetPayload) =>
    mutation<{ target: LarkTarget; live: LarkTargetState["live"]; confirmation_cleared: boolean }>(
      `/api/groups/${groupId}/lark/target`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    ),
  confirmLarkTarget: (groupId: string, targetFingerprint: string) =>
    mutation<LarkTarget>(`/api/groups/${groupId}/lark/target/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow_writes: true, target_fingerprint: targetFingerprint })
    }),
  larkProvisionPlan: (groupId: string) =>
    request<ProvisionPlan>(`/api/groups/${groupId}/lark/provision`),
  provisionLarkFields: (groupId: string, payload: ProvisionFieldsPayload) =>
    mutation<ProvisionFieldsResult>(`/api/groups/${groupId}/lark/provision/fields`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  createLarkTable: (groupId: string, payload: CreateTablePayload) =>
    mutation<CreateTableResult>(`/api/groups/${groupId}/lark/provision/table`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  syncStatus: (groupId: string) => request<SyncStatus>(`/api/groups/${groupId}/sync`),
  enqueueSync: (groupId: string) =>
    mutation<{ queued: number }>(`/api/groups/${groupId}/sync/enqueue`, { method: "POST" }),
  retrySync: (groupId: string, releaseUncertain = false) =>
    mutation<{ requeued: number; released: number; repointed: number }>(
      `/api/groups/${groupId}/sync/retry`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ release_uncertain: releaseUncertain })
      }
    ),
  legacyHistory: (groupId: string, code: string) =>
    request<LegacyHistory>(
      `/api/groups/${groupId}/cases/${encodeURIComponent(code)}/lark-history`
    ),
  legacyAttachmentUrl: (refId: string, index: number) =>
    `/api/lark/history/${refId}/attachments/${index}`,
  reconcile: (groupId: string, source: "live" | "stored") =>
    request<ReconcileDiff>(`/api/groups/${groupId}/reconcile?source=${source}`),
  applyReconcile: (groupId: string, decisions: ReconcileDecision[]) =>
    mutation<{ pulled: number; kept: number; skipped: { key: string; reason: string }[] }>(
      `/api/groups/${groupId}/reconcile/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisions })
      }
    )
};
