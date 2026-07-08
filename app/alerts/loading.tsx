export default function AlertsLoading() {
  return (
    <div className="page-loading" aria-busy="true" aria-label="Loading alerts">
      <div className="page-loading-bar" />
      <p className="muted">Loading alerts…</p>
    </div>
  );
}
