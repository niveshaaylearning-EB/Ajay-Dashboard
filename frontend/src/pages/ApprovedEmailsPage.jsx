import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { ArrowLeft, Users, UserPlus, Trash2, User, Clock, CheckCircle, XCircle } from 'lucide-react';
import { getToken } from '../utils/auth';
import { API_BASE as API, API_ROOT } from '../config.js';

export default function ApprovedEmailsPage() {
  const navigate = useNavigate();
  const [emails,    setEmails]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [newEmail,  setNewEmail]  = useState('');
  const [adding,    setAdding]    = useState(false);
  const [removing,  setRemoving]  = useState('');
  const [error,     setError]     = useState('');
  const [success,   setSuccess]   = useState('');
  const [reapprovingAll, setReapprovingAll] = useState(false);

  // Pending access requests (old flow)
  const [requests,      setRequests]      = useState([]);
  const [reqLoading,    setReqLoading]    = useState(true);
  const [processingId,  setProcessingId]  = useState(null);

  // Pending self-registrations (new flow)
  const [pendingRegs,       setPendingRegs]       = useState([]);
  const [pendingRegsLoading, setPendingRegsLoading] = useState(true);
  const [processingReg,     setProcessingReg]     = useState('');

  const load = useCallback(() => {
    setLoading(true);
    axios.get(`${API}/allowed-emails`)
      .then(r => setEmails(r.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const loadRequests = useCallback(() => {
    setReqLoading(true);
    axios.get(`${API}/access-requests`)
      .then(r => setRequests(r.data || []))
      .catch(() => setRequests([]))
      .finally(() => setReqLoading(false));
  }, []);

  const loadPendingRegs = useCallback(() => {
    setPendingRegsLoading(true);
    axios.get(`${API_ROOT}/auth/admin/pending-registrations`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then(r => setPendingRegs(r.data || []))
      .catch(() => setPendingRegs([]))
      .finally(() => setPendingRegsLoading(false));
  }, []);

  useEffect(() => { load(); loadRequests(); loadPendingRegs(); }, [load, loadRequests, loadPendingRegs]);

  const handleApproveReg = async (email) => {
    setProcessingReg(email);
    try {
      await axios.post(`${API_ROOT}/auth/admin/approve-registration`, { email }, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      setSuccess(`${email} approved.`);
      loadPendingRegs(); load();
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to approve.');
    } finally { setProcessingReg(''); }
  };

  const handleRejectReg = async (email) => {
    setProcessingReg(email);
    try {
      await axios.post(`${API_ROOT}/auth/admin/reject-registration`, { email }, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      setSuccess(`${email} registration rejected.`);
      loadPendingRegs();
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to reject.');
    } finally { setProcessingReg(''); }
  };

  const handleApprove = async (id, email) => {
    setProcessingId(id);
    try {
      await axios.post(`${API}/access-requests/${id}/approve`);
      setSuccess(`${email} approved and added.`);
      loadRequests(); load();
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to approve.');
    } finally { setProcessingId(null); }
  };

  const handleReject = async (id, email) => {
    setProcessingId(id);
    try {
      await axios.post(`${API}/access-requests/${id}/reject`);
      setSuccess(`${email} request rejected.`);
      loadRequests();
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to reject.');
    } finally { setProcessingId(null); }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    const em = newEmail.toLowerCase().trim();
    if (!em.endsWith('@niveshaay.com')) {
      setError('Only @niveshaay.com emails allowed');
      return;
    }
    setAdding(true);
    try {
      await axios.post(`${API}/allowed-emails`, { email: em });
      setSuccess(`${em} has been approved`);
      setNewEmail('');
      load();
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to add');
    } finally { setAdding(false); }
  };

  const handleReapproveAll = async () => {
    setError(''); setSuccess('');
    setReapprovingAll(true);
    try {
      const resp = await axios.post(`${API}/allowed-emails/reapprove-all`);
      const count = resp.data?.count ?? 0;
      setSuccess(count > 0
        ? `Re-approved ${count} email(s) that were stuck pending: ${resp.data.reapproved.join(', ')}`
        : 'Everyone in this list is already approved -- nothing to fix.');
      load();
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to re-approve all');
    } finally { setReapprovingAll(false); }
  };

  const handleRemove = async (email) => {
    setError(''); setSuccess('');
    setRemoving(email);
    try {
      await axios.delete(`${API}/allowed-emails/${encodeURIComponent(email)}`);
      setSuccess(`${email} removed`);
      load();
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to remove');
    } finally { setRemoving(''); }
  };

  return (
    <div className="animate-slide-up" style={{ maxWidth: 640, margin: '0 auto', padding: '0 1rem 3rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '28px' }}>
        <button
          className="btn btn-secondary"
          onClick={() => navigate('/')}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px' }}
        >
          <ArrowLeft size={16} /> Back
        </button>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Users size={20} color="var(--primary)" />
            <h2 className="text-gradient" style={{ margin: 0, fontSize: '1.5rem' }}>Approved Login Emails</h2>
          </div>
          <p style={{ color: 'var(--text-muted)', margin: '4px 0 0', fontSize: '0.85rem' }}>
            Only @niveshaay.com addresses listed here can log in to the dashboard.
          </p>
        </div>
      </div>

      {/* Add new email */}
      <div className="glass-panel" style={{ padding: '20px 24px', marginBottom: '20px' }}>
        <h4 style={{ margin: '0 0 14px', color: 'var(--text-main)', fontSize: '0.9rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '7px' }}>
          <UserPlus size={15} color="var(--primary)" /> Add new user
        </h4>
        <form onSubmit={handleAdd} style={{ display: 'flex', gap: '10px' }}>
          <input
            type="email"
            value={newEmail}
            onChange={e => setNewEmail(e.target.value)}
            placeholder="name@niveshaay.com"
            style={{
              flex: 1, padding: '10px 14px',
              borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.05)', color: 'var(--text-main)',
              fontSize: '0.88rem', outline: 'none', fontFamily: 'inherit',
            }}
          />
          <button
            type="submit"
            disabled={adding || !newEmail.trim()}
            className="btn btn-primary"
            style={{ padding: '10px 20px', whiteSpace: 'nowrap' }}
          >
            {adding ? 'Adding…' : 'Approve'}
          </button>
        </form>

        {error   && <div style={{ marginTop: '10px', padding: '8px 12px', borderRadius: '8px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--negative)', fontSize: '0.83rem' }}>{error}</div>}
        {success && <div style={{ marginTop: '10px', padding: '8px 12px', borderRadius: '8px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', color: 'var(--positive)', fontSize: '0.83rem' }}>{success}</div>}
      </div>

      {/* ── Pending Self-Registrations ── */}
      <div className="glass-panel" style={{ padding: 0, overflow: 'hidden', marginBottom: '20px', border: '1px solid rgba(99,102,241,0.25)' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(99,102,241,0.06)' }}>
          <UserPlus size={15} color="var(--primary)" />
          <span style={{ fontWeight: 700, color: 'var(--primary)', fontSize: '0.88rem' }}>Pending Registrations</span>
          <span style={{ fontSize: '0.72rem', background: 'rgba(99,102,241,0.2)', color: 'var(--primary)', borderRadius: '10px', padding: '2px 8px', fontWeight: 700 }}>
            {pendingRegs.length}
          </span>
        </div>
        {pendingRegsLoading ? (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading…</div>
        ) : pendingRegs.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>No pending registrations.</div>
        ) : pendingRegs.map((reg, i) => (
          <div key={reg.email} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 20px',
            background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
            borderBottom: i < pendingRegs.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <User size={14} color="var(--primary)" />
              <div>
                <div style={{ color: 'var(--text-main)', fontSize: '0.88rem' }}>
                  {reg.first_name} {reg.last_name}
                  <span style={{ color: 'var(--text-muted)', marginLeft: '6px', fontSize: '0.8rem' }}>({reg.email})</span>
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                  Registered {reg.added_at ? new Date(reg.added_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : '—'} IST
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => handleApproveReg(reg.email)}
                disabled={processingReg === reg.email}
                style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 14px', borderRadius: '7px', border: '1px solid rgba(16,185,129,0.35)', background: 'rgba(16,185,129,0.1)', color: 'var(--positive)', fontSize: '0.78rem', cursor: processingReg === reg.email ? 'not-allowed' : 'pointer', opacity: processingReg === reg.email ? 0.5 : 1 }}
              >
                <CheckCircle size={12} /> Approve
              </button>
              <button
                onClick={() => handleRejectReg(reg.email)}
                disabled={processingReg === reg.email}
                style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 14px', borderRadius: '7px', border: '1px solid rgba(239,68,68,0.28)', background: 'rgba(239,68,68,0.08)', color: 'var(--negative)', fontSize: '0.78rem', cursor: processingReg === reg.email ? 'not-allowed' : 'pointer', opacity: processingReg === reg.email ? 0.5 : 1 }}
              >
                <XCircle size={12} /> Reject
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Pending Access Requests — always visible to admin ── */}
      {(
        <div className="glass-panel" style={{ padding: 0, overflow: 'hidden', marginBottom: '20px', border: '1px solid rgba(251,191,36,0.25)' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(251,191,36,0.06)' }}>
            <Clock size={15} color="#fbbf24" />
            <span style={{ fontWeight: 700, color: 'var(--accent-amber)', fontSize: '0.88rem' }}>Pending Access Requests</span>
            <span style={{ fontSize: '0.72rem', background: 'rgba(251,191,36,0.2)', color: 'var(--accent-amber)', borderRadius: '10px', padding: '2px 8px', fontWeight: 700 }}>
              {requests.length}
            </span>
          </div>
          {reqLoading ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading…</div>
          ) : requests.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>No pending requests.</div>
          ) : requests.map((req, i) => (
            <div key={req.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 20px',
              background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
              borderBottom: i < requests.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <User size={14} color="#fbbf24" />
                <div>
                  <div style={{ color: 'var(--text-main)', fontSize: '0.88rem' }}>{req.email}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                    Requested {new Date(req.requested_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })} IST
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => handleApprove(req.id, req.email)}
                  disabled={processingId === req.id}
                  style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 14px', borderRadius: '7px', border: '1px solid rgba(16,185,129,0.35)', background: 'rgba(16,185,129,0.1)', color: 'var(--positive)', fontSize: '0.78rem', cursor: processingId === req.id ? 'not-allowed' : 'pointer', opacity: processingId === req.id ? 0.5 : 1 }}
                >
                  <CheckCircle size={12} /> Approve
                </button>
                <button
                  onClick={() => handleReject(req.id, req.email)}
                  disabled={processingId === req.id}
                  style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 14px', borderRadius: '7px', border: '1px solid rgba(239,68,68,0.28)', background: 'rgba(239,68,68,0.08)', color: 'var(--negative)', fontSize: '0.78rem', cursor: processingId === req.id ? 'not-allowed' : 'pointer', opacity: processingId === req.id ? 0.5 : 1 }}
                >
                  <XCircle size={12} /> Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Approved Emails list ── */}
      <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontWeight: 600, color: 'var(--text-main)', fontSize: '0.88rem' }}>Approved users</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '2px 8px' }}>
              {emails.length} total
            </span>
          </div>
          <button
            onClick={handleReapproveAll}
            disabled={reapprovingAll}
            title="Fixes any user in this list stuck unable to log in without needing to remove and re-add them"
            style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 14px', borderRadius: '7px', border: '1px solid rgba(16,185,129,0.35)', background: 'rgba(16,185,129,0.1)', color: 'var(--positive)', fontSize: '0.78rem', fontWeight: 600, cursor: reapprovingAll ? 'not-allowed' : 'pointer', opacity: reapprovingAll ? 0.5 : 1 }}
          >
            <CheckCircle size={12} /> {reapprovingAll ? 'Re-approving…' : 'Re-approve all'}
          </button>
        </div>

        {loading ? (
          <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.88rem' }}>Loading…</div>
        ) : emails.length === 0 ? (
          <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.88rem' }}>No approved emails yet.</div>
        ) : (
          emails.map((em, i) => {
            const emailStr = em?.email || em;
            return (
              <div key={emailStr} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 20px',
                background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
                borderBottom: i < emails.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <User size={14} color="var(--primary)" />
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-main)', fontSize: '0.88rem' }}>{emailStr}</span>
                    {em?.is_approved === false && (
                      <span style={{ marginLeft: '8px', fontSize: '0.68rem', fontWeight: 700, color: 'var(--accent-amber)', background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '4px', padding: '1px 6px' }}>
                        PENDING -- can't log in yet
                      </span>
                    )}
                    {em?.added_at && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '1px' }}>Added {em.added_at.slice(0, 10)}</div>}
                  </div>
                </div>
                <button
                  onClick={() => handleRemove(emailStr)}
                  disabled={removing === emailStr}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '5px',
                    padding: '5px 12px', borderRadius: '7px',
                    border: '1px solid rgba(239,68,68,0.28)',
                    background: 'rgba(239,68,68,0.08)',
                    color: 'var(--negative)', fontSize: '0.78rem', cursor: removing === emailStr ? 'not-allowed' : 'pointer',
                    opacity: removing === emailStr ? 0.5 : 1,
                  }}
                >
                  <Trash2 size={12} /> {removing === emailStr ? 'Removing…' : 'Remove'}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
