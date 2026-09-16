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
  cases: (groupId: string) => request<GroupCase[]>(`/api/groups/${groupId}/cases`)
};
