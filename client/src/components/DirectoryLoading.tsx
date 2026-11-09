/** 插件和连接器目录首次加载时的动画状态。 */
export function DirectoryLoading({ label, hint }: { label: string; hint?: string }) {
  return (
    <section className="directory-loading" role="status" aria-live="polite">
      <div className="directory-motion" aria-hidden="true">
        <div className="directory-motion-line left" />
        <div className="directory-motion-line right" />
        <div className="directory-motion-tiles">
          <span className="directory-motion-tile tile-one" />
          <span className="directory-motion-tile tile-two" />
          <span className="directory-motion-tile tile-three" />
          <span className="directory-motion-tile tile-four" />
        </div>
        <div className="directory-motion-shadow" />
      </div>
      <div className="directory-loading-label">{label}<span className="directory-loading-dots" aria-hidden="true"><i /><i /><i /></span></div>
      {hint && <div className="directory-loading-hint">{hint}</div>}
    </section>
  );
}
