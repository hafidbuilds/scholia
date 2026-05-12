import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { openBook } from "./api";
import type { BookSummary, ContentNode, SpineItem, TocNode } from "./types";

function App() {
  const [path, setPath] = useState("");
  const [book, setBook] = useState<BookSummary | null>(null);
  const [activeSpineId, setActiveSpineId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const activeSpine = useMemo(() => {
    if (!book) return null;
    return (
      book.spine.find((item) => item.id === activeSpineId) ??
      book.spine.find((item) => item.linear) ??
      book.spine[0] ??
      null
    );
  }, [activeSpineId, book]);

  async function handleOpen(event: React.FormEvent) {
    event.preventDefault();
    if (!path.trim()) return;

    setLoading(true);
    setError(null);
    try {
      const opened = await openBook(path.trim());
      setBook(opened);
      setActiveSpineId(opened.spine[0]?.id ?? null);
    } catch (err) {
      setBook(null);
      setActiveSpineId(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Scholia</h1>
          <p>Desktop EPUB study companion</p>
        </div>
        <form className="open-form" onSubmit={handleOpen}>
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/path/to/book.epub"
            aria-label="EPUB file path"
          />
          <button disabled={loading || !path.trim()} type="submit">
            {loading ? "Opening" : "Open EPUB"}
          </button>
        </form>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      {book ? (
        <section className="workspace">
          <aside className="toc-panel">
            <BookMeta book={book} />
            <h2>Contents</h2>
            {book.toc.length > 0 ? (
              <TocList
                nodes={book.toc}
                spine={book.spine}
                activeSpineId={activeSpine?.id ?? null}
                onSelect={setActiveSpineId}
              />
            ) : (
              <SpineList
                spine={book.spine}
                activeSpineId={activeSpine?.id ?? null}
                onSelect={setActiveSpineId}
              />
            )}
          </aside>

          <Reader spine={activeSpine} />
        </section>
      ) : (
        <section className="empty-state">
          <h2>Open a DRM-free EPUB to inspect its semantic structure.</h2>
          <p>
            Milestone 2 renders the parsed spine and table of contents from the
            Rust ingestion layer.
          </p>
        </section>
      )}
    </main>
  );
}

function BookMeta({ book }: { book: BookSummary }) {
  return (
    <section className="book-meta">
      <h2>{book.title}</h2>
      <p>{book.authors.join(", ")}</p>
      {book.language ? <span>{book.language}</span> : null}
    </section>
  );
}

function TocList({
  nodes,
  spine,
  activeSpineId,
  onSelect,
}: {
  nodes: TocNode[];
  spine: SpineItem[];
  activeSpineId: string | null;
  onSelect: (spineId: string) => void;
}) {
  return (
    <nav className="toc-list">
      {nodes.map((node) => {
        const spineItem = spine.find((item) => item.href === node.href);
        const isActive = spineItem?.id === activeSpineId;
        return (
          <button
            key={node.id}
            className={isActive ? "active" : ""}
            disabled={!spineItem}
            onClick={() => spineItem && onSelect(spineItem.id)}
            type="button"
          >
            {node.title}
          </button>
        );
      })}
    </nav>
  );
}

function SpineList({
  spine,
  activeSpineId,
  onSelect,
}: {
  spine: SpineItem[];
  activeSpineId: string | null;
  onSelect: (spineId: string) => void;
}) {
  return (
    <nav className="toc-list">
      {spine.map((item) => (
        <button
          key={item.id}
          className={item.id === activeSpineId ? "active" : ""}
          onClick={() => onSelect(item.id)}
          type="button"
        >
          {item.title || item.href}
        </button>
      ))}
    </nav>
  );
}

function Reader({ spine }: { spine: SpineItem | null }) {
  if (!spine) {
    return (
      <article className="reader">
        <p>No readable spine content was found.</p>
      </article>
    );
  }

  return (
    <article className="reader">
      <header className="reader-header">
        <span>{spine.href}</span>
        <strong>{spine.content.nodes.length} nodes</strong>
      </header>
      <div className="reader-content">
        {spine.content.nodes.map((node) => (
          <ContentBlock key={node.id} node={node} />
        ))}
      </div>
    </article>
  );
}

function ContentBlock({ node }: { node: ContentNode }) {
  const common = {
    "data-node-id": node.id,
    "data-source-href": node.source.href,
  };

  switch (node.kind) {
    case "heading": {
      const level = Math.min(Math.max(node.level ?? 2, 1), 6);
      return React.createElement(`h${level}`, common, node.text);
    }
    case "paragraph":
      return <p {...common}>{node.text}</p>;
    case "blockquote":
      return <blockquote {...common}>{node.text}</blockquote>;
    case "code":
      return (
        <pre {...common}>
          <code>{node.text}</code>
        </pre>
      );
    case "list":
      return (
        <ul {...common}>
          {node.children.map((child) => (
            <li key={child.id} data-node-id={child.id}>
              {child.text}
            </li>
          ))}
        </ul>
      );
    case "image":
      return (
        <figure {...common}>
          <div className="image-placeholder">Image omitted</div>
          {node.text ? <figcaption>{node.text}</figcaption> : null}
        </figure>
      );
    case "thematicBreak":
      return <hr {...common} />;
    default:
      return (
        <section className="unsupported-node" {...common}>
          {node.text || node.kind}
        </section>
      );
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
