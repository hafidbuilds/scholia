import { invoke } from "@tauri-apps/api/core";
import type { BookSummary, GeneratedMarkdown } from "./types";

export async function openBook(path: string): Promise<BookSummary> {
  return invoke<BookSummary>("open_book", { path });
}

export async function generateChapterMarkdown(
  path: string,
  spineItemId: string,
): Promise<GeneratedMarkdown> {
  return invoke<GeneratedMarkdown>("generate_chapter_markdown", {
    path,
    spineItemId,
  });
}
