import { invoke } from "@tauri-apps/api/core";
import type { BookSummary } from "./types";

export async function openBook(path: string): Promise<BookSummary> {
  return invoke<BookSummary>("open_book", { path });
}
