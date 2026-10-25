// Fake Gemini API for the dev harness: answers model listing and streams a protocol-shaped
// translation built from the prompt. Mode via localStorage "ll-mock-mode":
//   ok (default) | busy-first | cut | quota | slow | garbage
(() => {
  if (!localStorage.getItem('lyric-lens-dev:ll3:settings') && !location.search.includes('fresh')) {
    localStorage.setItem('lyric-lens-dev:ll3:settings', JSON.stringify({
      providers: [{ id: 'gemini', kind: 'gemini', preset: 'gemini', baseUrl: '', apiKey: 'mock-key', model: '', enabled: true }],
      thinking: 'low', hideTranslation: false,
    }));
  }
  const realFetch = window.fetch.bind(window);
  const mode = () => localStorage.getItem('ll-mock-mode') || 'ok';
  let calls = 0;

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function targetsFrom(prompt) {
    const lyrics = new Map();
    for (const m of prompt.matchAll(/^L(\d+): (.+?)(?:  → .*)?$/gm)) if (!lyrics.has(+m[1])) lyrics.set(+m[1], m[2]);
    const ask = prompt.split('# 指示')[1] || '';
    let ids = [];
    const all = /L1〜L(\d+) をすべて/.exec(ask);
    if (all) ids = Array.from({ length: +all[1] }, (_, i) => i + 1);
    else for (const part of (ask.split('：')[1] || '').split('。')[0].split(',')) {
      const r = /L(\d+)(?:〜L(\d+))?/.exec(part.trim());
      if (!r) continue;
      for (let i = +r[1]; i <= +(r[2] || r[1]); i += 1) ids.push(i);
    }
    return { ids, lyrics, wantsSong: ask.includes('まず song') };
  }

  function linesFor(prompt) {
    const { ids, lyrics, wantsSong } = targetsFrom(prompt);
    const out = [];
    if (wantsSong) {
      out.push(JSON.stringify({ t: 'song', who: '成功したラッパー → 昔の自分を疑った人たちとライバル', what: '貧しかった過去と今を、紙飛行機にして飛ばすドル札のイメージで対比する。浮かれた自慢の裏に、地元への義理と亡くした仲間への思いがある。', tone: '余裕のある自慢', motifs: [{ en: 'paper planes', ja: '紙飛行機' }] }));
    }
    const words3 = (s) => s.split(/\s+/).slice(0, 3).join(' ');
    for (const id of ids) {
      const src = lyrics.get(id) || '';
      const notes = [];
      if (/Ten toes/.test(src)) notes.push({ q: 'Ten toes down', k: 'slang', x: '両足のつま先を地につけて踏ん張る＝ぶれずに地元や仲間に忠実でいること。' });
      if (/\bcap\b/.test(src)) notes.push({ q: 'cap', k: 'slang', x: '「嘘」の意味のスラング。no cap で「マジで」。' });
      if (/Crenshaw/.test(src)) notes.push({ q: 'Crenshaw', k: 'reference', x: 'ロサンゼルス南部の大通り・地区。ヒップホップと縁が深い。', c: true });
      if (/dog/.test(src)) notes.push({ q: "I'm a dog", k: 'wordplay', x: '「女たらし」の dog と、皿を舐める犬の行動を掛けている。', g: '2' });
      out.push(JSON.stringify({ t: 'line', id: `L${id}`, head: words3(src), ja: `〔訳〕${src.replace(/'/g, '’')}`, notes }));
    }
    out.push(JSON.stringify({ t: 'end' }));
    return out;
  }

  async function* stream(prompt) {
    const lines = linesFor(prompt);
    const m = mode();
    const cutAt = m === 'cut' && calls === 1 ? Math.floor(lines.length / 2) : Infinity;
    await sleep(m === 'slow' ? 2500 : 900);
    for (let i = 0; i < lines.length; i += 1) {
      if (i === cutAt) {
        yield { candidates: [{ content: { parts: [{ text: lines[i].slice(0, 6) }] }, finishReason: 'MAX_TOKENS' }] };
        return;
      }
      if (m === 'garbage') { yield { candidates: [{ content: { parts: [{ text: 'Sure! Here is the translation:\n' }] } }] }; continue; }
      yield { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: `${lines[i]}\n` }] } }] };
      await sleep(m === 'slow' ? 600 : 90);
    }
    yield { candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }] };
  }

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/referents')) {
      await sleep(80);
      return json(200, { response: { next_page: null, referents: [
        { id: 2, fragment: "She said I'm a dog, so I licked the plate clean", range: { content: "She said I'm a dog, so I licked the plate clean" }, annotations: [{ body: { plain: 'A play on "dog" as slang for a womanizer, turned literal: a dog licks the plate. Placeholder annotation for testing; not real Genius content.' }, votes_total: 42, state: 'accepted' }] },
        { id: 5, fragment: 'Paper planes, paper planes over Crenshaw', range: { content: 'Paper planes, paper planes over Crenshaw' }, annotations: [{ body: { plain: 'Crenshaw Boulevard runs through South Los Angeles. Placeholder annotation for testing.' }, votes_total: 17, state: 'accepted' }] },
      ] } });
    }
    if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
    await sleep(120);
    if (url.includes('/v1beta/models?')) {
      return json(200, { models: [
        { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', supportedGenerationMethods: ['generateContent'] },
      ] });
    }
    calls += 1;
    const m = mode();
    if (m === 'quota') return json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20 PerDay' } });
    if (m === 'busy-first' && url.includes('3.8-flash')) return json(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } });
    const body = JSON.parse(init.body || '{}');
    const prompt = body.contents?.[0]?.parts?.[0]?.text || '';
    const encoder = new TextEncoder();
    const rs = new ReadableStream({
      async start(controller) {
        for await (const ev of stream(prompt)) controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\r\n\r\n`));
        controller.close();
      },
    });
    return new Response(rs, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  console.info('[mock-llm] active, mode =', mode());
})();
