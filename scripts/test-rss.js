#!/usr/bin/env node
// Quick test: does rss-parser parse the nitter RSS feed for a given handle?
// Usage: node scripts/test-rss.js [handle]
// Default handle: Crypto_peet

const RssParser = require('rss-parser');
const rss = new RssParser();

const handle = process.argv[2] || 'Crypto_peet';
const url = `https://nitter.net/${encodeURIComponent(handle)}/rss`;

(async () => {
  console.log(`Fetching: ${url}`);
  const t0 = Date.now();
  try {
    const feed = await rss.parseURL(url);
    const ms = Date.now() - t0;
    console.log(`Parsed in ${ms}ms`);
    console.log('title:    ', feed?.title);
    console.log('link:     ', feed?.link);
    console.log('items:    ', Array.isArray(feed?.items) ? feed.items.length : 'NOT AN ARRAY');

    if (Array.isArray(feed?.items) && feed.items.length) {
      console.log('\n--- first item ---');
      const it = feed.items[0];
      console.log('guid:    ', it.guid);
      console.log('link:    ', it.link);
      console.log('title:   ', it.title);
      console.log('author:  ', it.creator ?? it.author);
      console.log('date:    ', it.isoDate ?? it.pubDate);
      console.log('content: ', (it.contentSnippet ?? it.content ?? '').slice(0, 120));
      console.log('\n--- item keys ---');
      console.log(Object.keys(it));
    }
  } catch (err) {
    const ms = Date.now() - t0;
    console.error(`Failed after ${ms}ms: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
})();