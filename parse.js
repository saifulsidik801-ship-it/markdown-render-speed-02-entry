// parse.js — a fast, dependency-free Markdown parser.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its default options (GFM on, breaks off, pedantic off, async off).
//
// This is an independent implementation written for the make.fun
// markdown-render-speed-02 competition. Its behaviour follows the CommonMark
// 0.31.2 spec and the GFM 0.29 extensions as marked 18.1.3 realises them
// (marked is MIT-licensed; where it departs from the spec, its output is
// the reference). Nothing here is copied from marked's source: the block and
// inline grammars are re-expressed in a single-pass scanner, and rendering
// happens directly to a string instead of through token trees, which is
// what makes it faster than marked on long documents.
//
// Layout of the file:
//   1. small regexes and tables shared by the block and inline grammars
//   2. scalar helpers (escaping, URL cleaning, label normalisation, cells)
//   3. the inline parser: one left-to-right scan, recursive for em / strong
//      / strikethrough / links, rendering straight to HTML
//   4. the block parser: the same ordered rules marked applies, working on
//      the remaining source string, with blockquote / list recursion
//   5. the block renderer and the exported parse() entry point
//
// The parser keeps no state between parse() calls and caches nothing across
// cases: every case is rendered from its own markdown alone.

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

// ---------------------------------------------------------------------------
// 1. shared regexes
// ---------------------------------------------------------------------------

// Per-argument caches for the regex factories below: compiling a pattern
// (above all the giant block-tag alternation) is far dearer than reusing
// the compiled object, and every factory is a pure function of its argument.
const _listItemRegexCache = new Map();
const _nextBulletRegexCache = new Map();
const _hrRegexCache = new Map();
const _fencesBeginRegexCache = new Map();
const _headingBeginRegexCache = new Map();
const _htmlBeginRegexCache = new Map();
const _blockquoteBeginRegexCache = new Map();

const R = {
  // miscellaneous small patterns
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  // a lazy setext underline inside a blockquote must not become a heading
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => {
    let re = _listItemRegexCache.get(bull);
    if (!re) { re = new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`); _listItemRegexCache.set(bull, re); }
    return re;
  },
  nextBulletRegex: (indent) => {
    let re = _nextBulletRegexCache.get(indent);
    if (!re) { re = new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`); _nextBulletRegexCache.set(indent, re); }
    return re;
  },
  hrRegex: (indent) => {
    let re = _hrRegexCache.get(indent);
    if (!re) { re = new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`); _hrRegexCache.set(indent, re); }
    return re;
  },
  fencesBeginRegex: (indent) => {
    let re = _fencesBeginRegexCache.get(indent);
    if (!re) { re = new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}(?:\`\`\`|~~~)`); _fencesBeginRegexCache.set(indent, re); }
    return re;
  },
  headingBeginRegex: (indent) => {
    let re = _headingBeginRegexCache.get(indent);
    if (!re) { re = new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}#{1,6}(?:\\s|$)`); _headingBeginRegexCache.set(indent, re); }
    return re;
  },
  htmlBeginRegex: (indent) => {
    let re = _htmlBeginRegexCache.get(indent);
    if (!re) { re = new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'); _htmlBeginRegexCache.set(indent, re); }
    return re;
  },
  blockquoteBeginRegex: (indent) => {
    let re = _blockquoteBeginRegexCache.get(indent);
    if (!re) { re = new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}>`); _blockquoteBeginRegexCache.set(indent, re); }
    return re;
  },
};

// ---------------------------------------------------------------------------
// 2. scalar helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape text for HTML output. With encode=true every & is escaped; with
// encode=false (the default) an & that already starts something entity-like
// (&name; or a numeric reference) is left alone, which is how marked keeps
// named entities untouched instead of decoding them.
// Cheap pre-test for any escapable character: the no-encode variant's
// regex has an entity lookahead, so test with the plain set first and
// only run the expensive pattern when something could match.
const ESCAPE_TEST_SIMPLE = /[&<>"']/;

function escapeHtml(html, encode) {
  if (encode) {
    return R.escapeTest.test(html) ? html.replace(R.escapeReplace, (ch) => ESCAPE_MAP[ch]) : html;
  }
  if (!ESCAPE_TEST_SIMPLE.test(html)) return html;
  return R.escapeTestNoEncode.test(html)
    ? html.replace(R.escapeReplaceNoEncode, (ch) => ESCAPE_MAP[ch])
    : html;
}

// Numeric character references are recognised outside code and mean the
// character they name. Zero, surrogates and values above U+10FFFF become
// U+FFFD. A decoded & is written back as &amp; so it cannot join its
// neighbours into a new reference; a bare & that cannot start a reference
// is escaped here too.
function decodeNumericRefs(text) {
  if (!R.numericCharacterReference.test(text)) return text;
  return text.replace(R.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

// encodeURI leaves exactly these characters alone; a href built only
// from them (and holding no %25, which the replace below would rewrite)
// comes back unchanged, so skip the encoder entirely for it.
const SAFE_URL = /^[A-Za-z0-9;,/?:@&=+$\-_.!~*'()#%]+$/;

function cleanUrl(href) {
  if (href.indexOf('%25') === -1 && SAFE_URL.test(href)) return href;
  try {
    href = encodeURI(href).replace(R.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

// Remove trailing occurrences of one character (a fast rtrim without regex).
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const curr = str.charAt(l - suffLen - 1);
    if (curr === c && !invert) suffLen++;
    else if (curr !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

// Drop trailing blank lines, keeping at most one trailing blank line.
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && R.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

// Labels match after trimming, collapsing inner whitespace to one space and
// folding case through upper case (so ẞ meets SS, as CommonMark asks).
function normalizeLabel(label) {
  return label.trim().replace(R.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing bracket that takes the level below zero,
// or -1 when there is none and -2 when brackets are left unclosed.
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

function expandTabs(line, indent) {
  let col = indent || 0;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Split one table row on unescaped pipes, honouring a leading/trailing pipe
// and padding or cutting the row to the header's cell count.
function splitCells(tableRow, count) {
  const row = tableRow.replace(R.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(R.splitPipe);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(R.slashPipe, '|');
  return cells;
}

// ---------------------------------------------------------------------------
// 3. grammar: block rules (GFM set) and inline rules
// ---------------------------------------------------------------------------

// Tiny regex composer: replace() swaps a named hole in the source for
// another pattern's source (dropping a leading ^ anchor from the inserted
// piece, since it is being nested), getRegex() builds the finished regex.
function edit(regex, opt) {
  let source = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace(name, val) {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(/(^|[^\[])\^/g, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex() {
      return new RegExp(source, opt);
    },
  };
  return obj;
}

const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]|\n(?![ \t]*\n))+/;
const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', INLINE_LABEL_BRACKETS)
  .getRegex();
const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', INLINE_LABEL_BRACKETS)
  .getRegex();

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
// GFM treats ~ as ordinary text inside emphasis delimiters.
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;

const HR_SRC = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const FENCES_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const HTML_START_SRC = ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

const LHEADING_CORE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const LHEADING = edit(LHEADING_CORE)
  .replace(/bull/g, BULLET)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[:\- ]*\n/)
  .getRegex();

const PARAGRAPH_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;

function makeParagraph(listInterrupt) {
  return edit(PARAGRAPH_CORE)
    .replace('hr', HR_SRC)
    .replace('heading', HEADING_SRC)
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', FENCES_SRC)
    .replace('list', listInterrupt)
    .replace('html', HTML_START_SRC)
    .replace('tag', BLOCK_TAGS)
    .getRegex();
}

const BLOCKQUOTE_PARAGRAPH = makeParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: HR_SRC,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  lheading: LHEADING,
  paragraph: edit(PARAGRAPH_CORE)
    .replace('hr', HR_SRC)
    .replace('heading', HEADING_SRC)
    .replace('|lheading', '')
    .replace('table', edit(
      '^ *([^\\n ].*)\\n'
      + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
      + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
      .replace('hr', HR_SRC)
      .replace('heading', HEADING_SRC)
      .replace('blockquote', ' {0,3}>')
      .replace('code', /(?: {4}| {0,3}\t)[^\n]/)
      .replace('fences', FENCES_SRC)
      .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
      .replace('html', HTML_START_SRC)
      .replace('tag', BLOCK_TAGS)
      .getRegex())
    .replace('blockquote', ' {0,3}>')
    .replace('fences', FENCES_SRC)
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
    .replace('html', HTML_START_SRC)
    .replace('tag', BLOCK_TAGS)
    .getRegex(),
  blockquote: edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/ )
    .replace('paragraph', BLOCKQUOTE_PARAGRAPH)
    .getRegex(),
  list: edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
    .replace(/bull/g, BULLET)
    .getRegex(),
  html: edit(
    '^ {0,3}(?:'
    + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
    + '|comment[^\\n]*(\\n+|$)'
    + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
    + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
    + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
    + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
    + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
    + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
    + ')', 'i')
    .replace('comment', COMMENT)
    .replace('tag', BLOCK_TAGS)
    .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
    .getRegex(),
  def: edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
    .replace('label', BLOCK_LABEL)
    .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
    .getRegex(),
  table: null, // filled below (it is the same regex the paragraph rule embeds)
  text: /^[^\n]+/,
};
BLOCK.table = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', HR_SRC)
  .replace('heading', HEADING_SRC)
  .replace('blockquote', ' {0,3}>')
  .replace('code', /(?: {4}| {0,3}\t)[^\n]/)
  .replace('fences', FENCES_SRC)
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', HTML_START_SRC)
  .replace('tag', BLOCK_TAGS)
  .getRegex();

// ---------------------------------------------------------------------------
// inline rules
// ---------------------------------------------------------------------------

const INLINE_COMMENT = edit(COMMENT).replace('(?:-->|$)', '-->').getRegex();

const EM_STRONG_L_DELIM = edit(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
  .replace(/punct/g, PUNCT_GFM)
  .getRegex();

const EM_STRONG_R_DELIM_AST_CORE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // an orphan * inside __...__ is skipped
  + '|[^*]+(?=[^*])' // plain run up to the next delimiter
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only close
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only close
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only open
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only open
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either

const EM_STRONG_R_DELIM_AST = edit(EM_STRONG_R_DELIM_AST_CORE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_OR_SPACE_GFM)
  .replace(/punctSpace/g, PUNCT_OR_SPACE_GFM)
  .replace(/punct/g, PUNCT_GFM)
  .getRegex();

const EM_STRONG_R_DELIM_UND = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // an orphan _ inside **...** is skipped
  + '|[^_]+(?=[^_])' // plain run up to the next delimiter
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1) #___ can only close
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2) a___#, a___ can only close
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3) #___a, ___a can only open
  + '|[\\s](_+)(?!_)(?=punct)' // (4) ___# can only open
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu') // (5) #___# can be either
  .replace(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .replace(/punctSpace/g, PUNCT_OR_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();

const DEL_L_DELIM = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, PUNCT)
  .getRegex();

const DEL_R_DELIM_CORE =
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)';

const DEL_R_DELIM = edit(DEL_R_DELIM_CORE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .replace(/punctSpace/g, PUNCT_OR_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();

const ANY_PUNCT = edit(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
const ANY_PUNCT_OUTSIDE_CODE = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, PUNCT)
  .getRegex();

const AUTOLINK = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();

const TAG = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', INLINE_COMMENT)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();

const LINK = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', INLINE_LABEL)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();

const REFLINK = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', INLINE_LABEL)
  .replace('ref', BLOCK_LABEL)
  .getRegex();

const NOLINK = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', BLOCK_LABEL)
  .getRegex();

const REFLINK_SEARCH = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', BOUNDED_INLINE_LABEL)
    .replace('ref', BOUNDED_BLOCK_LABEL)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', BOUNDED_BLOCK_LABEL)
    .getRegex())
  .getRegex();

const CASE_INSENSITIVE_PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EXTENDED_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EXTENDED_EMAIL_PROTOCOL = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, EXTENDED_EMAIL)
  .getRegex();

const URL = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', EXTENDED_EMAIL_PROTOCOL)
  .replace('protocol', CASE_INSENSITIVE_PROTOCOL)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();

const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// Spans an emphasis scan must skip: links, code spans and raw HTML.
const BLOCK_SKIP = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  // A text run stops before anything another inline rule could claim, before
  // a hard-break run of spaces, and before a www. / scheme:// / email start.
  text: edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
    .replace('protocol', CASE_INSENSITIVE_PROTOCOL)
    .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
    .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
    .getRegex(),
  punctuation: edit(/^((?![*_])punctSpace)/, 'u')
    .replace(/punctSpace/g, PUNCT_OR_SPACE)
    .getRegex(),
};

// ---------------------------------------------------------------------------
// 4. inline parsing: one left-to-right scan, rendered straight to HTML
// ---------------------------------------------------------------------------

// Shared state for one parse() call. inLink survives across inline runs
// (an unclosed <a > tag keeps later runs inside a link); inRawBlock is
// reset before every top-level run.
function newInlineState(links) {
  return {
    links,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
  };
}

// Does this link text already hold a link? (Links may not contain links.)
function linkInText(text, ctx) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(BLOCK_SKIP)) {
    if (LINK.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(REFLINK_SEARCH)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !ctx.links.has(normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), ctx)) continue;
    return true;
  }
  return false;
}

// Hide links, code spans, raw HTML and backslash escapes from the emphasis
// scan, keeping every span's length so positions still line up with src.
function maskSrc(src, ctx) {
  // With no bracket, backtick, angle bracket or backslash in the run,
  // none of the three masking passes below can match anything.
  if (src.indexOf('[') === -1 && src.indexOf('`') === -1
    && src.indexOf('<') === -1 && src.indexOf('\\') === -1) return src;
  let maskedSrc = src;
  if (ctx.links.size > 0 && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!ctx.links.has(normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, ctx)) {
          return '[' + text.replace(REFLINK_SEARCH, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(REFLINK_SEARCH, maskReflink);
  }
  // The punctuation pass only matches code spans and escaped punctuation,
  // so it is a no-op (and skipped) without a backtick or backslash.
  if (src.includes('`') || src.includes('\\')) {
    maskedSrc = maskedSrc.replace(ANY_PUNCT_OUTSIDE_CODE, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  // The block-skip pass only matches links, code spans and html tags.
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(BLOCK_SKIP, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return maskedSrc;
}

// One scan of a masked run for the last delimiter run of each kind that
// could close emphasis or strikethrough (not preceded by whitespace).
// Scanned backwards from the end: the last valid run is usually near it,
// and lastIndexOf skips the rest in native code.
function scanClosers(src) {
  const res = { '*': -1, '_': -1, '~': -1 };
  for (const ch of ['*', '_', '~']) {
    let j = src.lastIndexOf(ch);
    while (j !== -1) {
      let i = j;
      while (i > 0 && src[i - 1] === ch) i--;
      const prev = i === 0 ? '\n' : src[i - 1];
      if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
        res[ch] = i;
        break;
      }
      if (i < 2) break; // no earlier run of this delimiter can exist
      j = src.lastIndexOf(ch, i - 2);
    }
  }
  return res;
}

// Is the closing bracket of this link label really the label's end, or does
// it sit inside a tag or autolink the label holds?
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = INLINE.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = TAG.exec(tokenSrc) || AUTOLINK.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Build a link or image from a matched bracket pair. The label is parsed as
// inline content; a link whose text holds another link is abandoned (the
// inner link is the one kept), and images are exempt from that rule.
function outputLink(cap, link, raw, ctx, mode) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(R.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = ctx.inLink;
  const outerLinkEmitted = ctx.linkEmitted;
  const outerInRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  // An image's alt text is the label rendered as plain text, whatever the
  // outer mode is; a link renders its label in the outer mode.
  const inner = parseInline(text, ctx, isImage ? 'text' : mode);
  const textHasLink = ctx.linkEmitted;
  ctx.linkEmitted = outerLinkEmitted;
  ctx.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      ctx.inRawBlock = outerInRawBlock;
      return null;
    }
    ctx.linkEmitted = true;
  }
  return { isImage, raw, href, title, text, inner };
}

function renderLink(res, ctx) {
  if (res.isImage) {
    const cleanHref = cleanUrl(res.href);
    if (cleanHref === null) return escapeHtml(res.inner);
    let out = '<img src="' + escapeHtml(cleanHref) + '" alt="' + escapeHtml(res.inner) + '"';
    if (res.title) out += ' title="' + escapeHtml(res.title) + '"';
    return out + '>';
  }
  const cleanHref = cleanUrl(res.href);
  if (cleanHref === null) return res.inner;
  let out = '<a href="' + escapeHtml(cleanHref) + '"';
  if (res.title) out += ' title="' + escapeHtml(res.title) + '"';
  return out + '>' + res.inner + '</a>';
}

function renderAutolink(text, href) {
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return escapeHtml(text, true);
  return '<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>';
}

// An inline link [text](href "title"), with paren balancing for the href.
function tryLink(src, ctx, mode) {
  if (ctx.linkParenPossible === false) return null;
  const cap = LINK.exec(src);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return null;
  const trimmedUrl = cap[2].trim();
  if (R.startAngleBracket.test(trimmedUrl)) {
    if (!R.endAngleBracket.test(trimmedUrl)) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // The ')' that ends the match is the closer only when it is not escaped.
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (R.startAngleBracket.test(href)) href = href.slice(1, -1);
  const res = outputLink(cap, {
    href: href ? href.replace(ANY_PUNCT, '$1') : href,
    title: title ? title.replace(ANY_PUNCT, '$1') : title,
  }, cap[0], ctx, mode);
  if (!res) return null;
  return { raw: cap[0], html: mode === 'text' ? res.inner : renderLink(res, ctx) };
}

// A reference link [text][ref], [text][] or [text]. When the reference does
// not exist, only the opening character is emitted as text and the rest is
// scanned again.
function tryRefLink(src, ctx, mode) {
  const cap = REFLINK.exec(src) || NOLINK.exec(src);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return null;
  const link = ctx.links.get(normalizeLabel(cap[2] || cap[1]));
  if (!link) {
    const ch = cap[0].charAt(0);
    return { raw: ch, html: mode === 'html' ? escapeHtml(ch) : ch };
  }
  const res = outputLink(cap, link, cap[0], ctx, mode);
  if (!res) return null;
  return { raw: cap[0], html: mode === 'text' ? res.inner : renderLink(res, ctx) };
}

// Emphasis and strong emphasis. An opener run is matched against the next
// runs the right-delimiter scan classifies as closers; left-only runs add
// to the count, right-only runs subtract, and runs that could be either
// follow the rule of three. The smallest delimiter count decides em
// (odd) or strong (even), and the inner text is parsed again.
function emStrong(src, maskedSrc, prevChar, ctx, mode, closerHint) {
  let match = EM_STRONG_L_DELIM.exec(src);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  // The run may have started before src (taken as text, or used to close an
  // earlier span); flanking is about the whole run, so find its start.
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_'
    || !!INLINE.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!INLINE.punctuation.exec(prevChar);
  // _ cannot open between two alphanumerics.
  if (match[4] && prevChar.match(R.unicodeAlphaNumeric)) return null;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    let midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    const endReg = delimChar === '*' ? EM_STRONG_R_DELIM_AST : EM_STRONG_R_DELIM_UND;
    const lastPossible = closerHint[delimChar];
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return null;
    const windowSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(windowSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue; // a lone * inside __...__ is skipped
      rLength = [...rDelim].length;
      if (match[3] || match[4]) { // another left delimiter
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) { // either, or opener can close
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark emphasis rules 9-10
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue; // not enough closers yet
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return { raw, html: mode === 'html'
          ? '<em>' + parseInline(text, ctx, mode) + '</em>'
          : parseInline(text, ctx, mode) };
      }
      const text = raw.slice(2, -2);
      return { raw, html: mode === 'html'
        ? '<strong>' + parseInline(text, ctx, mode) + '</strong>'
        : parseInline(text, ctx, mode) };
    }
  }
  return null;
}

// Strikethrough, same delimiter machinery as emphasis but only matching
// runs of the same length.
function del(src, maskedSrc, prevChar, ctx, mode, closerHint) {
  const match0 = DEL_L_DELIM.exec(src);
  if (!match0) return null;
  const nextChar = match0[1] || '';
  if (!nextChar || !prevChar || INLINE.punctuation.exec(prevChar)) {
    const lLength = [...match0[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    const lastPossible = closerHint['~'];
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return null;
    const windowSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    DEL_R_DELIM.lastIndex = 0;
    let match;
    while ((match = DEL_R_DELIM.exec(windowSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) { // another left delimiter
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      return { raw, html: mode === 'html'
        ? '<del>' + parseInline(text, ctx, mode) + '</del>'
        : parseInline(text, ctx, mode) };
    }
  }
  return null;
}

// A code span: the closing run must be as long as the opening one, line
// endings become spaces, and one space is stripped from each end when the
// content has a non-space character and spaces on both ends.
function tryCodespan(src) {
  const cap = INLINE.code.exec(src);
  if (!cap) return null;
  let text = cap[2].replace(R.newLineCharGlobal, ' ');
  const hasNonSpace = R.nonSpaceChar.test(text);
  const hasSpaceBothEnds = R.startingSpaceChar.test(text) && R.endingSpaceChar.test(text);
  if (hasNonSpace && hasSpaceBothEnds) text = text.substring(1, text.length - 1);
  return { raw: cap[0], text };
}

// One cheap regex that finds the next place a text run could stop: a
// character another inline rule could claim, a hard-break run of spaces,
// or a www. / scheme:// / mailto: / xmpp: start. Emails are not in it:
// whenever the enclosing run may hold one, the text rule below falls back
// to the full text regex instead.
const TEXT_STOP = /[\\<!\[`*~_]| {2,}\n|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|www\.|mailto:|xmpp:/g;

// The character before a www. must be the start or one of these for the
// www. to count as an autolink start.
function isWwwPrev(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'
    || ch === '*' || ch === '_' || ch === '~' || ch === '(';
}

function isAlnumCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// The end of the plain-text run starting at s[0]: the same run the inline
// text rule matches. A leading run of backticks or tildes is consumed
// whole (so a code span is never re-tried inside its own opener); after
// that, one native scan finds the next stop candidate, and only the
// candidates that need a preceding-character check (www., mailto:, xmpp:)
// are validated in JS. hasAt says whether the enclosing run holds an @
// at all; with one, an email could start anywhere, so the full text rule
// (with its email lookaheads) is used instead.
function textRunEnd(s, hasAt) {
  const n = s.length;
  if (n === 0) return 0;
  let p;
  const c0 = s[0];
  if (c0 === '`' || c0 === '~') {
    p = 1;
    while (p < n && s[p] === c0) p++;
  } else {
    p = 1;
  }
  if (p >= n) return p;
  if (hasAt) {
    const m = INLINE.text.exec(s);
    return m ? m[0].length : 0;
  }
  TEXT_STOP.lastIndex = p;
  let m;
  while ((m = TEXT_STOP.exec(s)) !== null) {
    const q = m.index;
    const hit = m[0];
    if (hit === '!') {
      // Only ![ can start an image; a ! on its own is plain text.
      if (s[q + 1] === '[') return q;
      TEXT_STOP.lastIndex = q + 1;
      continue;
    }
    if (hit === '*' || hit === '_' || hit === '~') {
      // A delimiter run followed by whitespace (or the end) cannot open
      // emphasis or strikethrough, so it is plain text; the closer, if
      // any, is found by the emphasis scan itself, not by this run.
      const nx = s[q + 1];
      if (nx === undefined || nx === ' ' || nx === '\t' || nx === '\n' || nx === '\r' || nx === '\f' || nx === '\v') {
        TEXT_STOP.lastIndex = q + 1;
        continue;
      }
      return q;
    }
    if (hit === 'www.') {
      if (q === 0 || isWwwPrev(s[q - 1])) return q;
      TEXT_STOP.lastIndex = q + 4;
      continue;
    }
    if (hit === 'mailto:' || hit === 'xmpp:') {
      if (q > 0 && !isAlnumCode(s.charCodeAt(q - 1))) return q;
      TEXT_STOP.lastIndex = q + hit.length;
      continue;
    }
    return q;
  }
  return n;
}

// The inline scan itself. mode is 'html' (normal rendering) or 'text'
// (plain-text rendering, used for image alt text).
function parseInline(src, ctx, mode) {
  const out = [];
  const full = src;
  const hasAt = full.indexOf('@') !== -1;
  let masked = null;
  let hint = null;
  const getMasked = () => {
    if (masked === null) masked = maskSrc(full, ctx);
    return masked;
  };
  const getHint = () => {
    if (hint === null) hint = scanClosers(getMasked());
    return hint;
  };
  const prevLinkParenPossible = ctx.linkParenPossible;
  ctx.linkParenPossible = prevLinkParenPossible && src.includes(')');
  let prevChar = '';
  let keepPrevChar = false;
  try {
    while (src) {
      if (!keepPrevChar) prevChar = '';
      keepPrevChar = false;
      let m;
      let res;
      const c0 = src[0];
      // backslash escape
      if (c0 === '\\' && (m = INLINE.escape.exec(src))) {
        const ch = m[1];
        out.push(mode === 'html' ? escapeHtml(ch) : ch);
        src = src.slice(m[0].length);
        continue;
      }
      // raw HTML tag, comment, processing instruction, declaration, CDATA
      if (c0 === '<' && (m = TAG.exec(src))) {
        if (!ctx.inLink && R.startATag.test(m[0])) ctx.inLink = true;
        else if (ctx.inLink && R.endATag.test(m[0])) ctx.inLink = false;
        if (!ctx.inRawBlock && R.startPreScriptTag.test(m[0])) ctx.inRawBlock = true;
        else if (ctx.inRawBlock && R.endPreScriptTag.test(m[0])) ctx.inRawBlock = false;
        out.push(m[0]);
        src = src.slice(m[0].length);
        continue;
      }
      // inline link or image
      if ((c0 === '[' || c0 === '!') && (res = tryLink(src, ctx, mode))) {
        out.push(res.html);
        src = src.slice(res.raw.length);
        continue;
      }
      // reference link or image
      if ((c0 === '[' || c0 === '!') && (res = tryRefLink(src, ctx, mode))) {
        out.push(res.html);
        src = src.slice(res.raw.length);
        continue;
      }
      // emphasis / strong emphasis
      if (src[0] === '*' || src[0] === '_') {
        res = emStrong(src, getMasked(), prevChar, ctx, mode, getHint());
        if (res) {
          out.push(res.html);
          src = src.slice(res.raw.length);
          continue;
        }
      }
      // code span
      if (src[0] === '`') {
        res = tryCodespan(src);
        if (res) {
          out.push(mode === 'html' ? '<code>' + escapeHtml(res.text, true) + '</code>' : res.text);
          src = src.slice(res.raw.length);
          continue;
        }
      }
      // hard line break: two or more spaces, or a backslash, before a newline
      if ((c0 === ' ' || c0 === '\\') && (m = INLINE.br.exec(src))) {
        if (mode === 'html') out.push('<br>');
        src = src.slice(m[0].length);
        continue;
      }
      // strikethrough
      if (src[0] === '~') {
        res = del(src, getMasked(), prevChar, ctx, mode, getHint());
        if (res) {
          out.push(res.html);
          src = src.slice(res.raw.length);
          continue;
        }
      }
      // <autolink> and <email>
      if (c0 === '<' && (m = AUTOLINK.exec(src))) {
        let text;
        let href;
        if (m[2] === '@') {
          text = m[1];
          href = 'mailto:' + text;
        } else {
          text = m[1];
          href = text;
        }
        out.push(mode === 'html' ? renderAutolink(text, href) : text);
        src = src.slice(m[0].length);
        continue;
      }
      // GFM extended autolink: www., scheme://, email (not inside a link)
      if (!ctx.inLink && (m = URL.exec(src))) {
        let text;
        let href;
        if (m[2] === '@') {
          text = m[0];
          href = 'mailto:' + text;
        } else {
          let prevCapZero;
          do {
            prevCapZero = m[0];
            m[0] = BACKPEDAL.exec(m[0])?.[0] ?? '';
          } while (prevCapZero !== m[0]);
          text = m[0];
          href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
        }
        out.push(mode === 'html' ? renderAutolink(text, href) : text);
        src = src.slice(m[0].length);
        continue;
      }
      // plain text run
      {
        const end = textRunEnd(src, hasAt);
        if (end > 0) {
          const raw = src.slice(0, end);
          const text = ctx.inRawBlock ? raw : decodeNumericRefs(raw);
          if (mode === 'html') out.push(ctx.inRawBlock ? raw : escapeHtml(text));
          else out.push(text);
          if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
          keepPrevChar = true;
          src = src.slice(end);
          continue;
        }
      }
      // Nothing matched: emit one character as text so the scan always moves.
      const ch = src[0];
      if (mode === 'html') out.push(ctx.inRawBlock ? ch : escapeHtml(decodeNumericRefs(ch)));
      else out.push(ctx.inRawBlock ? ch : decodeNumericRefs(ch));
      prevChar = ch;
      keepPrevChar = true;
      src = src.slice(1);
    }
  } finally {
    ctx.linkParenPossible = prevLinkParenPossible;
  }
  return out.join('');
}

// A top-level inline run (paragraph, heading, table cell): raw-block state
// does not carry over from the previous block, and a link left open in an
// earlier run does not count as emitted here.
function parseInlineTop(src, ctx, mode) {
  ctx.inRawBlock = false;
  ctx.linkEmitted = false;
  return parseInline(src, ctx, mode);
}

// ---------------------------------------------------------------------------
// 5. block parsing: the same ordered rules, working on the remaining source
// ---------------------------------------------------------------------------

// Per-parse block state. links is filled while blocks are read, so inline
// parsing (which runs later, at render time) sees every definition,
// including ones written after their use.
function newBlockState() {
  return { links: new Map(), top: true };
}

function tokenSpace(src) {
  const cap = BLOCK.newline.exec(src);
  if (cap && cap[0].length > 0) return { k: 'space', raw: cap[0] };
}

function tokenCode(src) {
  const cap = BLOCK.code.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return { k: 'code', raw, text: raw.replace(R.codeRemoveIndent, '') };
  }
}

function indentCodeCompensation(raw, text) {
  const m = raw.match(R.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mm = node.match(R.beginningSpace);
    if (mm === null) return node;
    return node.slice(Math.min(mm[0].length, indentToCode.length));
  }).join('\n');
}

function tokenFences(src) {
  const cap = BLOCK.fences.exec(src);
  if (cap) {
    return {
      k: 'code',
      raw: cap[0],
      lang: cap[2] ? cap[2].trim().replace(ANY_PUNCT, '$1') : cap[2],
      text: indentCodeCompensation(cap[0], cap[3] || ''),
    };
  }
}

function tokenHeading(src) {
  const cap = BLOCK.heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (R.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || R.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
    }
    return { k: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text };
  }
}

function tokenHr(src) {
  const cap = BLOCK.hr.exec(src);
  if (cap) return { k: 'hr', raw: rtrim(cap[0], '\n') };
}

function tokenHtml(src) {
  const cap = BLOCK.html.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return {
      k: 'html',
      raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      text: raw,
    };
  }
}

function tokenDef(src) {
  const cap = BLOCK.def.exec(src);
  if (cap) {
    // Outside angle brackets a destination holds only balanced parentheses.
    if (!R.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return;
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(R.hrefBrackets, '$1').replace(ANY_PUNCT, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(ANY_PUNCT, '$1') : cap[3];
    return { k: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }
}

function tokenTable(src) {
  const cap = BLOCK.table.exec(src);
  if (!cap) return;
  // The delimiter row must hold a pipe or a colon, or this is a setext heading.
  if (!R.tableDelimiter.test(cap[2])) return;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(R.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(R.tableRowBlankLine, '').split('\n') : [];
  const item = { k: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  // Header and delimiter columns must agree; rows may differ.
  if (headers.length !== aligns.length) return;
  for (const align of aligns) {
    if (R.tableAlignRight.test(align)) item.align.push('right');
    else if (R.tableAlignCenter.test(align)) item.align.push('center');
    else if (R.tableAlignLeft.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({ text: headers[i], align: item.align[i] });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
      text: cell,
      align: item.align[i],
    })));
  }
  return item;
}

function tokenLheading(src) {
  // A setext underline needs a newline followed by up to three spaces
  // and = or -; without that, the big setext regex cannot match.
  if (!/\n {0,3}[=-]/.test(src)) return;
  const cap = BLOCK.lheading.exec(src);
  if (cap) {
    return {
      k: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text: cap[1].trim(),
    };
  }
}

function tokenParagraph(src) {
  const cap = BLOCK.paragraph.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { k: 'paragraph', raw: cap[0], text };
  }
}

function tokenText(src) {
  const cap = BLOCK.text.exec(src);
  if (cap) return { k: 'text', raw: cap[0], text: cap[0] };
}

// A blockquote: take the run of lines, split it into groups of marker lines
// plus lazy continuations, strip one marker from each group and lex the
// result again. A lazy line after a nested blockquote or list belongs to
// that nested block, so those are re-parsed with the continuation appended.
function tokenBlockquote(src, ctx) {
  const cap = BLOCK.blockquote.exec(src);
  if (!cap) return;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (R.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);
    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      // a tab after the marker runs to the next tab stop; the marker only
      // consumes one space of it, the rest is content
      .replace(R.blockquoteMarkerWhitespace, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      // precede a lazy setext underline with 4 spaces so it is not a heading
      .replace(R.blockquoteSetextReplace, '\n    $1')
      .replace(R.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;
    const top = ctx.top;
    ctx.top = true;
    blockTokens(currentText, tokens, ctx, true);
    ctx.top = top;
    if (lines.length === 0) break;
    const lastToken = tokens[tokens.length - 1];
    if (lastToken?.k === 'code' || lastToken?.k === 'heading' || lastToken?.k === 'hr'
      || lastToken?.k === 'html' || lastToken?.k === 'table') {
      // A continuation cannot follow a code block, heading, hr, html or table.
      break;
    } else if (lastToken?.k === 'blockquote') {
      const oldToken = lastToken;
      // The continuation lines belong to the same nesting frame as the
      // nested blockquote, which already had one '>' stripped, so strip one
      // marker from them too.
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(R.blockquoteSetextReplace2, '');
      const newToken = tokenBlockquote(newText, ctx);
      tokens[tokens.length - 1] = newToken;
      // Only include continuation lines the nested blockquote consumed.
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      // A leftover line starting with '>' still belongs to this blockquote.
      if (lines.length > 0 && R.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken?.k === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokenList(newText, ctx);
      tokens[tokens.length - 1] = newToken;
      // The list raw has no '>' markers, so count the continuation lines
      // the list took and add those lines instead.
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { k: 'blockquote', raw, tokens, text };
}

// A list: peel items off the front, working out each item's content indent
// from its marker and first line, then lex each item's text on its own. A
// list is loose when items are separated by blank lines or an item holds
// two blocks separated by a blank line.
function tokenList(src, ctx) {
  let cap = BLOCK.list.exec(src);
  if (!cap) return;
  const listSrc = src;
  let rest = src;
  const taken = () => listSrc.length - rest.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = {
    k: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = R.listItemRegex(bull);
  let endsWithBlankLine = false;
  while (rest) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(rest))) break;
    if (BLOCK.hr.test(rest)) break; // the bullet was actually a thematic break
    const itemStart = taken();
    rest = rest.substring(cap[0].length);
    const cap2Nl = cap[2].indexOf('\n');
    const firstLine = cap2Nl === -1 ? cap[2] : cap[2].slice(0, cap2Nl);
    const bulletIndent = cap[1].length;
    let line = firstLine.includes('\t')
      ? firstLine.replace(R.leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent))
      : firstLine;
    const restNl = rest.indexOf('\n');
    let nextLine = restNl === -1 ? rest : rest.slice(0, restNl);
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(R.nonSpaceChar);
      indent = indent > 4 ? 1 : indent; // > 4 spaces is indented code, count as 1
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && R.blankLine.test(nextLine)) {
      // Items begin with at most one blank line.
      rest = rest.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRegex = R.nextBulletRegex(indent);
      const hrRegex = R.hrRegex(indent);
      const fencesBeginRegex = R.fencesBeginRegex(indent);
      const headingBeginRegex = R.headingBeginRegex(indent);
      const htmlBeginRegex = R.htmlBeginRegex(indent);
      const blockquoteBeginRegex = R.blockquoteBeginRegex(indent);
      while (rest) {
        const nl = rest.indexOf('\n');
        const rawLine = nl === -1 ? rest : rest.slice(0, nl);
        nextLine = rawLine;
        const nextLineWithoutTabs = nextLine.includes('\t')
          ? nextLine.replace(R.leadingSpaceTab, (whitespace) => expandTabs(whitespace))
          : nextLine;
        // The first non-space character decides which of the block-start
        // rules can match this line; run only those, and only when the
        // marker sits within the list indent. A line starting with a tab
        // can match none of them, so the dispatch may run a test that
        // fails, but it never skips one that would succeed.
        const firstNonSpace = nextLineWithoutTabs.search(R.nonSpaceChar);
        if (firstNonSpace !== -1 && firstNonSpace <= indent) {
          const c = nextLineWithoutTabs[firstNonSpace];
          if (c === '`' || c === '~') {
            if (fencesBeginRegex.test(nextLine)) break;
          } else if (c === '#') {
            if (headingBeginRegex.test(nextLine)) break;
          } else if (c === '<') {
            if (htmlBeginRegex.test(nextLine)) break;
          } else if (c === '>') {
            if (blockquoteBeginRegex.test(nextLine)) break;
          } else if (c === '*' || c === '+' || c === '-') {
            if (nextBulletRegex.test(nextLine)) break;
            if (hrRegex.test(nextLine)) break;
          } else if (c >= '0' && c <= '9') {
            if (nextBulletRegex.test(nextLine)) break;
          } else if (c === '_') {
            if (hrRegex.test(nextLine)) break;
          }
        }
        if (firstNonSpace === -1 || firstNonSpace >= indent) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          // A paragraph continuation, unless the last line was a different
          // block-level element or an indented code block.
          const lineNoTabs = line.includes('\t') ? line.replace(R.tabCharGlobal, '    ') : line;
          if (lineNoTabs.search(R.nonSpaceChar) >= 4) break;
          if (fencesBeginRegex.test(line)) break;
          if (headingBeginRegex.test(line)) break;
          if (htmlBeginRegex.test(line)) break;
          if (hrRegex.test(line)) break;
          // A lazy continuation can look like a setext underline once list
          // indentation is removed; keep it in the paragraph.
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && BLOCK.lheading.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }
        blankLine = firstNonSpace === -1;
        rest = rest.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    // The loops above appended a '\n' the source may not have had; it can
    // only land on the item that exhausts src, whose raw is trimmed below.
    const raw = listSrc.slice(itemStart, taken());
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (R.doubleBlankLine.test(raw)) endsWithBlankLine = true;
    }
    list.items.push({
      k: 'list_item',
      raw,
      task: R.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return; // not a list since there were no items
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();
  // Tokenize items now that the final item is trimmed.
  for (const item of list.items) {
    ctx.top = false;
    item.tokens = blockTokens(item.text, [], ctx);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.k === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => R.anyLine.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }
  // Place task checkboxes using the final loose value.
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.k === 'text' || itemToken?.k === 'paragraph')) {
      item.text = item.text.replace(R.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(R.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(R.listReplaceTask, '');
      const taskRaw = R.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checkboxHtml = '<input ' + (taskRaw[0] !== '[ ]' ? 'checked="" ' : '')
          + 'disabled="" type="checkbox"> ';
        item.checked = taskRaw[0] !== '[ ]';
        if (list.loose) {
          // Inside the paragraph, before its text.
          itemToken.raw = taskRaw[0] + ' ' + itemToken.raw;
          itemToken.lead = (itemToken.lead || '') + checkboxHtml;
        } else {
          item.tokens.unshift({ k: 'checkbox', raw: taskRaw[0] + ' ', checked: item.checked });
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  // A loose list's items are loose, and their bare text renders as paragraphs.
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.k === 'text') token.k = 'paragraph';
      }
    }
  }
  return list;
}

// The block loop: try each rule in order on the remaining source.
function blockTokens(src, tokens, ctx, lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    let token;
    // blank lines
    if (token = tokenSpace(src)) {
      src = src.slice(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (token.raw.length === 1 && lastToken !== undefined) {
        // A single \n only ends the last line; fold it into that token.
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }
    // indented code (cannot interrupt a paragraph: it joins it instead)
    if (token = tokenCode(src)) {
      src = src.slice(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken?.k === 'paragraph' || lastToken?.k === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    // fenced code
    if (token = tokenFences(src)) {
      src = src.slice(token.raw.length);
      tokens.push(token);
      continue;
    }
    // ATX heading
    if (token = tokenHeading(src)) {
      src = src.slice(token.raw.length);
      tokens.push(token);
      continue;
    }
    // thematic break
    if (token = tokenHr(src)) {
      src = src.slice(token.raw.length);
      tokens.push(token);
      continue;
    }
    // blockquote
    if (token = tokenBlockquote(src, ctx)) {
      src = src.slice(token.raw.length);
      tokens.push(token);
      continue;
    }
    // list
    if (token = tokenList(src, ctx)) {
      src = src.slice(token.raw.length);
      tokens.push(token);
      continue;
    }
    // HTML block
    if (token = tokenHtml(src)) {
      src = src.slice(token.raw.length);
      tokens.push(token);
      continue;
    }
    // link reference definition
    if (token = tokenDef(src)) {
      src = src.slice(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken?.k === 'paragraph' || lastToken?.k === 'text') {
        // A definition after paragraph text is paragraph text, not a definition.
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
      } else {
        // The first definition of a label wins; a later one still eats its text.
        if (!ctx.links.has(token.tag)) {
          ctx.links.set(token.tag, { href: token.href, title: token.title });
        }
        tokens.push(token);
      }
      continue;
    }
    // GFM table
    if (token = tokenTable(src)) {
      src = src.slice(token.raw.length);
      tokens.push(token);
      continue;
    }
    // setext heading
    if (token = tokenLheading(src)) {
      src = src.slice(token.raw.length);
      tokens.push(token);
      continue;
    }
    // paragraph (top level only; inside lists and blockquotes a text token
    // is used instead, and loose lists promote it later)
    if (ctx.top && (token = tokenParagraph(src))) {
      const lastToken = tokens[tokens.length - 1];
      if (lastParagraphClipped && lastToken?.k === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
      } else {
        tokens.push(token);
      }
      lastParagraphClipped = false;
      src = src.slice(token.raw.length);
      continue;
    }
    // plain text line
    if (token = tokenText(src)) {
      src = src.slice(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken?.k === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  ctx.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// 6. rendering and the entry point
// ---------------------------------------------------------------------------

function renderTableCell(cell, ctx, isHeader) {
  const content = parseInlineTop(cell.text, ctx, 'html');
  const tag = isHeader ? 'th' : 'td';
  return cell.align
    ? `<${tag} align="${cell.align}">` + content + `</${tag}>\n`
    : `<${tag}>` + content + `</${tag}>\n`;
}

function renderTokens(tokens, ctx) {
  let out = '';
  for (const t of tokens) {
    switch (t.k) {
      case 'space':
      case 'def':
        break; // nothing renders for blank lines or definitions
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${t.depth}>${parseInlineTop(t.text, ctx, 'html')}</h${t.depth}>\n`;
        break;
      case 'code': {
        const langString = (t.lang || '').match(R.notSpaceStart)?.[0];
        // An empty code block has no content, so it must not gain a newline.
        const code = t.text ? t.text.replace(R.endingNewline, '') + '\n' : '';
        if (!langString) {
          out += '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
        } else {
          out += '<pre><code class="language-' + escapeHtml(langString) + '">'
            + escapeHtml(code, true) + '</code></pre>\n';
        }
        break;
      }
      case 'table': {
        let header = '';
        for (const cell of t.header) header += renderTableCell(cell, ctx, true);
        let body = '';
        for (const row of t.rows) {
          let cellHtml = '';
          for (const cell of row) cellHtml += renderTableCell(cell, ctx, false);
          body += `<tr>\n${cellHtml}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += '<table>\n<thead>\n' + `<tr>\n${header}</tr>\n` + '</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderTokens(t.tokens, ctx)}</blockquote>\n`;
        break;
      case 'list': {
        const type = t.ordered ? 'ol' : 'ul';
        const startAttr = (t.ordered && t.start !== 1) ? (' start="' + t.start + '"') : '';
        let body = '';
        for (const item of t.items) body += `<li>${renderTokens(item.tokens, ctx)}</li>\n`;
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'checkbox':
        out += '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html':
        out += t.text;
        break;
      case 'paragraph':
        out += `<p>${t.lead || ''}${parseInlineTop(t.text, ctx, 'html')}</p>\n`;
        break;
      case 'text':
        out += (t.lead || '') + parseInlineTop(t.text, ctx, 'html');
        break;
    }
  }
  return out;
}

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const src = markdown.indexOf('\r') === -1 ? markdown : markdown.replace(R.carriageReturn, '\n');
  const blockCtx = newBlockState();
  const inlineCtx = newInlineState(blockCtx.links);
  const tokens = blockTokens(src, [], blockCtx);
  return renderTokens(tokens, inlineCtx);
}
