function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function attributesFrom(tag) {
  const attributes = new Map();
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of tag.matchAll(pattern)) {
    attributes.set(match[1].toLowerCase(), decodeEntities(match[2] ?? match[3]));
  }
  return attributes;
}

class SimpleAnchor {
  constructor(tag, content) {
    this.attributes = attributesFrom(tag);
    this.textContent = decodeEntities(content.replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  }

  getAttribute(name) {
    return this.attributes.get(name.toLowerCase()) ?? null;
  }
}

function anchorNodes(html, adsOnly = false) {
  const anchors = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const tag = `<a${match[1]}>`;
    const anchor = new SimpleAnchor(tag, match[2]);
    const href = anchor.getAttribute("href") || "";
    const classes = (anchor.getAttribute("class") || "").split(/\s+/);
    if (adsOnly ? classes.includes("ads") && href : href.includes("photos-index-aid-")) {
      anchors.push(anchor);
    }
  }
  return anchors;
}

class SimpleAlbumNode {
  constructor(html) {
    this.html = html;
  }

  querySelector() {
    return anchorNodes(this.html)[0] ?? null;
  }
}

class SimpleDocument {
  constructor(html) {
    this.html = html;
  }

  querySelectorAll(selector) {
    if (selector === ".gallary_item") {
      const items = [];
      const pattern = /<li\b[^>]*class=(?:"[^"]*\bgallary_item\b[^"]*"|'[^']*\bgallary_item\b[^']*')[^>]*>([\s\S]*?)<\/li>/gi;
      for (const match of this.html.matchAll(pattern)) {
        items.push(new SimpleAlbumNode(match[1]));
      }
      return items;
    }
    if (selector === "a.ads[href]") return anchorNodes(this.html, true);
    return [];
  }
}

export class SimpleDOMParser {
  parseFromString(html) {
    return new SimpleDocument(String(html));
  }
}
