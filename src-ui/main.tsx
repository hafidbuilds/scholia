import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import Epub, { type Book, type Rendition } from "epubjs";
import "./styles.css";
import { generateStudyPacket, openBook, readEpubFile } from "./api";
import type {
  BookSummary,
  BudgetPreset,
  ChunkingMode,
  GeneratedMarkdown,
  GeneratedMarkdownChunk,
  ModelProfile,
  PacketRange,
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
  const [tocCollapsed, setTocCollapsed] = useState(false);
  const [packetCollapsed, setPacketCollapsed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewWidthPercent, setPreviewWidthPercent] = useState(50);
  const [resizingPreview, setResizingPreview] = useState(false);
  const readerContentRef = useRef<HTMLDivElement | null>(null);
  const [activeTocNodeId, setActiveTocNodeId] = useState<string | null>(null);
  const [activeTocHref, setActiveTocHref] = useState<string | null>(null);
  const [pickedTocNodeIds, setPickedTocNodeIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pickedSpineIds, setPickedSpineIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedRange, setSelectedRange] = useState<PacketRange>({
    type: "chapter",
  });

  const activeSpine = useMemo(() => {
    if (!book) return null;
    return (
      book.spine.find((item) => item.id === activeSpineId) ??
      book.spine.find((item) => item.linear) ??
      book.spine[0] ??
      null
    );
  }, [activeSpineId, book]);

  const tocNodeIds = useMemo(
    () => (book ? flattenTocNodeIds(book.toc) : []),
    [book],
  );
  const hasToc = Boolean(book?.toc.length);
  const pickTotal = book ? (hasToc ? tocNodeIds.length : book.spine.length) : 0;
  const pickedCount = book
    ? hasToc
      ? tocNodeIds.filter((id) => pickedTocNodeIds.has(id)).length
      : book.spine.filter((item) => pickedSpineIds.has(item.id)).length
    : 0;
  const allItemsPicked = pickTotal > 0 && pickedCount === pickTotal;

  useEffect(() => {
    if (!resizingPreview) return;

    function handlePointerMove(event: PointerEvent) {
      const container = readerContentRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const previewWidth = rect.right - event.clientX;
      const percent = (previewWidth / rect.width) * 100;
      setPreviewWidthPercent(Math.max(30, Math.min(70, percent)));
    }

    function stopResizing() {
      setResizingPreview(false);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing, { once: true });
    document.body.classList.add("is-resizing-pane");

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      document.body.classList.remove("is-resizing-pane");
    };
  }, [resizingPreview]);

  async function openBookPath(nextPath: string) {
    setLoading(true);
    setError(null);
    try {
      const opened = await openBook(nextPath);
      setPath(nextPath);
      setBook(opened);
      setActiveSpineId(opened.spine[0]?.id ?? null);
      setActiveTocNodeId(null);
      setActiveTocHref(null);
      setPickedTocNodeIds(new Set());
      setPickedSpineIds(new Set());
      setMarkdownPacket(null);
      setCopyState("idle");
      setSelectedChunkIndex(0);
      setPreviewOpen(false);
      setSelectedRange({ type: "chapter" });
    } catch (err) {
      setBook(null);
      setActiveSpineId(null);
      setActiveTocNodeId(null);
      setActiveTocHref(null);
      setPickedTocNodeIds(new Set());
      setPickedSpineIds(new Set());
      setMarkdownPacket(null);
      setSelectedChunkIndex(0);
      setPreviewOpen(false);
      setSelectedRange({ type: "chapter" });
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleChooseFile() {
    setError(null);
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "EPUB", extensions: ["epub"] }],
    });

    if (typeof selected === "string") {
      await openBookPath(selected);
    }
  }

  async function handleSelectSpine(spineId: string) {
    setActiveSpineId(spineId);
    setActiveTocNodeId(null);
    setActiveTocHref(null);
    setMarkdownPacket(null);
    setCopyState("idle");
    setSelectedChunkIndex(0);
    setSelectedRange({ type: "chapter" });
  }

  function handleSelectTocNode(node: TocNode, spineId: string) {
    setActiveSpineId(spineId);
    setActiveTocNodeId(node.id);
    setActiveTocHref(node.anchor ? `${node.href}#${node.anchor}` : node.href);
    setMarkdownPacket(null);
    setCopyState("idle");
    setSelectedChunkIndex(0);
    setSelectedRange({ type: "chapter" });
  }

  function handleToggleTocPick(node: TocNode, picked: boolean) {
    const nodeIds = tocNodeWithDescendantIds(node);
    setPickedTocNodeIds((current) => {
      const next = new Set(current);
      for (const nodeId of nodeIds) {
        if (picked) {
          next.add(nodeId);
        } else {
          next.delete(nodeId);
        }
      }
      return next;
    });
  }

  function handleToggleSpinePick(spineId: string, picked: boolean) {
    setPickedSpineIds((current) => {
      const next = new Set(current);
      if (picked) {
        next.add(spineId);
      } else {
        next.delete(spineId);
      }
      return next;
    });
  }

  function handleToggleAllSpines() {
    if (!book) return;
    if (hasToc) {
      setPickedTocNodeIds(allItemsPicked ? new Set() : new Set(tocNodeIds));
    } else {
      setPickedSpineIds(
        allItemsPicked ? new Set() : new Set(book.spine.map((item) => item.id)),
      );
    }
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
        range: selectedRange,
      });
      setMarkdownPacket(packet);
      setSelectedChunkIndex(0);
      setPreviewWidthPercent(50);
      setPreviewOpen(true);
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
      <header className="titlebar">
        <div className="title">Scholia</div>
        <div className="win-controls" aria-hidden="true">
          <span className="win-btn" />
          <span className="win-btn" />
          <span className="win-btn" />
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="body">
        <aside
          className={`sidebar sidebar-left${tocCollapsed ? " collapsed" : ""}`}
        >
          <button
            aria-label={tocCollapsed ? "Expand contents" : "Collapse contents"}
            className="sidebar-toggle"
            onClick={() => setTocCollapsed((collapsed) => !collapsed)}
            type="button"
          >
            {tocCollapsed ? ">" : "<"}
          </button>
          <div className="sidebar-inner">
            <header className="sidebar-header">
              <span className="sidebar-title">Contents</span>
            </header>
            {book ? (
              <>
                <BookMeta book={book} />
                <div className="toc-toolbar">
                  <span className="toc-count">
                    {pickedCount}/{pickTotal} selected
                  </span>
                  <div className="toc-actions">
                    <button
                      className="toc-action"
                      onClick={handleToggleAllSpines}
                      type="button"
                    >
                      {allItemsPicked ? "Deselect all" : "Select all"}
                    </button>
                    <button
                      className="toc-action"
                      disabled={loading}
                      onClick={handleChooseFile}
                      type="button"
                    >
                      Open
                    </button>
                  </div>
                </div>
                <div className="toc-scroll">
                  {book.toc.length > 0 ? (
                    <TocList
                      nodes={book.toc}
                      spine={book.spine}
                      activeSpineId={activeSpine?.id ?? null}
                      activeTocNodeId={activeTocNodeId}
                      pickedTocNodeIds={pickedTocNodeIds}
                      onSelect={handleSelectTocNode}
                      onTogglePick={handleToggleTocPick}
                    />
                  ) : (
                    <SpineList
                      spine={book.spine}
                      activeSpineId={activeSpine?.id ?? null}
                      pickedSpineIds={pickedSpineIds}
                      onSelect={handleSelectSpine}
                      onTogglePick={handleToggleSpinePick}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="toc-empty">
                <button
                  className="btn btn-primary"
                  disabled={loading}
                  onClick={handleChooseFile}
                  type="button"
                >
                  {loading ? "Opening" : "Choose EPUB"}
                </button>
              </div>
            )}
          </div>
        </aside>

        <section className="reader-main">
          <header className="reader-toolbar">
            <div className="breadcrumb" title={path || undefined}>
              {book
                ? `${book.title} > ${activeSpine?.title || activeSpine?.href || "No chapter selected"}`
                : "No book loaded"}
            </div>
            <div className="toolbar-actions">
              <span className="path-chip">{path || "No EPUB selected"}</span>
              <button
                aria-label="Toggle generated preview"
                aria-pressed={previewOpen}
                className="btn icon-btn"
                data-tooltip="Toggle preview pane"
                onClick={() => setPreviewOpen((open) => !open)}
                type="button"
              >
                <SplitPaneIcon />
              </button>
            </div>
          </header>

          {book ? (
            <div
              className={`reader-content${previewOpen ? " dual" : ""}`}
              ref={readerContentRef}
              style={
                previewOpen
                  ? ({
                      "--preview-width": `${previewWidthPercent}%`,
                    } as React.CSSProperties)
                  : undefined
              }
            >
              <EpubReader
                path={path}
                spine={activeSpine}
                targetHref={activeTocHref ?? activeSpine?.href ?? null}
              />
              <div
                aria-label="Resize viewer and packet preview"
                className={`resizer${resizingPreview ? " dragging" : ""}`}
                onDoubleClick={() => setPreviewWidthPercent(50)}
                onPointerDown={(event) => {
                  event.preventDefault();
                  setResizingPreview(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") {
                    setPreviewWidthPercent((width) => Math.min(70, width + 5));
                  } else if (event.key === "ArrowRight") {
                    setPreviewWidthPercent((width) => Math.max(30, width - 5));
                  } else if (event.key === "Home") {
                    setPreviewWidthPercent(30);
                  } else if (event.key === "End") {
                    setPreviewWidthPercent(70);
                  } else if (event.key === "Enter" || event.key === " ") {
                    setPreviewWidthPercent(50);
                  }
                }}
                role="separator"
                tabIndex={0}
              />
              <GeneratedPreview
                packet={markdownPacket}
                selectedChunkIndex={selectedChunkIndex}
              />
            </div>
          ) : (
            <section className="empty-state">
              <BookIcon />
              <h2>No EPUB loaded</h2>
              <p>Choose a DRM-free EPUB to inspect and generate study packets.</p>
              <button
                className="btn btn-primary"
                disabled={loading}
                onClick={handleChooseFile}
                type="button"
              >
                {loading ? "Opening" : "Choose EPUB"}
              </button>
            </section>
          )}
        </section>

        <aside
          className={`sidebar sidebar-right${packetCollapsed ? " collapsed" : ""}`}
        >
          <button
            aria-label={packetCollapsed ? "Expand packet" : "Collapse packet"}
            className="sidebar-toggle"
            onClick={() => setPacketCollapsed((collapsed) => !collapsed)}
            type="button"
          >
            {packetCollapsed ? "<" : ">"}
          </button>
          <div className="sidebar-inner">
            <MarkdownPanel
              packet={markdownPacket}
              book={book}
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
              selectedRange={selectedRange}
              onRangeChange={(range) => {
                setSelectedRange(range);
                setMarkdownPacket(null);
                setCopyState("idle");
                setSelectedChunkIndex(0);
              }}
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
          </div>
        </aside>
      </section>
    </main>
  );
}

function SplitPaneIcon() {
  return (
    <svg
      className="icon-split"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="12" y1="3" x2="12" y2="21" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg
      className="skeleton-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function MarkdownPanel({
  packet,
  book,
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
  selectedRange,
  onRangeChange,
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
  book: BookSummary | null;
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
  selectedRange: PacketRange;
  onRangeChange: (range: PacketRange) => void;
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
  const chunkBoundary =
    selectedChunk?.startNodeId && selectedChunk?.endNodeId
      ? `${selectedChunk.startNodeId} to ${selectedChunk.endNodeId}`
      : selectedRange.type === "selection"
        ? `${selectedRange.startNodeId} to ${selectedRange.endNodeId}`
        : "Chapter";

  return (
    <div className="packet-panel">
      <header className="sidebar-header">
        <span className="sidebar-title">Packet</span>
      </header>

      <div className="tab-panel">
        <div className="packet-meta">
          <strong>Book:</strong> {book?.title ?? "No book loaded"}
          <br />
          <strong>Author:</strong> {book?.authors.join(", ") || "Unknown"}
          <br />
          <strong>Chapter:</strong> {spine?.title || spine?.href || "None"}
          <br />
          <strong>Internal source:</strong> {packet?.location || spine?.href || "-"}
          <br />
          <strong>Chunk:</strong>{" "}
          {packet
            ? `${selectedChunk?.chunkNumber ?? 1} of ${selectedChunk?.totalChunks ?? 1}`
            : "-"}
          <br />
          <strong>Chunk boundary:</strong> {chunkBoundary}
          <br />
          <strong>Budget:</strong> {budgetLabel(budgetPreset, customBudgetTokens)}
          <br />
          <strong>Estimated tokens:</strong> {packet?.estimatedTokens ?? "-"}
        </div>

        <label className="field">
          <span>Range</span>
          <select
            value={selectedRange.type}
            onChange={(event) => {
              if (event.target.value === "chapter") {
                onRangeChange({ type: "chapter" });
              } else if (selectedRange.type === "selection") {
                onRangeChange(selectedRange);
              }
            }}
          >
            <option value="chapter">Chapter</option>
            {selectedRange.type === "selection" ? (
              <option value="selection">Selection</option>
            ) : null}
          </select>
        </label>

        {selectedRange.type === "selection" ? (
          <div className="selection-range">
            {selectedRange.startNodeId} to {selectedRange.endNodeId}
          </div>
        ) : null}

        <label className="field">
          <span>Task mode</span>
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

        <label className="field">
          <span>Model profile</span>
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

        <label className="field">
          <span>Token budget</span>
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
          <label className="field">
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

        <label className="field">
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
          <label className="field">
            <span>Custom instruction</span>
            <textarea
              value={customInstruction}
              onChange={(event) =>
                onCustomInstructionChange(event.target.value)
              }
              placeholder="Ask the model to tutor, quiz, explain, compare, or transform this excerpt."
            />
          </label>
        ) : null}

        {packet && packet.chunks.length > 1 ? (
          <div className="field">
            <span className="field-label">Chunks</span>
            <ChunkSelector
              chunks={packet.chunks}
              selectedChunkIndex={selectedChunkIndex}
              onSelect={onSelectedChunkIndexChange}
            />
          </div>
        ) : null}

        <div className="packet-actions">
          <button
            className="btn btn-primary"
            disabled={!spine || loading}
            onClick={onGenerate}
            type="button"
          >
            {loading ? "Generating" : "Parse"}
          </button>
          <button className="btn" disabled={!packet} onClick={onCopy} type="button">
            Copy Chunk
          </button>
          {packet && packet.chunks.length > 1 ? (
            <button className="btn" onClick={onCopyAll} type="button">
              Copy All
            </button>
          ) : null}
        </div>

        <div className="copy-state" aria-live="polite">
          {copyState === "copied" ? "Copied" : null}
          {copyState === "failed" ? "Copy failed" : null}
          {copyState === "idle" && !packet
            ? "Generated markdown appears in the preview pane."
            : null}
        </div>
      </div>
    </div>
  );
}

function budgetLabel(preset: BudgetPreset, customBudgetTokens: number) {
  const option = budgetOptions.find((item) => item.value === preset);
  return preset === "custom"
    ? `${customBudgetTokens.toLocaleString()} tokens`
    : (option?.label ?? preset);
}

function GeneratedPreview({
  packet,
  selectedChunkIndex,
}: {
  packet: GeneratedMarkdown | null;
  selectedChunkIndex: number;
}) {
  const selectedChunk = packet?.chunks[selectedChunkIndex] ?? packet?.chunks[0];
  const previewMarkdown = selectedChunk?.markdown ?? packet?.markdown ?? "";

  return (
    <section className="pane generated-pane" aria-label="Generated packet">
      <div className="generated-body">
        {packet ? (
          <>
            <div className="token-badge">
              {selectedChunk?.estimatedTokens ?? packet.estimatedTokens} tokens
              estimated
            </div>
            <textarea
              readOnly
              className="preview-box"
              value={previewMarkdown}
              aria-label="Generated Markdown preview"
            />
          </>
        ) : (
          <div className="preview-box empty">
            Generate a study packet for the selected chapter or selection.
          </div>
        )}
      </div>
    </section>
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
  activeTocNodeId,
  pickedTocNodeIds,
  onSelect,
  onTogglePick,
  level = 1,
}: {
  nodes: TocNode[];
  spine: SpineItem[];
  activeSpineId: string | null;
  activeTocNodeId: string | null;
  pickedTocNodeIds: Set<string>;
  onSelect: (node: TocNode, spineId: string) => void;
  onTogglePick: (node: TocNode, picked: boolean) => void;
  level?: number;
}) {
  return (
    <ul className={`toc-list level-${Math.min(level, 3)}`}>
      {nodes.map((node) => {
        const spineItem = spine.find(
          (item) =>
            hrefWithoutFragment(item.href) === hrefWithoutFragment(node.href),
        );
        const isActive =
          node.id === activeTocNodeId ||
          (!activeTocNodeId && level === 1 && spineItem?.id === activeSpineId);
        const childIds = flattenTocNodeIds(node.children);
        const isPicked = pickedTocNodeIds.has(node.id);
        const isPartial =
          !isPicked && childIds.some((nodeId) => pickedTocNodeIds.has(nodeId));
        return (
          <li className="toc-node" key={node.id}>
            <button
              className={`toc-item level-${Math.min(level, 3)}${isActive ? " active" : ""}${isPicked ? " picked" : ""}`}
              disabled={!spineItem}
              onClick={() => spineItem && onSelect(node, spineItem.id)}
              type="button"
            >
              <TocCheckbox
                aria-label={`Include ${node.title}`}
                checked={isPicked}
                disabled={!spineItem}
                indeterminate={isPartial}
                onChange={(event) => {
                  if (spineItem) {
                    onTogglePick(node, event.target.checked);
                  }
                }}
                onClick={(event) => event.stopPropagation()}
              />
              <span className="toc-label">{node.title}</span>
            </button>
            {node.children.length > 0 ? (
              <TocList
                nodes={node.children}
                spine={spine}
                activeSpineId={activeSpineId}
                activeTocNodeId={activeTocNodeId}
                pickedTocNodeIds={pickedTocNodeIds}
                onSelect={onSelect}
                onTogglePick={onTogglePick}
                level={level + 1}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function hrefWithoutFragment(href: string) {
  return href.split("#", 1)[0];
}

function flattenTocNodeIds(nodes: TocNode[]): string[] {
  return nodes.flatMap((node) => tocNodeWithDescendantIds(node));
}

function tocNodeWithDescendantIds(node: TocNode): string[] {
  return [node.id, ...flattenTocNodeIds(node.children)];
}

function TocCheckbox({
  indeterminate,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "className" | "type"> & {
  indeterminate: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <input
      {...props}
      className="toc-check"
      ref={inputRef}
      type="checkbox"
    />
  );
}

function SpineList({
  spine,
  activeSpineId,
  pickedSpineIds,
  onSelect,
  onTogglePick,
}: {
  spine: SpineItem[];
  activeSpineId: string | null;
  pickedSpineIds: Set<string>;
  onSelect: (spineId: string) => void;
  onTogglePick: (spineId: string, picked: boolean) => void;
}) {
  return (
    <ul className="toc-list level-1">
      {spine.map((item) => (
        <li className="toc-node" key={item.id}>
          <button
            className={`toc-item level-1${item.id === activeSpineId ? " active" : ""}${pickedSpineIds.has(item.id) ? " picked" : ""}`}
            onClick={() => onSelect(item.id)}
            type="button"
          >
            <input
              aria-label={`Include ${item.title || item.href}`}
              checked={pickedSpineIds.has(item.id)}
              className="toc-check"
              onChange={(event) => onTogglePick(item.id, event.target.checked)}
              onClick={(event) => event.stopPropagation()}
              type="checkbox"
            />
            <span className="toc-label">{item.title || item.href}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function EpubReader({
  path,
  spine,
  targetHref,
}: {
  path: string;
  spine: SpineItem | null;
  targetHref: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const [readerState, setReaderState] = useState<
    "idle" | "loading" | "ready" | "failed"
  >("idle");
  const [readerError, setReaderError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadBook() {
      if (!path.trim() || !containerRef.current) {
        setReaderState("idle");
        return;
      }

      setReaderState("loading");
      setReaderError(null);
      renditionRef.current?.destroy();
      bookRef.current?.destroy();
      renditionRef.current = null;
      bookRef.current = null;
      containerRef.current.replaceChildren();

      try {
        const bytes = await readEpubFile(path);
        if (cancelled || !containerRef.current) return;

        const buffer = epubBytesToArrayBuffer(bytes);
        const book = Epub(buffer, { openAs: "binary" });
        const rendition = book.renderTo(containerRef.current, {
          width: "100%",
          height: "100%",
          flow: "paginated",
          spread: "none",
        });

        bookRef.current = book;
        renditionRef.current = rendition;
        await withTimeout(book.ready, 10000, "EPUB metadata load timed out");
        if (cancelled) return;

        await withTimeout(
          rendition.display(targetHref ?? spine?.href),
          10000,
          "EPUB chapter render timed out",
        );
        if (!cancelled) {
          setReaderState("ready");
        }
      } catch (err) {
        if (!cancelled) {
          setReaderState("failed");
          setReaderError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void loadBook();

    return () => {
      cancelled = true;
      renditionRef.current?.destroy();
      bookRef.current?.destroy();
      renditionRef.current = null;
      bookRef.current = null;
    };
  }, [path]);

  useEffect(() => {
    if (!spine || readerState !== "ready") return;
    void renditionRef.current?.display(targetHref ?? spine.href);
  }, [readerState, spine, targetHref]);

  async function goPrevious() {
    await renditionRef.current?.prev();
  }

  async function goNext() {
    await renditionRef.current?.next();
  }

  if (!spine) {
    return (
      <article className="pane epub-pane">
        <p>No readable spine content was found.</p>
      </article>
    );
  }

  return (
    <article className="pane epub-pane">
      <div className="epub-meta">
        <span>{spine.title || "EPUB chapter"}</span>
        <div className="reader-nav">
          <button
            className="icon-btn"
            disabled={readerState !== "ready"}
            onClick={goPrevious}
            type="button"
            aria-label="Previous page"
          >
            <ChevronLeftIcon />
          </button>
          <button
            className="icon-btn"
            disabled={readerState !== "ready"}
            onClick={goNext}
            type="button"
            aria-label="Next page"
          >
            <ChevronRightIcon />
          </button>
        </div>
      </div>
      <div className="epub-renderer">
        <div ref={containerRef} className="epub-rendition" />
        {readerState === "loading" ? (
          <div className="reader-overlay">Loading EPUB</div>
        ) : null}
        {readerState === "failed" ? (
          <div className="reader-overlay error">{readerError}</div>
        ) : null}
      </div>
    </article>
  );
}

function epubBytesToArrayBuffer(bytes: number[] | Uint8Array) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const buffer = new ArrayBuffer(view.byteLength);
  new Uint8Array(buffer).set(view);
  return buffer;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (err: unknown) => {
        window.clearTimeout(timeoutId);
        reject(err);
      },
    );
  });
}

function ChevronLeftIcon() {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
