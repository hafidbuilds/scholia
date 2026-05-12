use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Cursor, Read, Seek};
use std::path::{Path, PathBuf};
use thiserror::Error;
use zip::ZipArchive;

#[derive(Debug, Error)]
pub enum EpubError {
    #[error("invalid EPUB zip: {0}")]
    InvalidZip(#[from] zip::result::ZipError),
    #[error("could not read EPUB entry: {0}")]
    Read(#[from] std::io::Error),
    #[error("missing META-INF/container.xml")]
    MissingContainer,
    #[error("container.xml does not point to an OPF package")]
    MissingRootfile,
    #[error("OPF package is missing or unreadable: {0}")]
    MissingOpf(String),
    #[error("required manifest item is missing: {0}")]
    MissingManifestItem(String),
    #[error("spine item is missing: {0}")]
    MissingSpineItem(String),
    #[error("XML parse error in {path}: {source}")]
    Xml {
        path: String,
        #[source]
        source: quick_xml::Error,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookDocument {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub language: Option<String>,
    pub spine: Vec<SpineItem>,
    pub toc: Vec<TocNode>,
    pub manifest: Vec<Asset>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpineItem {
    pub id: String,
    pub href: String,
    pub linear: bool,
    pub title: Option<String>,
    pub content: ContentDocument,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TocNode {
    pub id: String,
    pub title: String,
    pub href: String,
    pub anchor: Option<String>,
    pub children: Vec<TocNode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentDocument {
    pub spine_item_id: String,
    pub href: String,
    pub nodes: Vec<ContentNode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentNode {
    pub id: String,
    pub kind: ContentKind,
    pub text: Option<String>,
    pub level: Option<u8>,
    pub attrs: HashMap<String, String>,
    pub children: Vec<ContentNode>,
    pub source: LocationSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentKind {
    Heading,
    Paragraph,
    Blockquote,
    Code,
    List,
    Table,
    Image,
    Math,
    Footnote,
    Reference,
    ThematicBreak,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocationSource {
    pub href: String,
    pub anchor: Option<String>,
    pub dom_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub id: String,
    pub href: String,
    pub media_type: String,
    pub properties: Vec<String>,
    pub absolute_path_in_archive: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedMarkdown {
    pub markdown: String,
    pub estimated_tokens: usize,
    pub heading_ancestry: Vec<String>,
    pub location: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OpfPackage {
    title: Option<String>,
    authors: Vec<String>,
    language: Option<String>,
    manifest: Vec<Asset>,
    spine_refs: Vec<SpineRef>,
    nav_item_id: Option<String>,
    ncx_item_id: Option<String>,
    base_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SpineRef {
    idref: String,
    linear: bool,
}

#[derive(Debug, Clone)]
struct XmlEvent {
    kind: XmlEventKind,
    name: String,
    attrs: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum XmlEventKind {
    Start,
    Empty,
    End,
    Text,
}

pub fn open_epub_bytes(bytes: &[u8]) -> Result<BookDocument, EpubError> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)?;
    let container = read_entry_to_string(&mut archive, "META-INF/container.xml")
        .map_err(|_| EpubError::MissingContainer)?;
    let opf_path = parse_container_rootfile(&container)?;
    let opf_xml = read_entry_to_string(&mut archive, &opf_path)
        .map_err(|_| EpubError::MissingOpf(opf_path.clone()))?;
    let package = parse_opf(&opf_xml, &opf_path)?;
    let assets_by_id: HashMap<_, _> = package
        .manifest
        .iter()
        .map(|asset| (asset.id.clone(), asset.clone()))
        .collect();

    let mut spine = Vec::new();
    for spine_ref in &package.spine_refs {
        let asset = assets_by_id
            .get(&spine_ref.idref)
            .ok_or_else(|| EpubError::MissingManifestItem(spine_ref.idref.clone()))?;
        let xhtml = read_entry_to_string(&mut archive, &asset.absolute_path_in_archive)?;
        let content = parse_content_document(&xhtml, &asset.href, &asset.id)?;
        let title = content
            .nodes
            .iter()
            .find(|node| node.kind == ContentKind::Heading)
            .and_then(|node| node.text.clone());
        spine.push(SpineItem {
            id: asset.id.clone(),
            href: asset.href.clone(),
            linear: spine_ref.linear,
            title,
            content,
        });
    }

    let toc = parse_toc(&mut archive, &package, &assets_by_id)?;
    let title = package.title.unwrap_or_else(|| "Untitled".to_string());
    let authors = if package.authors.is_empty() {
        vec!["Unknown author".to_string()]
    } else {
        package.authors
    };
    let id = stable_id(&format!("{}|{}", title, authors.join("|")));

    Ok(BookDocument {
        id,
        title,
        authors,
        language: package.language,
        spine,
        toc,
        manifest: package.manifest,
    })
}

pub fn generate_chapter_markdown(
    book: &BookDocument,
    spine_item_id: &str,
) -> Result<GeneratedMarkdown, EpubError> {
    let spine_item = book
        .spine
        .iter()
        .find(|item| item.id == spine_item_id)
        .ok_or_else(|| EpubError::MissingSpineItem(spine_item_id.to_string()))?;
    let excerpt = render_nodes_as_markdown(&spine_item.content.nodes);
    let chapter = spine_item
        .title
        .as_deref()
        .or_else(|| first_heading_text(&spine_item.content.nodes))
        .unwrap_or(&spine_item.href);
    let heading_ancestry = heading_ancestry(&spine_item.content.nodes);
    let estimated_tokens = estimate_tokens(&excerpt);

    let mut markdown = String::new();
    markdown.push_str("# Extracted Markdown\n\n");
    markdown.push_str("## Metadata\n\n");
    markdown.push_str(&format!("Book: {}\n", book.title));
    markdown.push_str(&format!("Author: {}\n", book.authors.join(", ")));
    markdown.push_str(&format!("Chapter: {chapter}\n"));
    markdown.push_str("Section path:\n");
    if heading_ancestry.is_empty() {
        markdown.push_str("- <none detected>\n");
    } else {
        for heading in &heading_ancestry {
            markdown.push_str(&format!("- {heading}\n"));
        }
    }
    markdown.push_str(&format!("Location: {}\n", spine_item.href));
    markdown.push_str(&format!("Estimated tokens: {estimated_tokens}\n\n"));
    markdown.push_str("## Excerpt\n\n");
    markdown.push_str("```markdown\n");
    markdown.push_str(excerpt.trim());
    markdown.push_str("\n```\n");

    Ok(GeneratedMarkdown {
        markdown,
        estimated_tokens,
        heading_ancestry,
        location: spine_item.href.clone(),
    })
}

pub fn render_nodes_as_markdown(nodes: &[ContentNode]) -> String {
    let mut markdown = String::new();
    for node in nodes {
        render_node_as_markdown(node, &mut markdown);
        if !markdown.ends_with("\n\n") {
            markdown.push('\n');
        }
    }
    markdown.trim_end().to_string()
}

fn render_node_as_markdown(node: &ContentNode, output: &mut String) {
    match node.kind {
        ContentKind::Heading => {
            let level = node.level.unwrap_or(2).clamp(1, 6);
            output.push_str(&"#".repeat(level as usize));
            output.push(' ');
            output.push_str(node.text.as_deref().unwrap_or(""));
            output.push_str("\n\n");
        }
        ContentKind::Paragraph => {
            output.push_str(node.text.as_deref().unwrap_or(""));
            output.push_str("\n\n");
        }
        ContentKind::Blockquote => {
            for line in node.text.as_deref().unwrap_or("").lines() {
                output.push_str("> ");
                output.push_str(line);
                output.push('\n');
            }
            output.push('\n');
        }
        ContentKind::Code => {
            output.push_str("```\n");
            output.push_str(node.text.as_deref().unwrap_or(""));
            output.push_str("\n```\n\n");
        }
        ContentKind::List => {
            for child in &node.children {
                output.push_str("- ");
                output.push_str(child.text.as_deref().unwrap_or(""));
                output.push('\n');
            }
            output.push('\n');
        }
        ContentKind::Image => {
            output.push_str("[Image omitted");
            if let Some(src) = node.attrs.get("src") {
                output.push_str(": ");
                output.push_str(src);
            }
            output.push_str("]\n");
            if let Some(alt) = node.text.as_deref() {
                output.push_str("Alt text: ");
                output.push_str(alt);
                output.push('\n');
            }
            output.push('\n');
        }
        ContentKind::ThematicBreak => {
            output.push_str("---\n\n");
        }
        ContentKind::Table | ContentKind::Math | ContentKind::Footnote | ContentKind::Reference => {
            if let Some(text) = node.text.as_deref() {
                output.push_str(text);
                output.push_str("\n\n");
            }
        }
    }
}

fn heading_ancestry(nodes: &[ContentNode]) -> Vec<String> {
    nodes
        .iter()
        .filter(|node| node.kind == ContentKind::Heading)
        .filter_map(|node| node.text.clone())
        .collect()
}

fn first_heading_text(nodes: &[ContentNode]) -> Option<&str> {
    nodes
        .iter()
        .find(|node| node.kind == ContentKind::Heading)
        .and_then(|node| node.text.as_deref())
}

fn estimate_tokens(markdown: &str) -> usize {
    markdown.chars().count().div_ceil(4)
}

fn parse_container_rootfile(xml: &str) -> Result<String, EpubError> {
    for event in xml_events(xml, "META-INF/container.xml")? {
        if matches!(event.kind, XmlEventKind::Start | XmlEventKind::Empty)
            && local_name(&event.name) == "rootfile"
        {
            if let Some(path) = event.attrs.get("full-path") {
                return Ok(path.to_string());
            }
        }
    }
    Err(EpubError::MissingRootfile)
}

fn parse_opf(xml: &str, opf_path: &str) -> Result<OpfPackage, EpubError> {
    let base_dir = parent_dir(opf_path);
    let mut title = None;
    let mut authors = Vec::new();
    let mut language = None;
    let mut manifest = Vec::new();
    let mut spine_refs = Vec::new();
    let mut nav_item_id = None;
    let mut ncx_item_id = None;
    let mut current_text_tag: Option<String> = None;
    let mut current_text = String::new();

    for event in xml_events(xml, opf_path)? {
        match event.kind {
            XmlEventKind::Start | XmlEventKind::Empty => match local_name(&event.name) {
                "title" | "creator" | "language" => {
                    current_text_tag = Some(local_name(&event.name).to_string());
                    current_text.clear();
                }
                "item" => {
                    let id = attr_required(&event.attrs, "id");
                    let href = attr_required(&event.attrs, "href");
                    let media_type = attr_required(&event.attrs, "media-type");
                    let properties: Vec<String> = event
                        .attrs
                        .get("properties")
                        .map(|value| value.split_whitespace().map(str::to_string).collect())
                        .unwrap_or_default();
                    if properties.iter().any(|property| property == "nav") {
                        nav_item_id = Some(id.clone());
                    }
                    if media_type == "application/x-dtbncx+xml" {
                        ncx_item_id = Some(id.clone());
                    }
                    manifest.push(Asset {
                        absolute_path_in_archive: join_archive_path(&base_dir, &href),
                        id,
                        href,
                        media_type,
                        properties,
                    });
                }
                "itemref" => {
                    let idref = attr_required(&event.attrs, "idref");
                    let linear = event
                        .attrs
                        .get("linear")
                        .map(|value| value != "no")
                        .unwrap_or(true);
                    spine_refs.push(SpineRef { idref, linear });
                }
                "spine" => {
                    if let Some(toc_id) = event.attrs.get("toc") {
                        ncx_item_id = Some(toc_id.clone());
                    }
                }
                _ => {}
            },
            XmlEventKind::Text => {
                if current_text_tag.is_some() {
                    push_text(&mut current_text, &event.name);
                }
            }
            XmlEventKind::End => {
                if let Some(tag) = current_text_tag.clone() {
                    if local_name(&event.name) == tag {
                        let value = current_text.trim().to_string();
                        if !value.is_empty() {
                            match tag.as_str() {
                                "title" if title.is_none() => title = Some(value),
                                "creator" => authors.push(value),
                                "language" if language.is_none() => language = Some(value),
                                _ => {}
                            }
                        }
                        current_text_tag = None;
                        current_text.clear();
                    }
                }
            }
        }
    }

    Ok(OpfPackage {
        title,
        authors,
        language,
        manifest,
        spine_refs,
        nav_item_id,
        ncx_item_id,
        base_dir,
    })
}

fn parse_toc<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    package: &OpfPackage,
    assets_by_id: &HashMap<String, Asset>,
) -> Result<Vec<TocNode>, EpubError> {
    if let Some(nav_id) = &package.nav_item_id {
        if let Some(asset) = assets_by_id.get(nav_id) {
            let xml = read_entry_to_string(archive, &asset.absolute_path_in_archive)?;
            let toc = parse_nav_document(&xml, &asset.absolute_path_in_archive)?;
            if !toc.is_empty() {
                return Ok(toc);
            }
        }
    }

    if let Some(ncx_id) = &package.ncx_item_id {
        if let Some(asset) = assets_by_id.get(ncx_id) {
            let xml = read_entry_to_string(archive, &asset.absolute_path_in_archive)?;
            return parse_ncx_document(&xml, &asset.absolute_path_in_archive);
        }
    }

    Ok(Vec::new())
}

fn parse_nav_document(xml: &str, path: &str) -> Result<Vec<TocNode>, EpubError> {
    let mut nodes = Vec::new();
    let mut in_toc_nav = false;
    let mut nav_depth = 0usize;
    let mut pending_link: Option<(String, String)> = None;
    let mut text = String::new();
    let mut counter = 0usize;

    for event in xml_events(xml, path)? {
        match event.kind {
            XmlEventKind::Start | XmlEventKind::Empty => {
                let name = local_name(&event.name);
                if name == "nav" {
                    let nav_type = event
                        .attrs
                        .get("epub:type")
                        .or_else(|| event.attrs.get("type"))
                        .map(String::as_str);
                    in_toc_nav = nav_type == Some("toc");
                    nav_depth = usize::from(in_toc_nav);
                } else if in_toc_nav {
                    nav_depth += usize::from(event.kind == XmlEventKind::Start);
                    if name == "a" {
                        if let Some(href) = event.attrs.get("href") {
                            pending_link = Some((href.to_string(), String::new()));
                            text.clear();
                        }
                    }
                }
            }
            XmlEventKind::Text => {
                if pending_link.is_some() {
                    push_text(&mut text, &event.name);
                }
            }
            XmlEventKind::End => {
                let name = local_name(&event.name);
                if in_toc_nav && name == "a" {
                    if let Some((href, _)) = pending_link.take() {
                        let title = text.trim().to_string();
                        if !title.is_empty() {
                            counter += 1;
                            nodes.push(toc_node(counter, title, href));
                        }
                        text.clear();
                    }
                }
                if in_toc_nav {
                    nav_depth = nav_depth.saturating_sub(1);
                    if name == "nav" || nav_depth == 0 {
                        in_toc_nav = false;
                    }
                }
            }
        }
    }

    Ok(nodes)
}

fn parse_ncx_document(xml: &str, path: &str) -> Result<Vec<TocNode>, EpubError> {
    let mut nodes = Vec::new();
    let mut current_label = String::new();
    let mut current_src = None;
    let mut in_text = false;
    let mut counter = 0usize;

    for event in xml_events(xml, path)? {
        match event.kind {
            XmlEventKind::Start | XmlEventKind::Empty => {
                let name = local_name(&event.name);
                if name == "text" {
                    in_text = true;
                    current_label.clear();
                } else if name == "content" {
                    current_src = event.attrs.get("src").cloned();
                }
            }
            XmlEventKind::Text => {
                if in_text {
                    push_text(&mut current_label, &event.name);
                }
            }
            XmlEventKind::End => {
                let name = local_name(&event.name);
                if name == "text" {
                    in_text = false;
                } else if name == "navPoint" {
                    if let Some(src) = current_src.take() {
                        let title = current_label.trim().to_string();
                        if !title.is_empty() {
                            counter += 1;
                            nodes.push(toc_node(counter, title, src));
                        }
                    }
                    current_label.clear();
                }
            }
        }
    }

    Ok(nodes)
}

fn parse_content_document(
    xml: &str,
    href: &str,
    spine_item_id: &str,
) -> Result<ContentDocument, EpubError> {
    let mut nodes = Vec::new();
    let mut block: Option<BlockBuilder> = None;
    let mut list_items = Vec::new();
    let mut in_list = false;
    let mut counter = 0usize;
    let mut path_stack: Vec<String> = Vec::new();

    for event in xml_events(xml, href)? {
        match event.kind {
            XmlEventKind::Start | XmlEventKind::Empty => {
                let name = local_name(&event.name);
                path_stack.push(name.to_string());
                match name {
                    "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                        flush_block(&mut block, &mut nodes, href, spine_item_id, &mut counter);
                        block = Some(BlockBuilder::new(
                            ContentKind::Heading,
                            Some(name[1..].parse().unwrap_or(1)),
                            event.attrs,
                            dom_path(&path_stack),
                        ));
                    }
                    "p" => {
                        flush_block(&mut block, &mut nodes, href, spine_item_id, &mut counter);
                        block = Some(BlockBuilder::new(
                            ContentKind::Paragraph,
                            None,
                            event.attrs,
                            dom_path(&path_stack),
                        ));
                    }
                    "blockquote" => {
                        flush_block(&mut block, &mut nodes, href, spine_item_id, &mut counter);
                        block = Some(BlockBuilder::new(
                            ContentKind::Blockquote,
                            None,
                            event.attrs,
                            dom_path(&path_stack),
                        ));
                    }
                    "pre" | "code" if block.is_none() => {
                        flush_block(&mut block, &mut nodes, href, spine_item_id, &mut counter);
                        block = Some(BlockBuilder::new(
                            ContentKind::Code,
                            None,
                            event.attrs,
                            dom_path(&path_stack),
                        ));
                    }
                    "ul" | "ol" => {
                        flush_block(&mut block, &mut nodes, href, spine_item_id, &mut counter);
                        in_list = true;
                        list_items.clear();
                    }
                    "li" if in_list => {
                        flush_block(&mut block, &mut nodes, href, spine_item_id, &mut counter);
                        block = Some(BlockBuilder::new(
                            ContentKind::Paragraph,
                            None,
                            event.attrs,
                            dom_path(&path_stack),
                        ));
                    }
                    "img" => {
                        flush_block(&mut block, &mut nodes, href, spine_item_id, &mut counter);
                        counter += 1;
                        let alt = event.attrs.get("alt").cloned();
                        nodes.push(ContentNode {
                            id: node_id(spine_item_id, counter),
                            kind: ContentKind::Image,
                            text: alt,
                            level: None,
                            attrs: event.attrs,
                            children: Vec::new(),
                            source: LocationSource {
                                href: href.to_string(),
                                anchor: None,
                                dom_path: Some(dom_path(&path_stack)),
                            },
                        });
                    }
                    "hr" => {
                        flush_block(&mut block, &mut nodes, href, spine_item_id, &mut counter);
                        counter += 1;
                        nodes.push(ContentNode {
                            id: node_id(spine_item_id, counter),
                            kind: ContentKind::ThematicBreak,
                            text: None,
                            level: None,
                            attrs: event.attrs,
                            children: Vec::new(),
                            source: LocationSource {
                                href: href.to_string(),
                                anchor: None,
                                dom_path: Some(dom_path(&path_stack)),
                            },
                        });
                    }
                    _ => {}
                }
            }
            XmlEventKind::Text => {
                if let Some(builder) = &mut block {
                    push_text(&mut builder.text, &event.name);
                }
            }
            XmlEventKind::End => {
                let name = local_name(&event.name);
                if matches!(
                    name,
                    "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "blockquote" | "pre" | "code"
                ) {
                    if in_list && name == "li" {
                        if let Some(item) = block.take() {
                            list_items.push(item.into_node(href, &node_id(spine_item_id, 0)));
                        }
                    } else {
                        flush_block(&mut block, &mut nodes, href, spine_item_id, &mut counter);
                    }
                } else if name == "li" && in_list {
                    if let Some(item) = block.take() {
                        list_items.push(item.into_node(href, &node_id(spine_item_id, 0)));
                    }
                } else if matches!(name, "ul" | "ol") && in_list {
                    counter += 1;
                    for (idx, item) in list_items.iter_mut().enumerate() {
                        item.id = node_id(spine_item_id, counter * 1000 + idx + 1);
                    }
                    nodes.push(ContentNode {
                        id: node_id(spine_item_id, counter),
                        kind: ContentKind::List,
                        text: None,
                        level: None,
                        attrs: HashMap::new(),
                        children: std::mem::take(&mut list_items),
                        source: LocationSource {
                            href: href.to_string(),
                            anchor: None,
                            dom_path: Some(dom_path(&path_stack)),
                        },
                    });
                    in_list = false;
                }
                path_stack.pop();
            }
        }
    }
    flush_block(&mut block, &mut nodes, href, spine_item_id, &mut counter);

    Ok(ContentDocument {
        spine_item_id: spine_item_id.to_string(),
        href: href.to_string(),
        nodes,
    })
}

#[derive(Debug)]
struct BlockBuilder {
    kind: ContentKind,
    text: String,
    level: Option<u8>,
    attrs: HashMap<String, String>,
    dom_path: String,
}

impl BlockBuilder {
    fn new(
        kind: ContentKind,
        level: Option<u8>,
        attrs: HashMap<String, String>,
        dom_path: String,
    ) -> Self {
        Self {
            kind,
            text: String::new(),
            level,
            attrs,
            dom_path,
        }
    }

    fn into_node(self, href: &str, id: &str) -> ContentNode {
        let text = normalize_space(&self.text);
        ContentNode {
            id: id.to_string(),
            kind: self.kind,
            text: (!text.is_empty()).then_some(text),
            level: self.level,
            attrs: self.attrs,
            children: Vec::new(),
            source: LocationSource {
                href: href.to_string(),
                anchor: None,
                dom_path: Some(self.dom_path),
            },
        }
    }
}

fn flush_block(
    block: &mut Option<BlockBuilder>,
    nodes: &mut Vec<ContentNode>,
    href: &str,
    spine_item_id: &str,
    counter: &mut usize,
) {
    if let Some(builder) = block.take() {
        let text = normalize_space(&builder.text);
        if !text.is_empty() || builder.kind == ContentKind::ThematicBreak {
            *counter += 1;
            nodes.push(builder.into_node(href, &node_id(spine_item_id, *counter)));
        }
    }
}

fn xml_events(xml: &str, path: &str) -> Result<Vec<XmlEvent>, EpubError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut events = Vec::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => events.push(XmlEvent {
                kind: XmlEventKind::Start,
                name: qname_to_string(e.name().as_ref()),
                attrs: collect_attrs(&reader, &e),
            }),
            Ok(Event::Empty(e)) => events.push(XmlEvent {
                kind: XmlEventKind::Empty,
                name: qname_to_string(e.name().as_ref()),
                attrs: collect_attrs(&reader, &e),
            }),
            Ok(Event::End(e)) => events.push(XmlEvent {
                kind: XmlEventKind::End,
                name: qname_to_string(e.name().as_ref()),
                attrs: HashMap::new(),
            }),
            Ok(Event::Text(e)) => {
                let text = e.xml_content().map_err(|source| EpubError::Xml {
                    path: path.to_string(),
                    source: source.into(),
                })?;
                events.push(XmlEvent {
                    kind: XmlEventKind::Text,
                    name: text.to_string(),
                    attrs: HashMap::new(),
                });
            }
            Ok(Event::CData(e)) => {
                let text = e.xml_content().map_err(|source| EpubError::Xml {
                    path: path.to_string(),
                    source: source.into(),
                })?;
                events.push(XmlEvent {
                    kind: XmlEventKind::Text,
                    name: text.to_string(),
                    attrs: HashMap::new(),
                });
            }
            Ok(Event::Eof) => break,
            Err(source) => {
                return Err(EpubError::Xml {
                    path: path.to_string(),
                    source,
                });
            }
            _ => {}
        }
    }

    Ok(events)
}

fn collect_attrs(reader: &Reader<&[u8]>, e: &BytesStart<'_>) -> HashMap<String, String> {
    e.attributes()
        .with_checks(false)
        .filter_map(Result::ok)
        .map(|attr| {
            let key = qname_to_string(attr.key.as_ref());
            let value = attr
                .decode_and_unescape_value(reader.decoder())
                .map(|value| value.to_string())
                .unwrap_or_else(|_| String::from_utf8_lossy(&attr.value).to_string());
            (key, value)
        })
        .collect()
}

fn read_entry_to_string<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    path: &str,
) -> Result<String, EpubError> {
    let mut file = archive.by_name(path)?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    Ok(contents)
}

fn toc_node(counter: usize, title: String, href: String) -> TocNode {
    let (href, anchor) = split_anchor(&href);
    TocNode {
        id: format!("toc_{counter:06}"),
        title,
        href,
        anchor,
        children: Vec::new(),
    }
}

fn attr_required(attrs: &HashMap<String, String>, key: &str) -> String {
    attrs.get(key).cloned().unwrap_or_default()
}

fn local_name(name: &str) -> &str {
    name.rsplit_once(':')
        .map(|(_, local)| local)
        .unwrap_or(name)
}

fn split_anchor(href: &str) -> (String, Option<String>) {
    if let Some((path, anchor)) = href.split_once('#') {
        (path.to_string(), Some(anchor.to_string()))
    } else {
        (href.to_string(), None)
    }
}

fn qname_to_string(name: &[u8]) -> String {
    String::from_utf8_lossy(name).to_string()
}

fn push_text(output: &mut String, text: &str) {
    if !output.is_empty() && !output.ends_with(char::is_whitespace) {
        output.push(' ');
    }
    output.push_str(text);
}

fn normalize_space(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parent_dir(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

fn join_archive_path(base_dir: &str, href: &str) -> String {
    let joined = if base_dir.is_empty() {
        PathBuf::from(href)
    } else {
        Path::new(base_dir).join(href)
    };
    joined.to_string_lossy().replace('\\', "/")
}

fn dom_path(path_stack: &[String]) -> String {
    path_stack.join("/")
}

fn node_id(spine_item_id: &str, counter: usize) -> String {
    format!("{spine_item_id}_{counter:06}")
}

fn stable_id(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    format!("book_{:x}", digest)[..21].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    #[test]
    fn parses_epub_metadata_spine_toc_and_content_nodes() {
        let epub = fixture_epub();
        let book = open_epub_bytes(&epub).expect("valid fixture EPUB parses");

        assert_eq!(book.title, "Fixture Systems");
        assert_eq!(book.authors, vec!["Ada Example"]);
        assert_eq!(book.language.as_deref(), Some("en"));
        assert_eq!(book.spine.len(), 2);
        assert_eq!(book.toc.len(), 2);
        assert_eq!(book.toc[0].title, "Chapter 1");
        assert_eq!(book.toc[0].anchor.as_deref(), Some("ch1"));

        let chapter = &book.spine[0];
        assert_eq!(chapter.href, "chapters/ch1.xhtml");
        assert_eq!(chapter.title.as_deref(), Some("Chapter 1"));
        assert_eq!(chapter.content.nodes[0].kind, ContentKind::Heading);
        assert_eq!(chapter.content.nodes[1].kind, ContentKind::Paragraph);
        assert_eq!(
            chapter.content.nodes[1].text.as_deref(),
            Some("Replication keeps copies of data.")
        );
        assert!(
            chapter
                .content
                .nodes
                .iter()
                .any(|node| node.kind == ContentKind::List)
        );
    }

    #[test]
    fn generates_chapter_markdown_with_metadata_and_excerpt() {
        let epub = fixture_epub();
        let book = open_epub_bytes(&epub).expect("valid fixture EPUB parses");
        let packet = generate_chapter_markdown(&book, "ch1").expect("chapter renders");

        assert!(packet.markdown.contains("# Extracted Markdown"));
        assert!(packet.markdown.contains("Book: Fixture Systems"));
        assert!(packet.markdown.contains("Author: Ada Example"));
        assert!(packet.markdown.contains("Chapter: Chapter 1"));
        assert!(packet.markdown.contains("- Chapter 1"));
        assert!(packet.markdown.contains("Location: chapters/ch1.xhtml"));
        assert!(packet.markdown.contains("# Chapter 1"));
        assert!(
            packet
                .markdown
                .contains("Replication keeps copies of data.")
        );
        assert!(packet.markdown.contains("- Leader"));
        assert!(packet.estimated_tokens > 0);
        assert_eq!(packet.heading_ancestry, vec!["Chapter 1"]);
    }

    #[test]
    fn fails_when_container_is_missing() {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("mimetype", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"application/epub+zip").unwrap();
        let bytes = zip.finish().unwrap().into_inner();

        let err = open_epub_bytes(&bytes).expect_err("missing container should fail");
        assert!(matches!(err, EpubError::MissingContainer));
    }

    fn fixture_epub() -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();

        add_file(
            &mut zip,
            options,
            "META-INF/container.xml",
            r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
        );

        add_file(
            &mut zip,
            options,
            "OEBPS/package.opf",
            r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Fixture Systems</dc:title>
    <dc:creator>Ada Example</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="chapters/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapters/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>"#,
        );

        add_file(
            &mut zip,
            options,
            "OEBPS/nav.xhtml",
            r#"<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="chapters/ch1.xhtml#ch1">Chapter 1</a></li>
        <li><a href="chapters/ch2.xhtml#ch2">Chapter 2</a></li>
      </ol>
    </nav>
  </body>
</html>"#,
        );

        add_file(
            &mut zip,
            options,
            "OEBPS/chapters/ch1.xhtml",
            r#"<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <h1 id="ch1">Chapter 1</h1>
    <p>Replication keeps <em>copies</em> of data.</p>
    <ul>
      <li>Leader</li>
      <li>Follower</li>
    </ul>
  </body>
</html>"#,
        );

        add_file(
            &mut zip,
            options,
            "OEBPS/chapters/ch2.xhtml",
            r#"<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <h1 id="ch2">Chapter 2</h1>
    <p>Indexes speed up reads.</p>
  </body>
</html>"#,
        );

        zip.finish().unwrap().into_inner()
    }

    fn add_file(
        zip: &mut zip::ZipWriter<Cursor<Vec<u8>>>,
        options: SimpleFileOptions,
        path: &str,
        contents: &str,
    ) {
        zip.start_file(path, options).unwrap();
        zip.write_all(contents.as_bytes()).unwrap();
    }
}
