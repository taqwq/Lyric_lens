// Fake Gemini API for the dev harness: answers model listing and streams a protocol-shaped
// translation built from the prompt. Mode via localStorage "ll-mock-mode":
//   ok (default) | busy-first | cut | quota | slow | garbage
(() => {
  const realFetch = window.fetch.bind(window);
  const mode = () => localStorage.getItem('ll-mock-mode') || 'ok';
  let calls = 0;

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function targetsFrom(prompt) {
    const lyrics = new Map();
    for (const m of prompt.matchAll(/^L(\d+): (.+)$/gm)) if (!lyrics.has(+m[1])) lyrics.set(+m[1], m[2]);
    const ask = prompt.split('# 指示')[1] || '';
    let ids = [];
    const all = /L1〜L(\d+) をすべて/.exec(ask);
    if (all) ids = Array.from({ length: +all[1] }, (_, i) => i + 1);
    else for (const part of ask.split('：')[1]?.split(',') ?? []) {
      const r = /L(\d+)(?:〜L(\d+))?/.exec(part.trim());
      if (!r) continue;
      for (let i = +r[1]; i <= +(r[2] || r[1]); i += 1) ids.push(i);
    }
    return { ids, lyrics, wantsContext: ask.includes('最初に書き') };
  }

  function linesFor(prompt) {
    const { ids, lyrics, wantsContext } = targetsFrom(prompt);
    const out = [];
    if (wantsContext) {
      out.push('@about: 貧しかった過去と成功した今を、紙飛行機にして飛ばすドル札のイメージで対比する曲。浮かれた自慢に見えて、地元への義理と亡くした仲間への思いが通底している。');
      out.push('@voice: 成功したラッパーが、昔の自分を疑った人たちとライバルに向けて語る。');
    }
    for (const id of ids) {
      const src = lyrics.get(id) || '';
      out.push(`L${id}: 〔訳〕${src.replace(/'/g, '’')}`);
      if (/Ten toes/.test(src)) out.push(`N${id}: slang | Ten toes down | 両足のつま先を地につけて踏ん張る＝ぶれずに地元や仲間に忠実でいること。`);
      if (/cap/.test(src)) out.push(`N${id}: slang | cap | 「嘘」の意味のスラング。no cap で「マジで」。`);
      if (/Crenshaw/.test(src)) out.push(`N${id}?: reference | Crenshaw | ロサンゼルス南部の大通り・地区。ヒップホップと縁が深い。`);
      if (/dog/.test(src)) out.push(`N${id}: wordplay | dog | 「女たらし」の意味の dog を、皿を舐める犬の行動に掛けている。`);
    }
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
