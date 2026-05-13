import { invoke } from "@tauri-apps/api/core";
import type { BookSummary, GeneratedMarkdown, StudyPacketOptions } from "./types";

export async function openBook(path: string): Promise<BookSummary> {
  return invoke<BookSummary>("open_book", { path });
}

export async function readEpubFile(path: string): Promise<number[] | Uint8Array> {
  return invoke<number[] | Uint8Array>("read_epub_file", { path });
}

export async function generateStudyPacket(
  path: string,
  spineItemId: string,
  options: StudyPacketOptions,
): Promise<GeneratedMarkdown> {
  return invoke<GeneratedMarkdown>("generate_study_packet", {
    request: {
      path,
      spineItemId,
      range: options.range,
      taskMode: options.taskMode,
      modelProfile: options.modelProfile,
      budgetPreset: options.budgetPreset,
      customBudgetTokens: options.customBudgetTokens,
      chunking: options.chunking,
      customInstruction: options.customInstruction,
    },
  });
}
