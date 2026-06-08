import type { ParsedFeed, ParsedFeedItem } from "./types.js";

// ────────────────────────────────────────
// Zero-dependency feed parser
// ────────────────────────────────────────
// Supports RSS 2.0, Atom, RDF/RSS 1.0, and JSON Feed.
// Uses regex-based XML extraction.

export function parseFeed(raw: string, feedUrl: string): ParsedFeed {
  const trimmed = raw.trim();

  // JSON Feed — starts with {
  if (trimmed.startsWith("{")) {
    return parseJsonFeed(trimmed);
  }

  // Detect Atom vs RSS
  if (trimmed.includes("<feed") && trimmed.includes('xmlns="http://www.w3.org/2005/Atom"')) {
    return parseAtom(trimmed, feedUrl);
  }

  if (trimmed.includes("<rss") || trimmed.includes("<channel>")) {
    return parseRss2(trimmed);
  }

  if (trimmed.includes("rdf:RDF") || trimmed.includes("<rdf:")) {
    return parseRdf(trimmed);
  }

  // Fallback: try RSS2 parsing
  return parseRss2(trimmed);
}

// ── RSS 2.0 ─────────────────────────────────────────────────────────

function parseRss2(xml: string): ParsedFeed {
  const channel = extractTag(xml, "channel") ?? xml;

  const items = extractAllTags(channel, "item").map((itemXml): ParsedFeedItem => {
    const guid =
      extractTagText(itemXml, "guid") ||
      extractTagText(itemXml, "link") ||
      extractTagText(itemXml, "title") ||
      "";
    return {
      guid,
      title: extractTagText(itemXml, "title") || "Untitled",
      link: extractTagText(itemXml, "link"),
      content:
        extractCDATA(itemXml, "content:encoded") ||
        extractTagText(itemXml, "content:encoded") ||
        extractCDATA(itemXml, "description") ||
        extractTagText(itemXml, "description"),
      summary:
        extractCDATA(itemXml, "description") ||
        extractTagText(itemXml, "description"),
      author:
        extractTagText(itemXml, "dc:creator") ||
        extractTagText(itemXml, "author"),
      published_at: parseDate(extractTagText(itemXml, "pubDate")),
    };
  });

  return {
    title: extractTagText(channel, "title") || "Untitled Feed",
    description: extractTagText(channel, "description"),
    site_url: extractChannelLink(channel),
    icon_url: extractTagText(extractTag(channel, "image") ?? "", "url"),
    items,
  };
}

// ── Atom ────────────────────────────────────────────────────────────

function parseAtom(xml: string, feedUrl: string): ParsedFeed {
  const entries = extractAllTags(xml, "entry").map((entryXml): ParsedFeedItem => {
    return {
      guid:
        extractTagText(entryXml, "id") ||
        extractAtomLink(entryXml, "alternate") ||
        extractTagText(entryXml, "title") ||
        "",
      title: extractTagText(entryXml, "title") || "Untitled",
      link: extractAtomLink(entryXml, "alternate") || extractAtomLink(entryXml),
      content:
        extractCDATA(entryXml, "content") ||
        extractTagText(entryXml, "content") ||
        extractCDATA(entryXml, "summary") ||
        extractTagText(entryXml, "summary"),
      summary:
        extractCDATA(entryXml, "summary") ||
        extractTagText(entryXml, "summary"),
      author: extractTagText(extractTag(entryXml, "author") ?? "", "name"),
      published_at: parseDate(
        extractTagText(entryXml, "published") ||
          extractTagText(entryXml, "updated")
      ),
    };
  });

  return {
    title: extractTagText(xml, "title") || "Untitled Feed",
    description: extractTagText(xml, "subtitle"),
    site_url: extractAtomLink(xml, "alternate") || extractAtomLink(xml),
    icon_url: extractTagText(xml, "icon") || extractTagText(xml, "logo"),
    items: entries,
  };
}

// ── RDF / RSS 1.0 ───────────────────────────────────────────────────

function parseRdf(xml: string): ParsedFeed {
  const channel = extractTag(xml, "channel") ?? "";
  const items = extractAllTags(xml, "item").map((itemXml): ParsedFeedItem => ({
    guid:
      extractAttr(itemXml, "item", "rdf:about") ||
      extractTagText(itemXml, "link") ||
      extractTagText(itemXml, "title") ||
      "",
    title: extractTagText(itemXml, "title") || "Untitled",
    link: extractTagText(itemXml, "link"),
    content:
      extractCDATA(itemXml, "content:encoded") ||
      extractTagText(itemXml, "description"),
    summary: extractTagText(itemXml, "description"),
    author: extractTagText(itemXml, "dc:creator"),
    published_at: parseDate(extractTagText(itemXml, "dc:date")),
  }));

  return {
    title: extractTagText(channel, "title") || "Untitled Feed",
    description: extractTagText(channel, "description"),
    site_url: extractTagText(channel, "link"),
    items,
  };
}

// ── JSON Feed ───────────────────────────────────────────────────────

function parseJsonFeed(raw: string): ParsedFeed {
  const feed = JSON.parse(raw);
  return {
    title: feed.title || "Untitled Feed",
    description: feed.description,
    site_url: feed.home_page_url,
    icon_url: feed.icon || feed.favicon,
    items: (feed.items || []).map(
      (item: Record<string, unknown>): ParsedFeedItem => ({
        guid: String(item.id ?? item.url ?? ""),
        title: String(item.title ?? "Untitled"),
        link: String(item.url ?? item.external_url ?? ""),
        content: String(item.content_html ?? item.content_text ?? ""),
        summary: item.summary ? String(item.summary) : undefined,
        author: extractJsonAuthor(item),
        published_at: parseDate(
          item.date_published ? String(item.date_published) : undefined
        ),
      })
    ),
  };
}

// ── XML Helpers (regex-based) ───────────────────────────────────────

function extractTag(xml: string, tag: string): string | undefined {
  const regex = new RegExp(
    `<${escapeRegex(tag)}(\\s[^>]*)?>([\\s\\S]*?)</${escapeRegex(tag)}>`,
    "i"
  );
  const match = xml.match(regex);
  return match ? match[2] : undefined;
}

function extractAllTags(xml: string, tag: string): string[] {
  const regex = new RegExp(
    `<${escapeRegex(tag)}(\\s[^>]*)?>([\\s\\S]*?)</${escapeRegex(tag)}>`,
    "gi"
  );
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[2]);
  }
  return results;
}

function extractTagText(xml: string, tag: string): string | undefined {
  const inner = extractTag(xml, tag);
  if (!inner) return undefined;
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return inner.replace(/<[^>]+>/g, "").trim() || undefined;
}

function extractCDATA(xml: string, tag: string): string | undefined {
  const regex = new RegExp(
    `<${escapeRegex(tag)}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${escapeRegex(tag)}>`,
    "i"
  );
  const match = xml.match(regex);
  return match ? match[1].trim() : undefined;
}

function extractAtomLink(xml: string, rel?: string): string | undefined {
  const linkRegex = /<link\s([^>]*?)(?:\/>|><\/link>)/gi;
  let match: RegExpExecArray | null;
  let fallback: string | undefined;

  while ((match = linkRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const href = extractAttrFromString(attrs, "href");
    const linkRel = extractAttrFromString(attrs, "rel");

    if (rel && linkRel === rel && href) return href;
    if (!rel && !linkRel && href) return href;
    if (href && !fallback) fallback = href;
  }
  return fallback;
}

function extractAttr(xml: string, tag: string, attr: string): string | undefined {
  const regex = new RegExp(`<${escapeRegex(tag)}\\s([^>]*?)>`, "i");
  const match = xml.match(regex);
  if (!match) return undefined;
  return extractAttrFromString(match[1], attr);
}

function extractAttrFromString(attrs: string, name: string): string | undefined {
  const regex = new RegExp(`${escapeRegex(name)}\\s*=\\s*["']([^"']*)["']`, "i");
  const match = attrs.match(regex);
  return match ? match[1] : undefined;
}

function extractChannelLink(channel: string): string | undefined {
  const match = channel.match(/<link>([^<]+)<\/link>/i);
  return match ? match[1].trim() : undefined;
}

function extractJsonAuthor(item: Record<string, unknown>): string | undefined {
  const authors = item.authors;
  if (Array.isArray(authors) && authors.length > 0) {
    return String(authors[0]?.name ?? "");
  }
  const author = item.author as Record<string, unknown> | undefined;
  return author?.name ? String(author.name) : undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDate(val?: string): string | undefined {
  if (!val) return undefined;
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return undefined;
    return d.toISOString();
  } catch {
    return undefined;
  }
}
