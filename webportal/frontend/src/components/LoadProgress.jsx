export default function LoadProgress({ loaded, total }) {
  const pct = total > 0 ? (loaded / total) * 100 : 0;

  return (
    <div className="load-banner">
      <span>{loaded} / {total} stocks loaded</span>
      <div className="load-progress-bar">
        <div className="load-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
