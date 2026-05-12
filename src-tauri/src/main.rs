use scholia_core::{
    BookDocument, ContentDocument, ContentKind, ContentNode, EpubError, LocationSource, SpineItem,
    TocNode,
};
use serde::Serialize;
use std::fs;
use thiserror::Error;

#[derive(Debug, Error)]
enum CommandError {
    #[error("could not read EPUB file: {0}")]
    Read(#[from] std::io::Error),
    #[error("{0}")]
    Epub(#[from] EpubError),
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

#[tauri::command]
fn open_book(path: String) -> Result<BookSummaryDto, CommandError> {
    let bytes = fs::read(path)?;
    let book = scholia_core::open_epub_bytes(&bytes)?;
    Ok(book.into())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_book])
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
