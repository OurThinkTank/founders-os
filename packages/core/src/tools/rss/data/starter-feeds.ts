// ────────────────────────────────────────
// Curated starter feeds
// ────────────────────────────────────────
// Bundled in the package as static seed data.
// Imported per-user via import_starter_feeds tool.
// Tags replace the old single-category model.
// pinDefault marks feeds that should be pinned on import
// (drives the morning briefing - keep to ~6 max).

export interface StarterFeed {
  url: string;
  tags: string[];
  pinDefault?: boolean;
}

export const STARTER_FEEDS: StarterFeed[] = [
  // ── Tech ──────────────────────────────────────────
  {
    url: "https://feeds.arstechnica.com/arstechnica/index",
    tags: ["tech"],
  },
  {
    url: "https://www.theverge.com/rss/index.xml",
    tags: ["tech"],
  },
  {
    url: "https://restofworld.org/feed/latest",
    tags: ["tech"],
  },
  {
    url: "https://www.404media.co/rss/",
    tags: ["tech"],
    pinDefault: true,
  },

  // ── AI ────────────────────────────────────────────
  {
    url: "https://openai.com/blog/rss.xml",
    tags: ["ai"],
  },
  {
    url: "https://simonwillison.net/atom/everything/",
    tags: ["ai"],
    pinDefault: true,
  },

  // ── Product & Design ──────────────────────────────
  {
    url: "https://www.svpg.com/feed/",
    tags: ["product"],
  },

  // ── Engineering ───────────────────────────────────
  {
    url: "https://martinfowler.com/feed.atom",
    tags: ["engineering"],
  },
  {
    url: "https://blog.pragmaticengineer.com/rss/",
    tags: ["engineering"],
    pinDefault: true,
  },

  // ── Business ─────────────────────────────────────
  {
    url: "https://finance.yahoo.com/news/rssindex",
    tags: ["business"],
  },
  {
    url: "https://www.investing.com/rss/news.rss",
    tags: ["business"],
  },
  {
    url: "https://seekingalpha.com/market_currents.xml",
    tags: ["business"],
  },
  {
    url: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
    tags: ["business"],
    pinDefault: true,
  },
  {
    url: "http://feeds.marketwatch.com/marketwatch/bulletins",
    tags: ["business"],
  },

  // ── Crypto & Web3 ────────────────────────────────
  {
    url: "https://www.therage.co/rss/",
    tags: ["crypto"],
  },
  {
    url: "https://www.citationneeded.news/rss/",
    tags: ["crypto", "tech"],
  },
  {
    url: "https://www.web3isgoinggreat.com/feed.xml",
    tags: ["crypto", "web3"],
  },

  // ── News ─────────────────────────────────────────
  {
    url: "http://feeds.bbci.co.uk/news/world/rss.xml",
    tags: ["news"],
    pinDefault: true,
  },
  {
    url: "http://www.aljazeera.com/xml/rss/all.xml",
    tags: ["news"],
  },
  {
    url: "https://rss.beehiiv.com/feeds/owMwaGYU36.xml",
    tags: ["news"],
  },
  {
    url: "https://feeds.propublica.org/propublica/main",
    tags: ["news"],
  },
  {
    url: "https://fixthenews.com/feed",
    tags: ["news"],
  },
  {
    url: "https://www.wired.com/feed/rss",
    tags: ["news", "tech"],
  },

  // ── Special Interest ─────────────────────────────
  {
    url: "https://publicdomainreview.org/rss.xml",
    tags: ["special-interest"],
  },
  {
    url: "https://cabel.com/feed/",
    tags: ["tech", "special-interest"],
  },
  {
    url: "https://maggieappleton.com/rss.xml",
    tags: ["tech", "special-interest"],
  },
  {
    url: "https://blog.codinghorror.com/rss/",
    tags: ["tech", "special-interest"],
  },

  // ── Web & AT Protocol ────────────────────────────
  {
    url: "https://buttondown.email/ownyourweb/rss",
    tags: ["web"],
  },
  {
    url: "https://www.pfrazee.com/feed.xml",
    tags: ["atproto", "tech"],
    pinDefault: true,
  },
];
