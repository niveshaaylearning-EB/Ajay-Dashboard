import { getAuthToken } from './base.js';

// When served under /wp/ (cloud), API calls must also go through /wp/api/
// On localhost the app runs directly at port 8001, so /api/ is correct
const IS_LOCAL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const BASE = IS_LOCAL ? '/api' : '/wp/api';

export const fetchBaskets   = ()    => fetch(`${BASE}/baskets`).then(r => r.json());
export const addClient = (name) =>
  fetch(`${BASE}/admin/add-client`, {
    method: 'POST', headers: _authHeaders(),
    body: JSON.stringify({ name }),
  }).then(_asJson);
export const renameClient = (key, name) =>
  fetch(`${BASE}/admin/rename-client/${encodeURIComponent(key)}`, {
    method: 'PUT', headers: _authHeaders(),
    body: JSON.stringify({ name }),
  }).then(_asJson);
export const deleteClient = (key) =>
  fetch(`${BASE}/admin/delete-client/${encodeURIComponent(key)}`, {
    method: 'DELETE', headers: _authHeaders(),
  }).then(_asJson);
export const setClientCapital = (key, amount) =>
  fetch(`${BASE}/admin/client-capital/${encodeURIComponent(key)}`, {
    method: 'PUT', headers: _authHeaders(),
    body: JSON.stringify({ amount }),
  }).then(_asJson);
export const fetchClientsSummary = () => fetch(`${BASE}/clients-summary`).then(r => r.json());
export const fetchBasketStockMap  = () => fetch(`${BASE}/basket-stock-map`).then(r => r.json());
export const fetchBasketWeightMap = () => fetch(`${BASE}/basket-weight-map`).then(r => r.json());
export const fetchBasket    = (key) => fetch(`${BASE}/basket/${key}`).then(r => r.json());
export const fetchLiveData  = ()    => fetch(`${BASE}/live`).then(r => r.json());
export const fetchPerformanceBatch = (codes) =>
  fetch(`${BASE}/performance?codes=${encodeURIComponent(codes.join(','))}`).then(r => r.json());
export const fetchLiveStock = (nse, { fast = false } = {}) =>
  fetch(`${BASE}/live/${nse}${fast ? '?fast=true' : ''}`).then(r => r.json());
export const fetchOhlcLookup = (nse, date) =>
  fetch(`${BASE}/ohlc-lookup/${encodeURIComponent(nse)}?date=${encodeURIComponent(date)}`).then(r => r.json());
export const fetchCaStatus = (basket, code) =>
  fetch(`${BASE}/corporate-actions/status/${encodeURIComponent(basket)}/${encodeURIComponent(code)}`).then(r => r.json());
export const fetchRebalanceSummary = (basket) =>
  fetch(`${BASE}/rebalance-summary/${encodeURIComponent(basket)}`).then(r => r.json());

export const saveBasket = (key, stocks, soldStocks, buyPriceDetails) => {
  const token = getAuthToken();
  return fetch(`${BASE}/basket/${key}`, {
    method:  'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body:    JSON.stringify({ stocks, soldStocks, buyPriceDetails }),
  }).then(r => r.json());
};

// ── Watchlist (centralized research pipeline, shared across all users) ──────
const _authHeaders = () => {
  const token = getAuthToken();
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
};
const _asJson = async (res) => {
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.detail || `Request failed (${res.status})`);
  return data;
};

export const fetchWatchlist     = ()  => fetch(`${BASE}/watchlist`).then(r => r.json());
export const fetchWatchlistMeta = ()  => fetch(`${BASE}/watchlist/meta`).then(r => r.json());

export const addWatchlistCompany = (ticker, company) =>
  fetch(`${BASE}/watchlist`, {
    method: 'POST', headers: _authHeaders(),
    body: JSON.stringify({ ticker, company: company || null }),
  }).then(_asJson);

export const updateWatchlistCompany = (id, patch) =>
  fetch(`${BASE}/watchlist/${id}`, {
    method: 'PUT', headers: _authHeaders(), body: JSON.stringify(patch),
  }).then(_asJson);

export const refreshWatchlistCompany = (id) =>
  fetch(`${BASE}/watchlist/${id}/refresh`, { method: 'POST', headers: _authHeaders() }).then(_asJson);

export const deleteWatchlistCompany = (id) =>
  fetch(`${BASE}/watchlist/${id}`, { method: 'DELETE', headers: _authHeaders() }).then(_asJson);
