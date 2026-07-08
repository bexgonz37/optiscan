export default function SettingsLoading() {
  return (
    <div className="page-loading" aria-busy="true" aria-label="Loading settings">
      <div className="page-loading-bar" />
      <p className="muted">Loading settings…</p>
    </div>
  );
}
