export interface PageInfo {
  url: string;
  title: string;
  description?: string;
}

/**
 * A category from the site's own nav bar: a human-authored label plus the
 * pages it covers, either linked directly or nested under it via path prefix
 * (e.g. a "Docs" nav item linking to /docs covers /docs/getting-started too).
 */
export interface NavCategory {
  label: string;
  hrefs: Set<string>;
  pathPrefixes: string[];
}

export interface CrawlResult {
  rootUrl: string;
  siteTitle: string;
  siteDescription?: string;
  pages: PageInfo[];
  navCategories: NavCategory[];
}
