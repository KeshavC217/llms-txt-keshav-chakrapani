import { test } from "node:test";
import assert from "node:assert/strict";

import { cleanText, decodeEntities, isElement, linkDensity, parseHtml, walk } from "../lib/dom.ts";
import { MALFORMED } from "./fixtures.ts";

const find = (html: string, tag: string) => [...walk(parseHtml(html))].find((node) => node.tag === tag)!;

test("nesting is preserved", () => {
  const root = parseHtml("<div><p>one<span>two</span></p></div>");
  const div = find("<div><p>one<span>two</span></p></div>", "div");
  assert.equal(div.children.length, 1);
  assert.equal(cleanText(root), "one two");
});

test("void elements do not swallow what follows", () => {
  // <img> never closes, so a naive stack would nest the rest of the page in it.
  const root = parseHtml("<div><img src='a.png'><p>after</p></div>");
  const div = find("<div><img src='a.png'><p>after</p></div>", "div");
  assert.deepEqual(div.children.filter(isElement).map((node) => node.tag), ["img", "p"]);
  assert.equal(cleanText(root), "after");
});

test("script and style content is not read as markup or as text", () => {
  const html = "<main><script>var a = \"<a href='/x'>no</a>\";</script><p>real</p></main>";
  const root = parseHtml(html);
  assert.equal(cleanText(root), "real");
  assert.equal([...walk(root)].filter((node) => node.tag === "a").length, 0);
});

test("an unclosed <p> is closed by its next sibling", () => {
  const root = parseHtml("<div><p>one<p>two</div>");
  const paragraphs = [...walk(root)].filter((node) => node.tag === "p");
  assert.equal(paragraphs.length, 2);
  assert.equal(cleanText(paragraphs[0]), "one");
});

test("an unmatched close tag does not unwind the whole document", () => {
  // Real pages carry stray </div>s; losing the rest of the tree over one
  // would throw away the page.
  const root = parseHtml("<main><p>kept</p></div><p>also kept</p></main>");
  assert.match(cleanText(root), /kept.*also kept/);
});

test("attributes are read regardless of quoting", () => {
  const anchor = find(`<a href="/a" title='t' data-x=y class=z>link</a>`, "a");
  assert.equal(anchor.attrs.href, "/a");
  assert.equal(anchor.attrs.title, "t");
  assert.equal(anchor.attrs["data-x"], "y");
  assert.equal(anchor.attrs.class, "z");
});

test("entities are decoded, numeric and named", () => {
  assert.equal(decodeEntities("Guides &amp; API &#8212; &#x27;&nbsp;end"), "Guides & API — ' end");
  // An entity with no mapping is left as written rather than mangled.
  assert.equal(decodeEntities("&hearts;"), "&hearts;");
});

test("cleanText closes the gap markup leaves before punctuation", () => {
  // <em>ed</em>, would otherwise read as "ed ,".
  assert.equal(cleanText(parseHtml("<p><em>ed</em>, the editor</p>")), "ed, the editor");
});

test("cleanText drops zero-width characters", () => {
  assert.equal(cleanText(parseHtml("<a>​Client SDKs</a>")), "Client SDKs");
});

test("linkDensity separates a nav from a paragraph", () => {
  const nav = find("<nav><a href='/a'>Alpha</a><a href='/b'>Beta</a></nav>", "nav");
  const prose = find("<p>A sentence with <a href='/a'>one link</a> in it and much more text besides.</p>", "p");
  assert.ok(linkDensity(nav) > 0.8, `nav was ${linkDensity(nav)}`);
  assert.ok(linkDensity(prose) < 0.3, `prose was ${linkDensity(prose)}`);
});

test("malformed markup still yields its links and prose", () => {
  const root = parseHtml(MALFORMED);
  const hrefs = [...walk(root)].filter((node) => node.tag === "a").map((node) => node.attrs.href);
  assert.deepEqual(hrefs, ["/parts/one", "/parts/two"]);
  assert.match(cleanText(root), /unclosed heading/);
});
