import './setup';

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { aboutText, extractLyrics, extractMeta, lyricsContainers, readPage, songPath } from '../src/genius/extract';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** Visible text nodes of a container, in document order, skipping excluded junk. */
function textOrder(root: Element): string[] {
  const out: string[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.parentElement as Element).closest('[data-exclude-from-selection]')) continue;
    const t = (n.textContent ?? '').trim();
    if (t) out.push(t);
  }
  return out;
}

function addMarks(doc: Document, anchors: Node[]): void {
  for (const anchor of anchors) {
    const mark = doc.createElement('span');
    mark.className = 'll-mark';
    mark.textContent = 'MARK';
    anchor.parentNode!.insertBefore(mark, anchor.nextSibling);
  }
}

// Mimics Genius' markup: no whitespace between elements (it renders as one run of HTML).
const FIRST_CONTAINER =
  '<div data-lyrics-container="true">' +
  '<div data-exclude-from-selection="true">header junk 12 Contributors</div>' +
  '[Intro]<br>' +
  '<a href="/x"><span>line one<br>line two<br>line three</span></a><span tabindex="0"></span><span><span tabindex="0"></span></span><br>' +
  'plain text A<br>plain text B<br>' +
  '<br><br>' +
  '[Chorus]<br>' +
  '<a href="/y"><span>last line</span></a>' +
  '</div>';
const SECOND_CONTAINER = '<div data-lyrics-container="true">[Verse 2]<br>verse line<br></div>';

describe('extractLyrics', () => {
  const doc = parse(`<body>${FIRST_CONTAINER}${SECOND_CONTAINER}</body>`);
  const ex = extractLyrics(doc)!;

  it('finds both containers', () => {
    expect(ex).not.toBeNull();
    expect(ex.containers).toHaveLength(2);
    expect(lyricsContainers(doc)).toHaveLength(2);
  });

  it('returns headers and lines in order, without the excluded junk', () => {
    expect(ex.rows).toEqual([
      { kind: 'header', text: '[Intro]' },
      { kind: 'line', text: 'line one' },
      { kind: 'line', text: 'line two' },
      { kind: 'line', text: 'line three' },
      { kind: 'line', text: 'plain text A' },
      { kind: 'line', text: 'plain text B' },
      { kind: 'header', text: '[Chorus]' },
      { kind: 'line', text: 'last line' },
      { kind: 'header', text: '[Verse 2]' },
      { kind: 'line', text: 'verse line' },
    ]);
    expect(ex.rows.some((r) => /Contributors|junk/.test(r.text))).toBe(false);
  });

  it('has exactly one anchor per line row, in order', () => {
    expect(ex.anchors).toHaveLength(ex.rows.filter((r) => r.kind === 'line').length);
    expect(ex.anchors).toHaveLength(7);
  });

  it('places every translation right after its own line, including inside a multi-line annotation', () => {
    // Fresh DOM: this test mutates it.
    const d = parse(`<body>${FIRST_CONTAINER}${SECOND_CONTAINER}</body>`);
    const e = extractLyrics(d)!;
    addMarks(d, e.anchors);
    const [first, second] = e.containers as [HTMLElement, HTMLElement];
    expect(textOrder(first)).toEqual([
      '[Intro]',
      'line one', 'MARK',
      'line two', 'MARK',
      'line three', 'MARK',
      'plain text A', 'MARK',
      'plain text B', 'MARK',
      '[Chorus]',
      'last line', 'MARK',
    ]);
    expect(textOrder(second)).toEqual(['[Verse 2]', 'verse line', 'MARK']);
  });

  it('extracts the same rows and anchors again after marks were inserted (re-scan is stable)', () => {
    const d = parse(`<body>${FIRST_CONTAINER}${SECOND_CONTAINER}</body>`);
    const before = extractLyrics(d)!;
    addMarks(d, before.anchors);
    const after = extractLyrics(d)!;
    expect(after.rows).toEqual(before.rows);
    expect(after.anchors).toEqual(before.anchors);
  });

  it('puts the first two annotation lines\' marks inside the annotation and the last line\'s after the <br>', () => {
    const [one, two, three] = ex.anchors as [Element, Element, Element];
    expect(one.nodeName).toBe('BR');
    expect(one.parentElement!.closest('a')).not.toBeNull();
    expect(two.nodeName).toBe('BR');
    expect(two.parentElement!.closest('a')).not.toBeNull();
    // the third line ends at the <br> after the annotation and the empty tabindex spans
    expect(three.nodeName).toBe('BR');
    expect(three.parentElement!.hasAttribute('data-lyrics-container')).toBe(true);
  });

  it('puts the mark of a final line with no trailing <br> after its wrapping <a>', () => {
    const last = ex.anchors[5] as Element;
    expect(last.nodeName).toBe('A');
    expect(last.textContent).toBe('last line');
    expect(last.parentElement!.hasAttribute('data-lyrics-container')).toBe(true);
  });
});

describe('extractLyrics: other markup', () => {
  it('returns null when there are no lyrics containers or only headers', () => {
    expect(extractLyrics(parse('<body><p>nothing</p></body>'))).toBeNull();
    expect(extractLyrics(parse('<body><div data-lyrics-container="true">[Intro]<br></div></body>'))).toBeNull();
  });

  it('drops Genius page noise and the trailing embed counter', () => {
    const doc = parse(
      '<body><div data-lyrics-container="true">' +
      'real line<br>You Might Also Like<br>1.2K Embed<br>another line 45Embed' +
      '</div></body>',
    );
    expect(extractLyrics(doc)!.rows).toEqual([
      { kind: 'line', text: 'real line' },
      { kind: 'line', text: 'another line' },
    ]);
  });

  it('normalises non-breaking spaces and collapses blanks inside a line', () => {
    const doc = parse('<body><div data-lyrics-container="true">hello world  again<br></div></body>');
    expect(extractLyrics(doc)!.rows).toEqual([{ kind: 'line', text: 'hello world again' }]);
  });

  it('ignores its own injected nodes (ll-*) and script/button content', () => {
    const doc = parse(
      '<body><div data-lyrics-container="true">' +
      'one<span class="ll-mark">訳です</span><br>' +
      '<button>Share</button>two<br>' +
      '</div></body>',
    );
    expect(extractLyrics(doc)!.rows).toEqual([
      { kind: 'line', text: 'one' },
      { kind: 'line', text: 'two' },
    ]);
  });

  it('treats block elements as line boundaries and anchors them at the block', () => {
    const doc = parse('<body><div data-lyrics-container="true"><div>first</div><div>second</div></div></body>');
    const ex = extractLyrics(doc)!;
    expect(ex.rows).toEqual([{ kind: 'line', text: 'first' }, { kind: 'line', text: 'second' }]);
    expect(ex.anchors.map((a) => a.nodeName)).toEqual(['DIV', 'DIV']);
  });

  it('skips containers nested in our own UI', () => {
    const doc = parse(
      '<body><div class="ll-note"><div data-lyrics-container="true">ours<br></div></div>' +
      '<div data-lyrics-container="true">theirs<br></div></body>',
    );
    expect(extractLyrics(doc)!.rows).toEqual([{ kind: 'line', text: 'theirs' }]);
  });

  it('readPage ties rows, anchors and meta together', () => {
    const doc = parse(
      '<head><meta property="og:title" content="Artist – Title"></head>' +
      `<body>${FIRST_CONTAINER}</body>`,
    );
    const page = readPage(doc, { pathname: '/Artist-title-lyrics/' } as Location)!;
    expect(page.path).toBe('/Artist-title-lyrics');
    expect(page.source.meta).toMatchObject({ title: 'Title', artist: 'Artist' });
    expect(page.source.lines).toHaveLength(page.anchors.length);
    expect(page.source.sections.map((s) => s.label)).toEqual(['[Intro]', '[Chorus]']);
  });

  it('readPage stays out of a page whose lyrics are only sounds', () => {
    const doc = parse('<body><div data-lyrics-container="true">[Intro]<br>Ooh, ooh<br>(Yeah, yeah)<br>La-la-la</div></body>');
    expect(readPage(doc, { pathname: '/Artist-hums-lyrics' } as Location)).toBeNull();
  });

  it('songPath strips trailing slashes', () => {
    expect(songPath({ pathname: '/a-b-lyrics//' } as Location)).toBe('/a-b-lyrics');
    expect(songPath({ pathname: '/' } as Location)).toBe('/');
  });
});

describe('extractMeta', () => {
  it('splits og:title into artist and title when the page has no headings', () => {
    const doc = parse('<head><meta property="og:title" content="Kendrick Lamar – HUMBLE."></head><body></body>');
    expect(extractMeta(doc)).toEqual({ title: 'HUMBLE.', artist: 'Kendrick Lamar' });
  });

  it('keeps dashes that are part of the title', () => {
    const doc = parse('<head><meta property="og:title" content="Artist – Part 1 – Part 2"></head><body></body>');
    expect(extractMeta(doc)).toEqual({ title: 'Part 1 – Part 2', artist: 'Artist' });
  });

  it('prefers the SongHeader h1 for the title and still takes the artist from og:title', () => {
    const doc = parse(
      '<head><meta property="og:title" content="Artist – Og Title"></head>' +
      '<body><h1 class="SongHeader-desktop__Title-sc-1abc"> The  Real <span>Title</span> </h1></body>',
    );
    expect(extractMeta(doc)).toEqual({ title: 'The Real Title', artist: 'Artist' });
  });

  it('reads artist, album and about from the page', () => {
    const about = 'This song is about something fairly long so that it passes the minimum length. Read More';
    const doc = parse(
      '<body>' +
      '<h1 class="SongHeader-desktop__Title-x">Song</h1>' +
      '<a class="SongHeader-desktop__Artist-y" href="/artists/a">Some Artist</a>' +
      '<div class="SongHeader-desktop__Hero"><a href="/albums/Some-Artist/Some-Album">Some Album</a></div>' +
      `<div class="SongDescription__Container-z">${about}</div>` +
      '</body>',
    );
    const meta = extractMeta(doc);
    expect(meta.title).toBe('Song');
    expect(meta.artist).toBe('Some Artist');
    expect(meta.album).toBe('Some Album');
    expect(meta.about).toBe('This song is about something fairly long so that it passes the minimum length.');
  });

  it('omits album and too-short about text; falls back to the document title', () => {
    const doc = parse('<head><title>HUMBLE. Lyrics | Genius Lyrics</title></head><body><div class="SongDescription__Container-z">short</div></body>');
    const meta = extractMeta(doc);
    expect(meta).toEqual({ title: 'HUMBLE.', artist: '' });
    expect('album' in meta).toBe(false);
    expect('about' in meta).toBe(false);
  });
});

describe('songPath with a canonical URL', () => {
  it('keeps the song identity when Genius rewrites the URL to an annotation id', () => {
    const dom = new JSDOM('<head><link rel="canonical" href="https://genius.com/Kendrick-lamar-humble-lyrics"></head>', { url: 'https://genius.com/11592958' });
    expect(songPath(dom.window.location as unknown as Location, dom.window.document)).toBe('/Kendrick-lamar-humble-lyrics');
  });

  it('ignores a canonical URL that is not a song page', () => {
    const dom = new JSDOM('<head><link rel="canonical" href="https://genius.com/artists/Kendrick-lamar"></head>', { url: 'https://genius.com/x-lyrics' });
    expect(songPath(dom.window.location as unknown as Location, dom.window.document)).toBe('/x-lyrics');
  });
});

describe('aboutText', () => {
  it('drops Genius page chrome around the bio', () => {
    const dom = new JSDOM('<div id="a"><div class="Attribution">22 contributors</div>Song Bio 22 contributors On the ironically braggadocious track, Kendrick challenges rivals. <button>Expand</button> +107755 Share</div>');
    const text = aboutText(dom.window.document.getElementById('a'));
    expect(text.startsWith('On the ironically')).toBe(true);
    expect(text).not.toMatch(/Expand|Share|contributors/);
  });
});

describe('lyricsContainers with our classes on <html>', () => {
  it('still finds the lyrics when translations are hidden (html.ll-hidden) or the page is dark', () => {
    document.documentElement.classList.add('ll-hidden', 'll-dark');
    document.body.innerHTML = '<div data-lyrics-container="true">one<br>two</div>';
    try {
      expect(lyricsContainers(document)).toHaveLength(1);
    } finally {
      document.documentElement.classList.remove('ll-hidden', 'll-dark');
    }
  });
});
