import { API_BASE, getAuthToken } from '../api/base.js';
import { fetchBaskets } from '../api/client.js';
import { useState, useEffect, useCallback } from 'react';

const ADMIN_EMAILS = ['jay.chaudhari@niveshaay.com', 'nukul.madaan@niveshaay.com', 'nakshatra.rathi@niveshaay.com'];
const _getAdminState = () => {
  try {
    const t = getAuthToken();
    if (!t) return { email: null, isAdmin: false };
    const payload = JSON.parse(atob(t.split('.')[1]));
    if (payload.exp && Date.now() > payload.exp * 1000) return { email: null, isAdmin: false };
    const email = (payload.sub || '').toLowerCase().trim();
    return { email, isAdmin: ADMIN_EMAILS.includes(email) };
  } catch { return { email: null, isAdmin: false }; }
};

const STATUS_COLORS = {
  pending_review: '#fbbf24',
  approved:       '#10b981',
  rejected:       '#ef4444',
  reversed:       'var(--text-secondary)',
};

const box = { background: 'var(--card-bg)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '10px', padding: '1rem 1.2rem', marginBottom: '1rem' };
const label = { display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary)', marginBottom: '0.2rem', textTransform: 'uppercase', letterSpacing: '0.03em' };
const input = { background: 'var(--input-bg)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '6px', color: 'var(--text-primary)', padding: '0.4rem 0.6rem', fontSize: '0.84rem', width: '100%' };
const btn = (color) => ({ background: color + '18', border: `1px solid ${color}55`, color, borderRadius: '6px', padding: '0.4rem 0.9rem', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer' });
const fmt = (v) => v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function emptyForm() {
  return {
    basketKey: '', nseCode: '', securityName: '', type: 'split',
    exDate: '', recordDate: '',
    ratio: { old: '', new: '', existing: '', bonus: '' },
    demerger: {
      resultingCompanyName: '', resultingNseCode: '', resultingIsin: '',
      entitlementRatio: { resulting: '', parent: '' },
      costAllocationPct: { parent: '', resulting: '' },
      resultingListed: false, resultingWeight: '',
    },
  };
}

function toApiBody(form) {
  const body = {
    basketKey: form.basketKey, nseCode: form.nseCode.trim().toUpperCase(),
    securityName: form.securityName, type: form.type,
    exDate: form.exDate, recordDate: form.recordDate,
  };
  if (form.type === 'split') {
    body.ratio = { old: parseFloat(form.ratio.old), new: parseFloat(form.ratio.new) };
  } else if (form.type === 'bonus') {
    body.ratio = { existing: parseFloat(form.ratio.existing), bonus: parseFloat(form.ratio.bonus) };
  } else {
    const dm = form.demerger;
    body.demerger = {
      resultingCompanyName: dm.resultingCompanyName, resultingNseCode: dm.resultingNseCode,
      resultingIsin: dm.resultingIsin, resultingListed: dm.resultingListed,
      entitlementRatio: { resulting: parseFloat(dm.entitlementRatio.resulting), parent: parseFloat(dm.entitlementRatio.parent) },
      costAllocationPct: { parent: parseFloat(dm.costAllocationPct.parent), resulting: parseFloat(dm.costAllocationPct.resulting) },
      resultingWeight: dm.resultingWeight === '' ? null : parseFloat(dm.resultingWeight),
    };
  }
  return body;
}

function ComparisonReport({ report, type, editable, overrides, onOverrideChange, onOverrideClear }) {
  if (!report) return null;
  return (
    <div style={{ marginTop: '0.75rem', fontSize: '0.8rem' }}>
      <div style={{ display: 'flex', gap: '2rem', marginBottom: '0.6rem' }}>
        <div><span style={{ color: 'var(--text-secondary)' }}>Current buy price: </span><strong style={{ color: 'var(--text-primary)' }}>{fmt(report.currentBuyPrice)}</strong></div>
        <div><span style={{ color: 'var(--text-secondary)' }}>Revised buy price: </span><strong style={{ color: 'var(--accent-green)' }}>{fmt(report.revisedBuyPrice)}</strong></div>
        <div><span style={{ color: 'var(--text-secondary)' }}>Difference: </span><strong style={{ color: (report.difference ?? 0) < 0 ? 'var(--accent-red)' : 'var(--accent-green)' }}>{fmt(report.difference)}</strong></div>
      </div>

      {report.eligibleEvents?.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div style={{ color: 'var(--text-secondary)', marginBottom: '0.2rem' }}>
            Eligible buy events (adjusted){editable ? ' — edit a price to override the auto-computed value:' : ':'}
          </div>
          <table style={{ width: '100%', fontSize: '0.76rem' }}>
            <tbody>
              {report.eligibleEvents.map((e, i) => (
                <tr key={i}>
                  <td style={{ color: 'var(--text-secondary)', padding: '0.1rem 0.5rem 0.1rem 0' }}>{e.date}</td>
                  <td style={{ color: 'var(--text-secondary)', padding: '0.1rem 0.5rem' }}>{e.weight}% wt</td>
                  <td style={{ color: 'var(--accent-red)', padding: '0.1rem 0.5rem' }}>{fmt(e.oldPrice)}</td>
                  <td style={{ color: 'var(--text-secondary)', padding: '0.1rem 0.3rem' }}>→</td>
                  {editable ? (
                    <td style={{ padding: '0.1rem 0.5rem' }}>
                      <input
                        type="number" step="0.01"
                        value={overrides?.[e.date] ?? e.newPrice ?? ''}
                        onChange={ev => onOverrideChange(e.date, ev.target.value)}
                        style={{ width: '90px', fontSize: '0.76rem', padding: '0.15rem 0.3rem',
                                 background: 'var(--card-bg)', border: '1px solid rgba(99,102,241,0.3)',
                                 borderRadius: '4px', color: e.overridden || overrides?.[e.date] != null ? 'var(--accent-amber)' : 'var(--accent-green)' }}
                      />
                      {(e.overridden || overrides?.[e.date] != null) && (
                        <button
                          onClick={() => onOverrideClear(e.date)}
                          title="Reset to auto-computed price"
                          style={{ marginLeft: '0.3rem', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.72rem' }}
                        >
                          reset
                        </button>
                      )}
                    </td>
                  ) : (
                    <td style={{ color: e.overridden ? 'var(--accent-amber)' : 'var(--accent-green)', padding: '0.1rem 0.5rem' }}>
                      {fmt(e.newPrice)}{e.overridden ? ' (manual)' : ''}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report.ineligibleEvents?.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div style={{ color: 'var(--text-secondary)', marginBottom: '0.2rem' }}>Ineligible (on/after ex-date, unchanged):</div>
          <table style={{ width: '100%', fontSize: '0.76rem' }}>
            <tbody>
              {report.ineligibleEvents.map((e, i) => (
                <tr key={i}>
                  <td style={{ color: 'var(--text-secondary)', padding: '0.1rem 0.5rem 0.1rem 0' }}>{e.date}</td>
                  <td style={{ color: 'var(--text-secondary)', padding: '0.1rem 0.5rem' }}>{e.weight}% wt</td>
                  <td style={{ color: 'var(--text-secondary)', padding: '0.1rem 0.5rem' }}>{fmt(e.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {type === 'demerger' && report.resultingCompanyPreview && (
        <div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: '0.2rem' }}>
            Resulting company preview (entitlement ratio: {report.resultingCompanyPreview.entitlementRatio ?? '—'},
            {' '}weight: {report.resultingCompanyPreview.resultingWeight ?? 'not set'}%):
          </div>
          <table style={{ width: '100%', fontSize: '0.76rem' }}>
            <tbody>
              {(report.resultingCompanyPreview.perEventBuyPrice || []).map((e, i) => (
                <tr key={i}>
                  <td style={{ color: 'var(--text-secondary)', padding: '0.1rem 0.5rem 0.1rem 0' }}>{e.date}</td>
                  <td style={{ color: 'var(--text-secondary)', padding: '0.1rem 0.5rem' }}>parent wt {e.parentWeight}%</td>
                  <td style={{ color: 'var(--accent-blue)', padding: '0.1rem 0.5rem' }}>resulting buy price {fmt(e.resultingBuyPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RecordCard({ rec, onChanged, isAdmin }) {
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState(() => ({
    exDate: rec.exDate, recordDate: rec.recordDate || '',
    ratio: rec.ratio || { old: '', new: '', existing: '', bonus: '' },
    demerger: rec.demerger || emptyForm().demerger,
    // Per-date manual price corrections. Only dates the admin has actually
    // touched go in here -- NOT every eligible date's current computed price
    // -- otherwise saving would freeze every date's price at whatever the
    // ratio/ex-date happened to compute at edit time, silently ignoring any
    // later ratio change (since an override always wins over the formula).
    priceOverrides: { ...(rec.priceOverrides || {}) },
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const authedFetch = (url, opts = {}) => {
    const token = getAuthToken();
    return fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
    });
  };

  const call = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); await onChanged(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const setPriceOverride = (date, value) =>
    setForm(f => ({ ...f, priceOverrides: { ...f.priceOverrides, [date]: value } }));
  const clearPriceOverride = (date) =>
    setForm(f => { const next = { ...f.priceOverrides }; delete next[date]; return { ...f, priceOverrides: next }; });

  const doRecalc = () => call(async () => {
    const body = { exDate: form.exDate, recordDate: form.recordDate };
    const overrideEntries = Object.entries(form.priceOverrides || {})
      .map(([date, val]) => [date, parseFloat(val)])
      .filter(([, val]) => !isNaN(val) && val > 0);
    body.priceOverrides = Object.fromEntries(overrideEntries);
    if (rec.type === 'split' || rec.type === 'bonus') body.ratio = {
      old: parseFloat(form.ratio.old) || undefined, new: parseFloat(form.ratio.new) || undefined,
      existing: parseFloat(form.ratio.existing) || undefined, bonus: parseFloat(form.ratio.bonus) || undefined,
    };
    if (rec.type === 'demerger') body.demerger = {
      ...form.demerger,
      entitlementRatio: { resulting: parseFloat(form.demerger.entitlementRatio.resulting), parent: parseFloat(form.demerger.entitlementRatio.parent) },
      costAllocationPct: { parent: parseFloat(form.demerger.costAllocationPct.parent), resulting: parseFloat(form.demerger.costAllocationPct.resulting) },
      resultingWeight: form.demerger.resultingWeight === '' ? null : parseFloat(form.demerger.resultingWeight),
    };
    const resp = await authedFetch(`${API_BASE}/corporate-actions/${rec.id}`, { method: 'PUT', body: JSON.stringify(body) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || 'Recalculate failed');
    setEdit(false);
  });

  const doApprove = () => call(async () => {
    const resp = await authedFetch(`${API_BASE}/corporate-actions/${rec.id}/approve`, { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || 'Approve failed');
  });
  const doReject = () => call(async () => {
    const resp = await authedFetch(`${API_BASE}/corporate-actions/${rec.id}/reject`, { method: 'POST' });
    if (!resp.ok) throw new Error((await resp.json()).detail || 'Reject failed');
  });
  const doReverse = () => call(async () => {
    const resp = await authedFetch(`${API_BASE}/corporate-actions/${rec.id}/reverse`, { method: 'POST' });
    if (!resp.ok) throw new Error((await resp.json()).detail || 'Reverse failed');
  });

  const editable = isAdmin && (rec.status === 'pending_review' || rec.status === 'approved');
  const dm = form.demerger;

  return (
    <div style={box}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.92rem' }}>
            {rec.nseCode} <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>· {rec.type} · {rec.basketKey}</span>
          </div>
          <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
            Ex-date {rec.exDate}{rec.recordDate ? ` · Record date ${rec.recordDate}` : ''}
          </div>
        </div>
        <span style={{ fontSize: '0.68rem', fontWeight: 700, color: STATUS_COLORS[rec.status],
                       background: STATUS_COLORS[rec.status] + '22', padding: '0.2rem 0.6rem', borderRadius: '4px', whiteSpace: 'nowrap' }}>
          {rec.status.replace('_', ' ')}
        </span>
      </div>

      <ComparisonReport
        report={rec.comparisonReport} type={rec.type}
        editable={editable && edit}
        overrides={form.priceOverrides}
        onOverrideChange={setPriceOverride}
        onOverrideClear={clearPriceOverride}
      />

      {editable && edit && (
        <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: 'var(--input-bg)', borderRadius: '8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginBottom: '0.6rem' }}>
            <div><label style={label}>Ex-date</label><input style={input} value={form.exDate} onChange={e => setForm(f => ({ ...f, exDate: e.target.value }))} placeholder="DD Mon YYYY" /></div>
            <div><label style={label}>Record date</label><input style={input} value={form.recordDate} onChange={e => setForm(f => ({ ...f, recordDate: e.target.value }))} placeholder="DD Mon YYYY" /></div>
          </div>

          {rec.type === 'split' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginBottom: '0.6rem' }}>
              <div><label style={label}>Old face value</label><input style={input} type="number" value={form.ratio.old} onChange={e => setForm(f => ({ ...f, ratio: { ...f.ratio, old: e.target.value } }))} /></div>
              <div><label style={label}>New face value</label><input style={input} type="number" value={form.ratio.new} onChange={e => setForm(f => ({ ...f, ratio: { ...f.ratio, new: e.target.value } }))} /></div>
            </div>
          )}
          {rec.type === 'bonus' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginBottom: '0.6rem' }}>
              <div><label style={label}>Existing shares</label><input style={input} type="number" value={form.ratio.existing} onChange={e => setForm(f => ({ ...f, ratio: { ...f.ratio, existing: e.target.value } }))} /></div>
              <div><label style={label}>Bonus shares</label><input style={input} type="number" value={form.ratio.bonus} onChange={e => setForm(f => ({ ...f, ratio: { ...f.ratio, bonus: e.target.value } }))} /></div>
            </div>
          )}
          {rec.type === 'demerger' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginBottom: '0.6rem' }}>
              <div><label style={label}>Resulting company name</label><input style={input} value={dm.resultingCompanyName} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, resultingCompanyName: e.target.value } }))} /></div>
              <div><label style={label}>Resulting NSE code</label><input style={input} value={dm.resultingNseCode} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, resultingNseCode: e.target.value } }))} /></div>
              <div><label style={label}>Resulting ISIN</label><input style={input} value={dm.resultingIsin} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, resultingIsin: e.target.value } }))} /></div>
              <div><label style={label}>Resulting listed?</label>
                <select style={input} value={dm.resultingListed ? '1' : '0'} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, resultingListed: e.target.value === '1' } }))}>
                  <option value="0">Not listed yet</option><option value="1">Listed</option>
                </select>
              </div>
              <div><label style={label}>Entitlement — resulting shares</label><input style={input} type="number" value={dm.entitlementRatio.resulting} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, entitlementRatio: { ...f.demerger.entitlementRatio, resulting: e.target.value } } }))} /></div>
              <div><label style={label}>Entitlement — per parent shares</label><input style={input} type="number" value={dm.entitlementRatio.parent} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, entitlementRatio: { ...f.demerger.entitlementRatio, parent: e.target.value } } }))} /></div>
              <div><label style={label}>Cost allocation — parent %</label><input style={input} type="number" value={dm.costAllocationPct.parent} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, costAllocationPct: { ...f.demerger.costAllocationPct, parent: e.target.value } } }))} /></div>
              <div><label style={label}>Cost allocation — resulting %</label><input style={input} type="number" value={dm.costAllocationPct.resulting} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, costAllocationPct: { ...f.demerger.costAllocationPct, resulting: e.target.value } } }))} /></div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={label}>Resulting weight % (required before approval — admin judgment call)</label>
                <input style={input} type="number" value={dm.resultingWeight} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, resultingWeight: e.target.value } }))} placeholder="e.g. 1.0" />
              </div>
            </div>
          )}
          <button style={btn('#818cf8')} disabled={busy} onClick={doRecalc}>Recalculate</button>
        </div>
      )}

      {err && <div style={{ color: 'var(--accent-red)', fontSize: '0.78rem', marginTop: '0.5rem' }}>{err}</div>}

      {isAdmin && (
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
          {editable && <button style={btn('var(--text-secondary)')} disabled={busy} onClick={() => setEdit(v => !v)}>{edit ? 'Close edit' : 'Edit'}</button>}
          {rec.status === 'pending_review' && <button style={btn('#10b981')} disabled={busy} onClick={doApprove}>Approve</button>}
          {rec.status === 'pending_review' && <button style={btn('#ef4444')} disabled={busy} onClick={doReject}>Reject</button>}
          {rec.status === 'approved' && <button style={btn('#f87171')} disabled={busy} onClick={doReverse}>Reverse</button>}
        </div>
      )}
    </div>
  );
}

export default function CorporateActionsPage() {
  const [admin, setAdmin] = useState(null);
  const [records, setRecords] = useState([]);
  const [form, setForm] = useState(emptyForm());
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState('');
  const [filter, setFilter] = useState('all');
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState('');
  const [basketOptions, setBasketOptions] = useState([]);

  useEffect(() => { setAdmin(_getAdminState()); }, []);
  useEffect(() => {
    fetchBaskets().then(dict => setBasketOptions(Object.entries(dict || {}).map(([key, label]) => ({ key, label })))).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    const token = getAuthToken();
    const resp = await fetch(`${API_BASE}/corporate-actions`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (resp.ok) setRecords(await resp.json());
  }, []);

  useEffect(() => { if (admin) load(); }, [admin, load]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreating(true); setCreateErr('');
    try {
      const token = getAuthToken();
      const resp = await fetch(`${API_BASE}/corporate-actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(toApiBody(form)),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || 'Create failed');
      setForm(emptyForm());
      await load();
    } catch (err) {
      setCreateErr(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleScan = async () => {
    setScanning(true); setScanMsg('');
    try {
      const token = getAuthToken();
      const resp = await fetch(`${API_BASE}/corporate-actions/scan`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || 'Scan failed');
      setScanMsg(data.createdCount > 0
        ? `Found ${data.createdCount} new corporate action${data.createdCount === 1 ? '' : 's'} (from Yahoo Finance) — added below as pending review. Checked ${data.checkedStocks} stocks.`
        : `No new corporate actions found. Checked ${data.checkedStocks} stocks. (Demergers aren't auto-detected — enter those manually below.)`);
      await load();
    } catch (err) {
      setScanMsg(err.message);
    } finally {
      setScanning(false);
    }
  };

  if (admin === null) return null;
  const isAdmin = admin.isAdmin;

  const filtered = filter === 'all' ? records : records.filter(r => r.status === filter);
  const counts = records.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});

  return (
    <div style={{ padding: '1.5rem', maxWidth: '980px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.2rem' }}>
        <button style={btn('var(--text-secondary)')} onClick={() => { window.location.href = '/wp/' + window.location.search; }}>← Back</button>
        <div style={{ fontWeight: 700, fontSize: '1.15rem', color: 'var(--text-primary)' }}>
          <i className="fa-solid fa-code-branch" style={{ color: 'var(--accent-blue)', marginRight: '0.5rem' }} />
          Corporate Actions
        </div>
        {isAdmin && (
          <button style={btn('#818cf8')} disabled={scanning} onClick={handleScan}>
            {scanning ? 'Scanning…' : 'Scan for New Corporate Actions'}
          </button>
        )}
      </div>
      {scanMsg && (
        <div style={{ ...box, fontSize: '0.82rem', color: 'var(--text-secondary)', padding: '0.6rem 1rem' }}>{scanMsg}</div>
      )}

      {/* Create form — admin only */}
      {isAdmin && (
      <form onSubmit={handleCreate} style={box}>
        <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.75rem' }}>Create corporate action</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.6rem', marginBottom: '0.6rem' }}>
          <div>
            <label style={label}>Client</label>
            <select style={input} value={form.basketKey} onChange={e => setForm(f => ({ ...f, basketKey: e.target.value }))}>
              {basketOptions.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
            </select>
          </div>
          <div>
            <label style={label}>NSE code</label>
            <input style={input} value={form.nseCode} onChange={e => setForm(f => ({ ...f, nseCode: e.target.value }))} placeholder="e.g. WAAREEENER" required />
          </div>
          <div>
            <label style={label}>Type</label>
            <select style={input} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
              <option value="split">Stock Split</option>
              <option value="bonus">Bonus Issue</option>
              <option value="demerger">Demerger</option>
            </select>
          </div>
          <div>
            <label style={label}>Security name (optional)</label>
            <input style={input} value={form.securityName} onChange={e => setForm(f => ({ ...f, securityName: e.target.value }))} />
          </div>
          <div>
            <label style={label}>Ex-date</label>
            <input style={input} value={form.exDate} onChange={e => setForm(f => ({ ...f, exDate: e.target.value }))} placeholder="DD Mon YYYY" required />
          </div>
          <div>
            <label style={label}>Record date (optional)</label>
            <input style={input} value={form.recordDate} onChange={e => setForm(f => ({ ...f, recordDate: e.target.value }))} placeholder="DD Mon YYYY" />
          </div>
        </div>

        {form.type === 'split' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginBottom: '0.6rem' }}>
            <div><label style={label}>Old face value</label><input style={input} type="number" value={form.ratio.old} onChange={e => setForm(f => ({ ...f, ratio: { ...f.ratio, old: e.target.value } }))} required /></div>
            <div><label style={label}>New face value</label><input style={input} type="number" value={form.ratio.new} onChange={e => setForm(f => ({ ...f, ratio: { ...f.ratio, new: e.target.value } }))} required /></div>
          </div>
        )}
        {form.type === 'bonus' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginBottom: '0.6rem' }}>
            <div><label style={label}>Existing shares</label><input style={input} type="number" value={form.ratio.existing} onChange={e => setForm(f => ({ ...f, ratio: { ...f.ratio, existing: e.target.value } }))} required /></div>
            <div><label style={label}>Bonus shares</label><input style={input} type="number" value={form.ratio.bonus} onChange={e => setForm(f => ({ ...f, ratio: { ...f.ratio, bonus: e.target.value } }))} required /></div>
          </div>
        )}
        {form.type === 'demerger' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.6rem', marginBottom: '0.6rem' }}>
            <div><label style={label}>Resulting company name</label><input style={input} value={form.demerger.resultingCompanyName} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, resultingCompanyName: e.target.value } }))} required /></div>
            <div><label style={label}>Resulting NSE code (if known)</label><input style={input} value={form.demerger.resultingNseCode} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, resultingNseCode: e.target.value } }))} /></div>
            <div><label style={label}>Entitlement — resulting shares</label><input style={input} type="number" value={form.demerger.entitlementRatio.resulting} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, entitlementRatio: { ...f.demerger.entitlementRatio, resulting: e.target.value } } }))} required /></div>
            <div><label style={label}>Entitlement — per parent shares</label><input style={input} type="number" value={form.demerger.entitlementRatio.parent} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, entitlementRatio: { ...f.demerger.entitlementRatio, parent: e.target.value } } }))} required /></div>
            <div><label style={label}>Cost allocation — parent %</label><input style={input} type="number" value={form.demerger.costAllocationPct.parent} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, costAllocationPct: { ...f.demerger.costAllocationPct, parent: e.target.value } } }))} required /></div>
            <div><label style={label}>Cost allocation — resulting %</label><input style={input} type="number" value={form.demerger.costAllocationPct.resulting} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, costAllocationPct: { ...f.demerger.costAllocationPct, resulting: e.target.value } } }))} required /></div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={label}>Resulting weight % (optional now — must be set before approval)</label>
              <input style={input} type="number" value={form.demerger.resultingWeight} onChange={e => setForm(f => ({ ...f, demerger: { ...f.demerger, resultingWeight: e.target.value } }))} placeholder="e.g. 1.0" />
            </div>
          </div>
        )}

        {createErr && <div style={{ color: 'var(--accent-red)', fontSize: '0.8rem', marginBottom: '0.5rem' }}>{createErr}</div>}
        <button type="submit" style={btn('#818cf8')} disabled={creating}>{creating ? 'Creating…' : 'Create (pending review)'}</button>
      </form>
      )}

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
        {['all', 'pending_review', 'approved', 'rejected', 'reversed'].map(s => (
          <button key={s} onClick={() => setFilter(s)}
            style={{ ...btn(filter === s ? '#818cf8' : 'var(--text-secondary)'), fontWeight: filter === s ? 700 : 500 }}>
            {s === 'all' ? 'All' : s.replace('_', ' ')} {s !== 'all' ? `(${counts[s] || 0})` : `(${records.length})`}
          </button>
        ))}
      </div>

      {filtered.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: '0.84rem' }}>No corporate actions in this view.</div>}
      {filtered.map(rec => <RecordCard key={rec.id} rec={rec} onChanged={load} isAdmin={isAdmin} />)}
    </div>
  );
}
