export default function ConfirmModal({ title, message, onConfirm, onCancel }) {
  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onCancel();
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal-box">
        <div className="modal-icon">&#9888;&#65039;</div>
        <div className="modal-title">{title}</div>
        <div
          className="modal-message"
          dangerouslySetInnerHTML={{ __html: message.replace(/\n/g, '<br>') }}
        />
        <div className="modal-actions">
          <button className="btn-confirm-yes" onClick={onConfirm}>
            Confirm
          </button>
          <button className="btn-confirm-no" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
