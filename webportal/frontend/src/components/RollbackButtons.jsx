import { API_BASE, getAuthToken } from '../api/base.js';
import { useState, useEffect } from 'react';

function useRollback() {
  const [rbkPoint, setRbkPoint] = useState(null);
  const [rbkMsg,   setRbkMsg]   = useState('');

  useEffect(() => {
    fetch(`${API_BASE}/rollback-points`)
      .then(r => r.json())
      .then(pts => setRbkPoint(pts.length ? pts[pts.length - 1] : null))
      .catch(() => {});
  }, []);

  const handleRestore = async () => {
    if (!rbkPoint) return;
    if (!window.confirm(`Rollback to previous version?\n(Saved: ${rbkPoint.createdAt})\n\nThis will undo all changes made after that point.`)) return;
    setRbkMsg('Restoring…');
    try {
      const token = getAuthToken();
      const resp = await fetch(`${API_BASE}/rollback-points/${rbkPoint.id}/restore`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || 'Failed');
      setRbkMsg('Done. Reloading…');
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      setRbkMsg('Error: ' + err.message);
    }
  };

  return { rbkPoint, rbkMsg, handleRestore };
}

export default function RollbackButtons({ btnStyle = 'bp' }) {
  const { rbkPoint, rbkMsg, handleRestore } = useRollback();

  const isHeader = btnStyle === 'header';
  const active   = !!rbkPoint;

  const btnCss = isHeader
    ? {
        background:  active ? 'rgba(251,191,36,0.12)' : 'transparent',
        color:       active ? 'var(--accent-amber)' : 'var(--text-secondary)',
        border:      `1px solid ${active ? 'rgba(251,191,36,0.3)' : 'rgba(71,85,105,0.3)'}`,
        borderRadius: '7px', padding: '0.32rem 0.7rem',
        fontSize: '0.82rem', fontWeight: 600,
        cursor: active ? 'pointer' : 'default',
        display: 'flex', alignItems: 'center', gap: '0.35rem',
        whiteSpace: 'nowrap', flexShrink: 0,
      }
    : {
        background:  active ? 'rgba(251,191,36,0.1)' : 'transparent',
        color:       active ? 'var(--accent-amber)' : 'var(--text-secondary)',
        borderColor: active ? 'rgba(251,191,36,0.3)' : 'rgba(71,85,105,0.3)',
      };

  return (
    <>
      <button
        onClick={handleRestore}
        disabled={!active}
        title={active ? `Rollback to: ${rbkPoint.createdAt}` : 'No rollback point yet — make any change first'}
        className={isHeader ? undefined : 'bp-save-btn'}
        style={btnCss}
      >
        <i className="fa-solid fa-clock-rotate-left" />
        {active ? `Rollback (${rbkPoint.createdAt})` : 'Rollback'}
      </button>

      {rbkMsg && (
        <span style={{ fontSize: '0.78rem', color: rbkMsg.startsWith('Error') ? 'var(--accent-red)' : 'var(--accent-green)', whiteSpace: 'nowrap' }}>
          {rbkMsg}
        </span>
      )}
    </>
  );
}
