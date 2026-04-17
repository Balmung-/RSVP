export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-ink-50 px-6">
      <div className="panel p-12 text-center max-w-sm">
        <div className="inline-flex items-center gap-2 text-ink-400 mb-6">
          <span className="h-1.5 w-1.5 rounded-full bg-ink-900" />
          <span className="text-xs tracking-wider uppercase">Invitation</span>
        </div>
        <h1 className="text-lg font-medium tracking-tight">This invitation is no longer valid.</h1>
        <p className="text-sm text-ink-500 mt-2">
          The link may be incorrect or the campaign has been archived.
        </p>
      </div>
    </div>
  );
}
