// Shared helpers for the k6 load scripts (NFR-PERF-*). Plain k6 JavaScript:
// no Node modules, only k6 built-ins.
import http from 'k6/http';
import { check, fail } from 'k6';
import exec from 'k6/execution';

/** Base URL of the stack under test (staging), without a trailing slash. */
export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
export const API = `${BASE_URL}/api/v1`;

/** Pilot-city points used by the seed (Bengaluru, Koramangala and around). */
export const POINTS = [
  { lat: 12.9352, lng: 77.6245 },
  { lat: 12.9279, lng: 77.6271 },
  { lat: 12.9716, lng: 77.5946 },
  { lat: 12.9141, lng: 77.6411 },
];

export const SEARCH_TERMS = ['biryani', 'paneer', 'dosa', 'pizza', 'chai', 'thali', 'noodles'];

/** The app origins the API allows (NFR-SEC-009); override for staging hosts. */
export const ORIGINS = {
  CUSTOMER: __ENV.ORIGIN_CUSTOMER || 'http://localhost:5173',
  RESTAURANT: __ENV.ORIGIN_RESTAURANT || 'http://localhost:5174',
  DELIVERY: __ENV.ORIGIN_DELIVERY || 'http://localhost:5175',
};

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function uuid() {
  // RFC 4122 v4 from Math.random: idempotency keys only need to be unique per request.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function headers(app, token, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Client-App': app,
    Origin: ORIGINS[app],
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/** `name` groups URLs with ids into one metric series (k6 `name` tag). */
export function get(path, { app = 'CUSTOMER', token, name, tags = {} } = {}) {
  return http.get(`${API}${path}`, {
    headers: headers(app, token),
    tags: { name: name || path, ...tags },
  });
}

export function send(
  method,
  path,
  body,
  { app = 'CUSTOMER', token, name, idempotent, tags = {} } = {},
) {
  return http.request(method, `${API}${path}`, body === undefined ? null : JSON.stringify(body), {
    headers: headers(app, token, idempotent ? { 'Idempotency-Key': uuid() } : {}),
    tags: { name: name || path, ...tags },
  });
}

export function data(res) {
  try {
    return res.json('data');
  } catch {
    return null;
  }
}

/**
 * Accounts are provisioned on staging beforehand (README): a JSON file of
 * `{ phone, password }` per app, passed as CUSTOMERS_FILE / PARTNERS_FILE / STAFF_FILE.
 */
export function accounts(envName, fallback) {
  const file = __ENV[envName];
  if (!file) return fallback;
  return JSON.parse(open(file));
}

/** Password sign-in (API-AUTH-003); returns the access token or fails the iteration. */
export function signIn(app, account) {
  const res = send(
    'POST',
    '/auth/login',
    { identifier: account.phone, password: account.password },
    { app, name: 'auth.login' },
  );
  const token = data(res)?.accessToken;
  if (!check(res, { 'signed in': (r) => r.status === 200 && Boolean(token) }))
    fail(`sign-in failed for ${account.phone}: ${res.status}`);
  return token;
}

/** One account per VU, round-robin, so sessions are not shared between VUs. */
export function accountFor(list) {
  return list[(exec.vu.idInTest - 1) % list.length];
}
