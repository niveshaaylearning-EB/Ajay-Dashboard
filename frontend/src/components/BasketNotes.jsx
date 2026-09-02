import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { FileText, Check } from 'lucide-react';

import { API_BASE } from '../config.js';

export default function BasketNotes({ basketId }) {
  const [open,      setOpen]      = useState(false);
  const [text,      setText]      = useState('');
  const [savedText, setSavedText] = useState('');
  const [updatedAt, setUpdatedAt] = useState('');
  const [saving,    setSaving]    = useState(false);
  const [saved,     setSaved]     = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!basketId) return;
    axios.get(`${API_BASE}/basket-notes/${basketId}`)
      .then(r => { setText(r.data.note_text || ''); setSavedText(r.data.note_text || ''); setUpdatedAt(r.data.updated_at || ''); })
      .catch(() => {});
  }, [basketId]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await axios.post(`${API_BASE}/basket-notes/${basketId}`, { note_text: text });
      setSavedText(text);
      setUpdatedAt(r.data.updated_at);
      setSaved(true);
      timerRef.current = setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = text !== savedText;

  return (
    <div style={{ marginBottom: '16px' }}>
      <button
        className="btn btn-secondary"
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem' }}
      >
        <FileText size={15} color={savedText ? 'var(--positive)' : 'var(--text-muted)'} />
        {savedText ? 'Basket Notes' : 'Add Notes'}
        {savedText && <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--positive)', display: 'inline-block' }} />}
      </button>

      {open && (
        <div style={{
          marginTop: '10px', padding: '16px', background: 'rgba(20,27,45,0.8)',
          border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px',
        }}>
          <textarea
            rows={4}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Investment thesis, key risks, last reviewed date, notes for this basket…"
            style={{ width: '100%', resize: 'vertical', marginBottom: '10px' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            {updatedAt && <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Last saved: {updatedAt}</span>}
            <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto' }}>
              {saved && <span style={{ color: 'var(--positive)', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: '4px' }}><Check size={14} /> Saved</span>}
              <button
                className="btn btn-primary"
                onClick={save}
                disabled={saving || !hasChanges}
                style={{ padding: '6px 16px', fontSize: '0.82rem' }}
              >
                {saving ? 'Saving…' : 'Save Notes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
