# markdown-render-speed-02-entry

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![make.fun](https://img.shields.io/badge/make.fun-markdown--render--speed--02-blue)](https://make.fun/c/markdown-render-speed-02)
[![Practice cases](https://img.shields.io/badge/practice%20cases-720%2F720-brightgreen)](https://github.com/saifulsidik801-ship-it/markdown-render-speed-02-entry)

A fast, dependency-free Markdown renderer that matches
[marked](https://github.com/markedjs/marked) 18.1.3 output byte-for-byte, built
for the [make.fun](https://make.fun/c/markdown-render-speed-02)
`markdown-render-speed-02` competition ($250).

## What it is

- `parse.js` — a single dependency-free ES module. `parse(markdown)` returns
  exactly what `marked.parse` returns with default options (GFM on, breaks
  off, pedantic off, async off): CommonMark 0.31.2 + GFM 0.29, including
  tables, footnotes-style strikethrough, autolinks, task lists and setext
  headings.
- `main.ts` — the driver: reads `/input/cases.json`, renders each case on its
  own with `parse()`, writes the HTML strings in order to
  `/output/html.json`.

## Correctness

All 720 practice cases pass byte-for-byte against marked 18.1.3 (680 spec
examples + 40 generated README documents, ~2.85M characters total).

## Speed

On the practice document set, this renderer runs about **1.66x faster than
marked itself** (median ~406 ms vs ~673 ms, local VM, Node 24, 9 interleaved
runs). No caching or memoisation across `parse()` calls, no input
recognition — the speed comes from the parser itself:

- a hybrid plain-text scanner: one cheap native regex finds the next place a
  text run can stop, with JS validation only at candidate positions;
- per-character dispatch in the inline loop and in the list scanner, so the
  big rule regexes are only tried when the first character can start them;
- cached regex factories, fast paths for URLs, HTML escaping and tab
  expansion, and a backwards scan for emphasis closers.

## Use

```js
import { parse } from './parse.js';

parse('# Hello\n\nSome **bold** text.');
// '<h1>Hello</h1>\n<p>Some <strong>bold</strong> text.</p>\n'
```

Requires Node 22+ (ES modules, no dependencies).

## License

MIT — see [LICENSE](LICENSE).
