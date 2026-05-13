use scholia_core::{
    BookDocument, BudgetPreset, ChunkingMode, ContentDocument, ContentKind, ContentNode,
    EpubError, GeneratedMarkdown, GeneratedMarkdownChunk, LocationSource, ModelProfileId,
    PacketOptions, SelectionRange, SpineItem, TaskMode, TocNode,
};
use serde::{Deserialize, Serialize};
use std::fs;
use thiserror::Error;

#[derive(Debug, Error)]
enum CommandError {
    #[error("could not read EPUB file: {0}")]
    Read(#[from] std::io::Error),
    #[error("{0}")]
    Epub(#[from] EpubError),
    #[error("unsupported task mode: {0}")]
    UnsupportedTaskMode(String),
    #[error("unsupported model profile: {0}")]
    UnsupportedModelProfile(String),
    #[error("unsupported budget preset: {0}")]
    UnsupportedBudgetPreset(String),
    #[error("unsupported chunking mode: {0}")]
    UnsupportedChunkingMode(String),
}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BookSummaryDto {
    id: String,
    title: String,
    authors: Vec<String>,
    language: Option<String>,
    spine: Vec<SpineItemDto>,
    toc: Vec<TocNodeDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpineItemDto {
    id: String,
    href: String,
    linear: bool,
    title: Option<String>,
    content: ContentDocumentDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TocNodeDto {
    id: String,
    title: String,
    href: String,
    anchor: Option<String>,
    children: Vec<TocNodeDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentDocumentDto {
    spine_item_id: String,
    href: String,
    nodes: Vec<ContentNodeDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentNodeDto {
    id: String,
    kind: &'static str,
    text: Option<String>,
    level: Option<u8>,
    attrs: std::collections::HashMap<String, String>,
    children: Vec<ContentNodeDto>,
    source: LocationSourceDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocationSourceDto {
    href: String,
    anchor: Option<String>,
    dom_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedMarkdownDto {
    markdown: String,
    estimated_tokens: usize,
    heading_ancestry: Vec<String>,
    location: String,
    chunks: Vec<GeneratedMarkdownChunkDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedMarkdownChunkDto {
    markdown: String,
    estimated_tokens: usize,
    chunk_number: usize,
    total_chunks: usize,
    start_node_id: Option<String>,
    end_node_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateStudyPacketRequestDto {
    path: String,
    spine_item_id: String,
    range: PacketRangeDto,
    task_mode: String,
    model_profile: String,
    budget_preset: String,
    custom_budget_tokens: Option<usize>,
    chunking: String,
    custom_instruction: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PacketRangeDto {
    Chapter,
    Selection {
        start_node_id: String,
        end_node_id: String,
    },
}

#[tauri::command]
fn open_book(path: String) -> Result<BookSummaryDto, CommandError> {
    let bytes = fs::read(path)?;
    let book = scholia_core::open_epub_bytes(&bytes)?;
    Ok(book.into())
}

#[tauri::command]
fn read_epub_file(path: String) -> Result<Vec<u8>, CommandError> {
    Ok(fs::read(path)?)
}

#[tauri::command]
fn generate_study_packet(
    request: GenerateStudyPacketRequestDto,
) -> Result<GeneratedMarkdownDto, CommandError> {
    let bytes = fs::read(request.path)?;
    let book = scholia_core::open_epub_bytes(&bytes)?;
    let options = PacketOptions {
        task_mode: parse_task_mode(&request.task_mode)?,
        model_profile: parse_model_profile(&request.model_profile)?,
        budget_preset: parse_budget_preset(&request.budget_preset)?,
        custom_budget_tokens: request.custom_budget_tokens,
        chunking: parse_chunking_mode(&request.chunking)?,
        custom_instruction: request.custom_instruction,
    };
    let packet = match request.range {
        PacketRangeDto::Chapter => {
            scholia_core::generate_chapter_study_packet(&book, &request.spine_item_id, &options)?
        }
        PacketRangeDto::Selection {
            start_node_id,
            end_node_id,
        } => scholia_core::generate_selection_study_packet(
            &book,
            &request.spine_item_id,
            &SelectionRange {
                start_node_id,
                end_node_id,
            },
            &options,
        )?,
    };
    Ok(packet.into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_book,
            read_epub_file,
            generate_study_packet
        ])
        .run(tauri::generate_context!())
        .expect("error while running Scholia");
}

impl From<BookDocument> for BookSummaryDto {
    fn from(book: BookDocument) -> Self {
        Self {
            id: book.id,
            title: book.title,
            authors: book.authors,
            language: book.language,
            spine: book.spine.into_iter().map(Into::into).collect(),
            toc: book.toc.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<SpineItem> for SpineItemDto {
    fn from(item: SpineItem) -> Self {
        Self {
            id: item.id,
            href: item.href,
            linear: item.linear,
            title: item.title,
            content: item.content.into(),
        }
    }
}

impl From<TocNode> for TocNodeDto {
    fn from(node: TocNode) -> Self {
        Self {
            id: node.id,
            title: node.title,
            href: node.href,
            anchor: node.anchor,
            children: node.children.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<ContentDocument> for ContentDocumentDto {
    fn from(document: ContentDocument) -> Self {
        Self {
            spine_item_id: document.spine_item_id,
            href: document.href,
            nodes: document.nodes.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<ContentNode> for ContentNodeDto {
    fn from(node: ContentNode) -> Self {
        Self {
            id: node.id,
            kind: content_kind_name(node.kind),
            text: node.text,
            level: node.level,
            attrs: node.attrs,
            children: node.children.into_iter().map(Into::into).collect(),
            source: node.source.into(),
        }
    }
}

impl From<LocationSource> for LocationSourceDto {
    fn from(source: LocationSource) -> Self {
        Self {
            href: source.href,
            anchor: source.anchor,
            dom_path: source.dom_path,
        }
    }
}

impl From<GeneratedMarkdown> for GeneratedMarkdownDto {
    fn from(packet: GeneratedMarkdown) -> Self {
        Self {
            markdown: packet.markdown,
            estimated_tokens: packet.estimated_tokens,
            heading_ancestry: packet.heading_ancestry,
            location: packet.location,
            chunks: packet.chunks.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<GeneratedMarkdownChunk> for GeneratedMarkdownChunkDto {
    fn from(chunk: GeneratedMarkdownChunk) -> Self {
        Self {
            markdown: chunk.markdown,
            estimated_tokens: chunk.estimated_tokens,
            chunk_number: chunk.chunk_number,
            total_chunks: chunk.total_chunks,
            start_node_id: chunk.start_node_id,
            end_node_id: chunk.end_node_id,
        }
    }
}

fn content_kind_name(kind: ContentKind) -> &'static str {
    match kind {
        ContentKind::Heading => "heading",
        ContentKind::Paragraph => "paragraph",
        ContentKind::Blockquote => "blockquote",
        ContentKind::Code => "code",
        ContentKind::List => "list",
        ContentKind::Table => "table",
        ContentKind::Image => "image",
        ContentKind::Math => "math",
        ContentKind::Footnote => "footnote",
        ContentKind::Reference => "reference",
        ContentKind::ThematicBreak => "thematicBreak",
    }
}

fn parse_task_mode(value: &str) -> Result<TaskMode, CommandError> {
    match value {
        "explain" => Ok(TaskMode::ExplainConcept),
        "term" => Ok(TaskMode::ExplainTerm),
        "analogy" => Ok(TaskMode::Analogy),
        "diagram" => Ok(TaskMode::Diagram),
        "quiz" => Ok(TaskMode::Quiz),
        "exercises" => Ok(TaskMode::Exercises),
        "check" => Ok(TaskMode::CheckUnderstanding),
        "summarize" => Ok(TaskMode::Summarize),
        "definitions" => Ok(TaskMode::KeyDefinitions),
        "technical" => Ok(TaskMode::ExtractTechnicalDetails),
        "compare" => Ok(TaskMode::CompareConcepts),
        "flashcards" => Ok(TaskMode::Flashcards),
        "custom" => Ok(TaskMode::Custom),
        other => Err(CommandError::UnsupportedTaskMode(other.to_string())),
    }
}

fn parse_model_profile(value: &str) -> Result<ModelProfileId, CommandError> {
    match value {
        "generic" => Ok(ModelProfileId::Generic),
        "chatgpt" => Ok(ModelProfileId::ChatGpt),
        "claude" => Ok(ModelProfileId::Claude),
        other => Err(CommandError::UnsupportedModelProfile(other.to_string())),
    }
}

fn parse_budget_preset(value: &str) -> Result<BudgetPreset, CommandError> {
    match value {
        "small" => Ok(BudgetPreset::Small),
        "medium" => Ok(BudgetPreset::Medium),
        "large" => Ok(BudgetPreset::Large),
        "xl" => Ok(BudgetPreset::Xl),
        "custom" => Ok(BudgetPreset::Custom),
        other => Err(CommandError::UnsupportedBudgetPreset(other.to_string())),
    }
}

fn parse_chunking_mode(value: &str) -> Result<ChunkingMode, CommandError> {
    match value {
        "none" => Ok(ChunkingMode::None),
        "auto" => Ok(ChunkingMode::Auto),
        "force" => Ok(ChunkingMode::Force),
        other => Err(CommandError::UnsupportedChunkingMode(other.to_string())),
    }
}
