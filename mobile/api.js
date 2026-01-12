const BASE_URL = process.env.EXPO_PUBLIC_API_BASE || 'https://modulr.pro';

export async function apiRequest(path, { method = 'GET', body, user } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (user?.role) headers['x-user-role'] = user.role;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = data?.error || res.statusText || 'Request failed';
    throw new Error(msg);
  }
  return data;
}

export async function login(email, password) {
  return apiRequest('/api/auth/login', { method: 'POST', body: { email, password } });
}

export async function fetchMetrics(user) {
  return apiRequest('/api/metrics', { user });
}

export async function fetchLowStock(user) {
  return apiRequest('/api/low-stock', { user });
}

export async function fetchRecentActivity(user, limit = 10) {
  return apiRequest(`/api/recent-activity?limit=${limit}`, { user });
}
