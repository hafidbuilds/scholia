import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { generateStudyPacket, openBook } from "./api";
import type {
  BookSummary,
  BudgetPreset,
  ChunkingMode,
  ContentNode,
  GeneratedMarkdown,
  GeneratedMarkdownChunk,
  ModelProfile,
  SpineItem,
  TaskMode,
  TocNode,
} from "./types";

const taskOptions: Array<{ value: TaskMode; label: string }> = [
  { value: "explain", label: "Explain concept" },
  { value: "term", label: "Explain term" },
  { value: "analogy", label: "Analogy" },
  { value: "diagram", label: "Diagram prompt" },
  { value: "quiz", label: "Quiz me" },
  { value: "exercises", label: "Exercises" },
  { value: "check", label: "Check understanding" },
  { value: "summarize", label: "Summarize" },
  { value: "definitions", label: "Definitions" },
  { value: "technical", label: "Technical details" },
  { value: "compare", label: "Compare concepts" },
  { value: "flashcards", label: "Flashcards" },
  { value: "custom", label: "Custom" },
];

const modelProfiles: Array<{ value: ModelProfile; label: string }> = [
  { value: "generic", label: "Generic LLM" },
  { value: "chatgpt", label: "ChatGPT" },
  { value: "claude", label: "Claude" },
];

const budgetOptions: Array<{ value: BudgetPreset; label: string }> = [
  { value: "small", label: "Small (~4k)" },
  { value: "medium", label: "Medium (~12k)" },
  { value: "large", label: "Large (~32k)" },
  { value: "xl", label: "XL (~100k)" },
  { value: "custom", label: "Custom" },
];

const chunkingOptions: Array<{ value: ChunkingMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "none", label: "None" },
  { value: "force", label: "Force" },
];

function App() {
  const [path, setPath] = useState("");
  const [book, setBook] = useState<BookSummary | null>(null);
  const [activeSpineId, setActiveSpineId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [markdownPacket, setMarkdownPacket] = useState<GeneratedMarkdown | null>(
    null,
  );
  const [markdownLoading, setMarkdownLoading] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [taskMode, setTaskMode] = useState<TaskMode>("summarize");
  const [modelProfile, setModelProfile] = useState<ModelProfile>("generic");
  const [budgetPreset, setBudgetPreset] = useState<BudgetPreset>("medium");
  const [customBudgetTokens, setCustomBudgetTokens] = useState(12000);
  const [chunking, setChunking] = useState<ChunkingMode>("auto");
  const [customInstruction, setCustomInstruction] = useState("");
  const [selectedChunkIndex, setSelectedChunkIndex] = useState(0);

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
      setMarkdownPacket(null);
      setCopyState("idle");
      setSelectedChunkIndex(0);
    } catch (err) {
      setBook(null);
      setActiveSpineId(null);
      setMarkdownPacket(null);
      setSelectedChunkIndex(0);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectSpine(spineId: string) {
    setActiveSpineId(spineId);
    setMarkdownPacket(null);
    setCopyState("idle");
    setSelectedChunkIndex(0);
  }

  async function handleGenerateMarkdown() {
    if (!activeSpine || !path.trim()) return;

    setMarkdownLoading(true);
    setError(null);
    setCopyState("idle");
    try {
      const packet = await generateStudyPacket(path.trim(), activeSpine.id, {
        taskMode,
        modelProfile,
        budgetPreset,
        customBudgetTokens:
          budgetPreset === "custom" ? customBudgetTokens : undefined,
        chunking,
        customInstruction,
      });
      setMarkdownPacket(packet);
      setSelectedChunkIndex(0);
    } catch (err) {
      setMarkdownPacket(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMarkdownLoading(false);
    }
  }

  async function handleCopyMarkdown() {
    if (!markdownPacket) return;

    const activeChunk = markdownPacket.chunks[selectedChunkIndex];
    const markdown = activeChunk?.markdown ?? markdownPacket.markdown;

    try {
      await navigator.clipboard.writeText(markdown);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  async function handleCopyAllMarkdown() {
    if (!markdownPacket) return;

    try {
      await navigator.clipboard.writeText(markdownPacket.markdown);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
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
                onSelect={handleSelectSpine}
              />
            ) : (
              <SpineList
                spine={book.spine}
                activeSpineId={activeSpine?.id ?? null}
                onSelect={handleSelectSpine}
              />
            )}
          </aside>

          <Reader spine={activeSpine} />
          <MarkdownPanel
            packet={markdownPacket}
            spine={activeSpine}
            loading={markdownLoading}
            copyState={copyState}
            taskMode={taskMode}
            modelProfile={modelProfile}
            budgetPreset={budgetPreset}
            customBudgetTokens={customBudgetTokens}
            chunking={chunking}
            customInstruction={customInstruction}
            selectedChunkIndex={selectedChunkIndex}
            onTaskModeChange={(value) => {
              setTaskMode(value);
              setMarkdownPacket(null);
              setCopyState("idle");
              setSelectedChunkIndex(0);
            }}
            onModelProfileChange={(value) => {
              setModelProfile(value);
              setMarkdownPacket(null);
              setCopyState("idle");
              setSelectedChunkIndex(0);
            }}
            onBudgetPresetChange={(value) => {
              setBudgetPreset(value);
              setMarkdownPacket(null);
              setCopyState("idle");
              setSelectedChunkIndex(0);
            }}
            onCustomBudgetTokensChange={(value) => {
              setCustomBudgetTokens(value);
              if (budgetPreset === "custom") {
                setMarkdownPacket(null);
                setCopyState("idle");
                setSelectedChunkIndex(0);
              }
            }}
            onChunkingChange={(value) => {
              setChunking(value);
              setMarkdownPacket(null);
              setCopyState("idle");
              setSelectedChunkIndex(0);
            }}
            onCustomInstructionChange={(value) => {
              setCustomInstruction(value);
              if (taskMode === "custom") {
                setMarkdownPacket(null);
                setCopyState("idle");
                setSelectedChunkIndex(0);
              }
            }}
            onSelectedChunkIndexChange={setSelectedChunkIndex}
            onGenerate={handleGenerateMarkdown}
            onCopy={handleCopyMarkdown}
            onCopyAll={handleCopyAllMarkdown}
          />
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

function MarkdownPanel({
  packet,
  spine,
  loading,
  copyState,
  taskMode,
  modelProfile,
  budgetPreset,
  customBudgetTokens,
  chunking,
  customInstruction,
  selectedChunkIndex,
  onTaskModeChange,
  onModelProfileChange,
  onBudgetPresetChange,
  onCustomBudgetTokensChange,
  onChunkingChange,
  onCustomInstructionChange,
  onSelectedChunkIndexChange,
  onGenerate,
  onCopy,
  onCopyAll,
}: {
  packet: GeneratedMarkdown | null;
  spine: SpineItem | null;
  loading: boolean;
  copyState: "idle" | "copied" | "failed";
  taskMode: TaskMode;
  modelProfile: ModelProfile;
  budgetPreset: BudgetPreset;
  customBudgetTokens: number;
  chunking: ChunkingMode;
  customInstruction: string;
  selectedChunkIndex: number;
  onTaskModeChange: (taskMode: TaskMode) => void;
  onModelProfileChange: (profile: ModelProfile) => void;
  onBudgetPresetChange: (budget: BudgetPreset) => void;
  onCustomBudgetTokensChange: (tokens: number) => void;
  onChunkingChange: (chunking: ChunkingMode) => void;
  onCustomInstructionChange: (instruction: string) => void;
  onSelectedChunkIndexChange: (index: number) => void;
  onGenerate: () => void;
  onCopy: () => void;
  onCopyAll: () => void;
}) {
  const selectedChunk = packet?.chunks[selectedChunkIndex] ?? packet?.chunks[0];
  const previewMarkdown = selectedChunk?.markdown ?? packet?.markdown ?? "";

  return (
    <aside className="packet-panel">
      <header className="packet-header">
        <div>
          <h2>Study Packet</h2>
          <p>{spine?.title || spine?.href || "No chapter selected"}</p>
        </div>
        <button disabled={!spine || loading} onClick={onGenerate} type="button">
          {loading ? "Generating" : "Generate"}
        </button>
      </header>

      <div className="packet-controls">
        <label>
          <span>Task</span>
          <select
            value={taskMode}
            onChange={(event) =>
              onTaskModeChange(event.target.value as TaskMode)
            }
          >
            {taskOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Model</span>
          <select
            value={modelProfile}
            onChange={(event) =>
              onModelProfileChange(event.target.value as ModelProfile)
            }
          >
            {modelProfiles.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Budget</span>
          <select
            value={budgetPreset}
            onChange={(event) =>
              onBudgetPresetChange(event.target.value as BudgetPreset)
            }
          >
            {budgetOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {budgetPreset === "custom" ? (
          <label>
            <span>Custom budget</span>
            <input
              min={1}
              type="number"
              value={customBudgetTokens}
              onChange={(event) =>
                onCustomBudgetTokensChange(Number(event.target.value))
              }
            />
          </label>
        ) : null}

        <label>
          <span>Chunking</span>
          <select
            value={chunking}
            onChange={(event) =>
              onChunkingChange(event.target.value as ChunkingMode)
            }
          >
            {chunkingOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {taskMode === "custom" ? (
          <label>
            <span>Instruction</span>
            <textarea
              value={customInstruction}
              onChange={(event) =>
                onCustomInstructionChange(event.target.value)
              }
              placeholder="Ask the model to tutor, quiz, explain, compare, or transform this excerpt."
            />
          </label>
        ) : null}
      </div>

      {packet ? (
        <>
          <dl className="packet-meta">
            <div>
              <dt>Tokens</dt>
              <dd>{packet.estimatedTokens}</dd>
            </div>
            <div>
              <dt>Chunks</dt>
              <dd>{packet.chunks.length}</dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>{packet.location}</dd>
            </div>
          </dl>
          {packet.chunks.length > 1 ? (
            <ChunkSelector
              chunks={packet.chunks}
              selectedChunkIndex={selectedChunkIndex}
              onSelect={onSelectedChunkIndexChange}
            />
          ) : null}
          <textarea
            readOnly
            className="packet-preview"
            value={previewMarkdown}
            aria-label="Generated Markdown preview"
          />
          <div className="packet-actions">
            <button onClick={onCopy} type="button">
              Copy Chunk
            </button>
            {packet.chunks.length > 1 ? (
              <button onClick={onCopyAll} type="button">
                Copy All
              </button>
            ) : null}
            {copyState === "copied" ? <span>Copied</span> : null}
            {copyState === "failed" ? <span>Copy failed</span> : null}
          </div>
        </>
      ) : (
        <div className="packet-empty">
          <p>Generate a task-specific study packet for the selected chapter.</p>
        </div>
      )}
    </aside>
  );
}

function ChunkSelector({
  chunks,
  selectedChunkIndex,
  onSelect,
}: {
  chunks: GeneratedMarkdownChunk[];
  selectedChunkIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="chunk-selector" role="tablist" aria-label="Packet chunks">
      {chunks.map((chunk, index) => (
        <button
          key={`${chunk.chunkNumber}-${chunk.startNodeId ?? index}`}
          className={index === selectedChunkIndex ? "active" : ""}
          onClick={() => onSelect(index)}
          type="button"
        >
          {chunk.chunkNumber}/{chunk.totalChunks}
        </button>
      ))}
    </div>
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
