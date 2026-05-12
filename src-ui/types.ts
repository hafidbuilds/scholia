export type BookSummary = {
  id: string;
  title: string;
  authors: string[];
  language?: string | null;
  spine: SpineItem[];
  toc: TocNode[];
};

export type SpineItem = {
  id: string;
  href: string;
  linear: boolean;
  title?: string | null;
  content: ContentDocument;
};

export type TocNode = {
  id: string;
  title: string;
  href: string;
  anchor?: string | null;
  children: TocNode[];
};

export type ContentDocument = {
  spineItemId: string;
  href: string;
  nodes: ContentNode[];
};

export type ContentNode = {
  id: string;
  kind:
    | "heading"
    | "paragraph"
    | "blockquote"
    | "code"
    | "list"
    | "table"
    | "image"
    | "math"
    | "footnote"
    | "reference"
    | "thematicBreak";
  text?: string | null;
  level?: number | null;
  attrs: Record<string, string>;
  children: ContentNode[];
  source: {
    href: string;
    anchor?: string | null;
    domPath?: string | null;
  };
};

export type GeneratedMarkdown = {
  markdown: string;
  estimatedTokens: number;
  headingAncestry: string[];
  location: string;
};

export type TaskMode =
  | "explain"
  | "term"
  | "analogy"
  | "diagram"
  | "quiz"
  | "exercises"
  | "check"
  | "summarize"
  | "definitions"
  | "technical"
  | "compare"
  | "flashcards"
  | "custom";

export type ModelProfile = "generic" | "chatgpt" | "claude";

export type StudyPacketOptions = {
  taskMode: TaskMode;
  modelProfile: ModelProfile;
  customInstruction?: string;
};
