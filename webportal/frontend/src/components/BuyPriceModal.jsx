const BASKET_DISPLAY_NAMES = {
  Green_Energy:     'Green Energy',
  Mid_Small_Cap:    'Mid & Small Cap',
  IPO_Basket:       'IPO Basket',
  Trends_Triology:  'Trends Triology',
  Techstack:        'Techstack',
  Make_in_India:    'Make in India',
  Consumer_Trends:  'Consumer Trends',
};

export default function BuyPriceModal({ basketKey, basketMeta, onClose }) {
  const details  = basketMeta?.buyPriceDetails || {};
  const entries  = Object.entries(details);
  const label    = BASKET_DISPLAY_NAMES[basketKey] || basketKey;

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="bp-modal-box">
        <div className="bp-modal-header">
          <h3>Buy Price Data &mdash; <span>{label}</span></h3>
          <button className="bp-close-btn" onClick={onClose} title="Close">
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        <div className="bp-table-wrap">
          {entries.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
              No buy price data available for this basket.
            </div>
          ) : (
            <table className="bp-table">
              <thead>
                <tr>
                  <th>NSE Code</th>
                  <th>Security Name</th>
                  <th>Segment</th>
                  <th>Buy Events</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(([nse, info]) => (
                  <tr key={nse}>
                    <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{nse}</td>
                    <td style={{ textAlign: 'left' }}>
                      {info.securityName || (
                        <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic', fontSize: '0.8rem' }}>Auto-fetch</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                      {info.segment || '\u2014'}
                    </td>
                    <td style={{ textAlign: 'left', fontSize: '0.82rem', whiteSpace: 'pre-line' }}>
                      {info.buyEvents || (
                        <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>No data</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
