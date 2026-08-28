export function MessageListSkeleton() {
  return (
    <div className="message-list-skeleton" aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton avatar" />
          <span className="skeleton lines">
            <i />
            <i />
            <i />
          </span>
        </div>
      ))}
    </div>
  );
}

export function ReaderSkeleton() {
  return (
    <div className="reader-skeleton" role="status" aria-label="Loading message">
      <span className="skeleton title" />
      <span className="skeleton sender" />
      <span className="skeleton body" />
      <span className="skeleton body short" />
    </div>
  );
}
