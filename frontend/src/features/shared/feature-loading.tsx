export function FeatureLoading({ label }: { label: string }) {
  return (
    <div className="feature-loading" role="status">
      <span className="thinking" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>正在加载{label}</span>
    </div>
  );
}
