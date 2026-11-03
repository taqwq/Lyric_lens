# Lyric Lens: Final Design Specification

## 1. Thesis and principles

**Thesis.** 「聴きながら、わかる。」 (*understand while you listen*). The reader plays a song and follows this page as it plays. Lyric Lens delivers the meaning at the speed of listening and never pulls the eyes or the ears away from the song. Every decision below follows from that sentence. The reader came to read a song, not to operate a tool, so the page itself is the interface.

**Four pillars**
1. **Meaning where the eyes already are.** The Japanese sits directly under each English line, a note opens under its line, and every control lives in one row at the top. Nothing sends the eyes sideways or into another window.
2. **Never break the flow.** The page moves only right after the reader's own tap: no popups, no flashing, no toasts. A part that has done its job steps back (the head ends as a small plain label), a song read once appears at once, and nothing moves under the finger: the row's height and the places of its links are the same in every state.
3. **Nothing new to learn.** We speak Genius' own grammar on a page the reader already knows: a one-row info line with a small icon, black type, square corners, underlined links, `▾` for more, and the marker yellow. That is why it fits in, not mood.
4. **Honesty.** The translation says what it is (`AIによる日本語訳`) and is never mixed with the annotations people wrote on Genius. A note we are unsure of says `〔推測〕`. Progress is a real fraction. When something stops, the reason and the next step stand where it stopped.

**What the pillars promise**
- **Black means Lyric Lens needs you or is working** (pillars 3, 4): the bold underlined action, the track filling under the row, the stop line of a seam. When the work is done the row is a small plain label (pillar 2).
- **Yellow means the words you asked about, and nothing else** (pillars 1, 3). It is Genius' own marker colour, spent on one meaning (§5).
- **The translation is body text** (pillars 1, 2): ink, set in each system's gothic, with no web fonts.
- **Nothing is red, and there is no accent colour.** Words and a confirming second tap carry the weight of an error or a deletion.

**The moment to remember.** Open a note and three things turn yellow at once: the English words in the lyric, the `※`, and the note's heading. The reader sees which words the note is about without reading anything (pillar 1).

**Principles**
1. **Ink, not interface.** Nearly everything we add is text in the lyric column. The one control row speaks in underlined text, and the only bold thing in it is the next step the reader is asked to take.
2. **One tap, one request.** A request goes out only from a tap made at that moment. Page loads, re-renders, navigation, annotation clicks, reconnects and retries never send one. There is no auto-translate setting.
3. **Partial is a valid state.** Each line is saved the moment it parses. A half-translated song is a page that is still being written: the lines to come are reserved blank slots, and a stop is marked by one line across the column.
4. **Genius keeps its layer.** Genius owns its backgrounds, the English tap targets, the annotation panel and the sidebar. We borrow its grammar, and we never wrap Genius' text nodes (the yellow on English words is painted with the CSS Highlight API) or capture its clicks.
5. **Silence over explanation.** A note exists only where the Japanese alone would mislead or lose something. A song with zero notes is fine.
6. **Progress is the page filling in.** A 2 px track under the head grows with the lines that have arrived (on desktop `（12/67行）` says the same in words); before the first line a short segment travels along it instead. There are no spinners, percentages, timers or quota meters. Quota is mentioned only when it blocks something, and always with a recovery time in JST.
7. **Consistency comes from the data.** Repeats are deduplicated on the client, so a chorus is translated once and renders the same everywhere.

## 2. Information architecture

All of our CSS lives in one injected `<style id="ll-style">`. Every class uses the `ll-` prefix, and every inline node has `lang="ja"` and `overflow-anchor: none`.

| # | Element | Insertion point | Desktop | Phone (<600 px) |
|---|---|---|---|---|
| 1 | **Head** `div.ll-head` (a region labelled `Lyric Lens 日本語訳`) | Inside the first `[data-lyrics-container]`, right after Genius' own lyrics header (the child marked `data-exclude-from-selection`), or as its first child when there is none. Re-inserted by the render pass if Genius removes it. | One row in Genius' info-row grammar: a small `あ` icon, then a bold underlined primary action or a status sentence (with the count `（12/67行）` while arriving), then underlined links at the right in fixed slots: `止める` · `訳を隠す` / `訳を表示` · `設定`. A 2 px track under the row. Captions and the preface hang below it. | The same row. The count is dropped (the track carries it) and a long status is cut with an ellipsis, never wrapped; longer sentences live in the captions. Every link in the row is at least 44 px tall. |
| 2 | **Preface** `div.ll-preface` (inside the head, below the captions) | — | No labels. One sentence in the form 「AからBへ」 (bold), then a paragraph about the song indented one character. A saved song that is opened again shows the first sentence only, ending in an underlined `続きを読む ▾`. | Same. |
| 3 | **Line node** `span.ll-line[data-state]` (display:block) | Directly after the `<br>` that ends each English lyric line. For the last line of a container, which has no `<br>`, it is appended as the container's last child. It may end up inside a Genius `<a>`. | One node whose state is `empty`, `next`, `filled`, `gap`, `voice` (the `♪` of a line of sounds) or `seam`; a repeat also carries `data-repeat`. | Same. |
| 4 | **Mark** `button.ll-mark` | Inside the line node, directly after the Japanese text. | `※`, with a 44×44 hit area. | Same. |
| 5 | **Note** `div.ll-note` | Immediately after its line node, as a sibling. At most one exists at a time. | Inline, unboxed, set 2em in. | Inline. |
| 6 | **Seam** (a line node with `data-state="seam"`) | Its own node, directly after the last translated line (past a note open under it). From the first missing line on, nothing of ours is drawn. | A black 2 px line across the column, one calm sentence under it, and an underlined bold button. | Same. |
| 7 | **Phrase highlights** | `CSS.highlights`: `ll-phrase` (note open) and `ll-phrase-peek` (desktop hover on ※). No DOM change. | — | `ll-phrase` only. |
| 8 | **Sheet** (settings / first run) | A shadow-DOM host appended to `document.body`, position fixed. | A square 360 px panel under `設定`, hung from its right edge, flipping upward if there is no room. Max height 70 vh, scrolls internally. Without an anchor (the userscript menu) it is centred. | A bottom sheet (any viewport under 600 px, or a touch pointer), max height 85 vh, with `env(safe-area-inset-bottom)` padding and a backdrop of `rgba(0,0,0,.4)`. |
| 9 | Userscript menu | `GM_registerMenuCommand("Lyric Lensの設定")` | — | — |

Section headers (`[Chorus]`) and blank lines get no line node. A **line of sounds** is a line whose every word is a pure vocal sound (`Woah, woah`, `(Yeah, yeah)`, `La-la-la`; the closed list in `core/sounds.ts`, which never includes a word that can mean something, such as hey, yo, nah or ho). It stays in the line model, aligned with its anchor, but it is not translated, not counted in `（12/67行）`, and the pen and the seam pass over it. Its node is a quiet `♪` wherever line nodes are drawn (with the empty slots, once written, above the seam), never on a plain page or below the seam, and it takes the place of any row an older edition stored for the line. There are no floating pills, rings, buttons or toasts.

**Line model.** Walk the text nodes of each container in order, splitting at each `<br>` across nested `<a>` and `<span>` elements. Each line becomes `{index, text, key, uid, occurrence, section}` (plus `sound` for a line of sounds, which has `uid` 0 and is not one of the distinct lines to translate), where `key` is the text NFKC-normalized and lowercased, with curly quotes, apostrophes and dashes straightened, whitespace collapsed and trailing punctuation dropped. Lines with the same `key` are **exact repeats**. A single changed word makes a line distinct.

## 3. State model

The song identity is the numeric Genius song ID read from the page's song data. The fallback is the path segment ending in `-lyrics`, with any annotation prefix or suffix stripped. When Genius rewrites the URL after an annotation click, the identity does not change, so nothing is torn down.

**Reading the table.** The **row** is the head's one line, after the `あ` icon: a bold underlined **primary** action, or a status sentence (small when the row is *settled*), then the links at the right. The links own three fixed slots, left to right: `止める` · `訳を隠す` / `訳を表示` · `設定`. A slot with no action in a state stays as an invisible, inert placeholder, so the other links never move; a state with no link at all (S1, SJ) has no slots either. The **track** is the 2 px line under the row: it appears only while there is progress to show (its 2 px stay reserved, so nothing moves), and it fills in black. **Under the row** come the captions (small and grey; a caption in ink says why a button cannot be pressed) and then the preface.

| State | Row | Under the row | Lines | The reader can |
|---|---|---|---|---|
| **S0 No lyrics** (no containers, or 0 translatable lines: none at all, or only lines of sounds) | Nothing. Lyric Lens is invisible. | — | — | — |
| **SJ Japanese lyrics** (≥60% of lines are kana/kanji with almost no Latin letters, **and** ≥30% of lines contain kana, so kana-less Chinese lyrics stay translatable; lines of sounds count neither way; nothing is stored) | Settled: `この曲の歌詞は日本語です`. No links. | — | None | Nothing: no request is offered or sent. A song with a stored edition is shown as usual. |
| **S1 No API key** | Primary `日本語で読む`. No links. | `最初に一度だけ、無料のAPIキーを設定します` | None | Open the first-run sheet |
| **S2 Never read** | Primary `日本語で読む` · `設定` | — | None | Start the request |
| **S2q Quota known exhausted** (every candidate model is in a quota cooldown, see §8) | `今日の無料枠を使い切りました` · `設定` | `{when}から、また訳せます` (omitted once that time has passed) | None | Nothing is sent. At reset the primary `日本語で読む` is back. |
| **S2f First request failed** (a stop is recorded and no line arrived) | Primary `もう一度訳す` with the button rule of the seam table below · `設定`. An invalid key shows the primary `設定を開く` alone. | The reason, in a sentence that points at nothing on the page (no `ここ`, no `続き`; see §4) | None | Retry by tapping. A stop that no longer applies (quota reset, key fixed) reads as plain S2. |
| **S2b Another song translating** (global lock held) | `別の曲を訳しています` · `あちらを止める` in the `止める` slot | `「{title}」を訳し終えると、この曲も訳せます` | None | Stop the other job. When the lock is released the row returns to S2 by itself; no request is sent until the reader taps. |
| **S3 Waiting** (before the preface) | `歌詞を読んでいます` · `止める`. Track: a short segment travels along it. | After 15 s with no preface and no line: `AIの返事を待っています。混み合っていると1分ほどかかることもあります`. Where answers arrive in one piece: `この環境では訳がまとめて届きます`. | A reserved blank slot under every line (a `♪` under a line of sounds); the pen stands in the first | Scroll, listen, use Genius, stop |
| **S4 Arriving** | `訳しています` `（{done}/{total}行）` (no count on phones) · `止める` · `訳を隠す` · `設定`. Track: fills with {done}/{total}. | `この環境では訳がまとめて届きます` where answers arrive in one piece; the preface | Slots fill in order. The pen stands at the first missing line after the last filled one. Repeats fill together with their first occurrence. | Read, open notes, stop, hide |
| **S4m Mirrored** (the same song is running in another tab) | `別のタブで訳しています` · `止める` · `訳を隠す` | The preface | Filled live from storage; the pen stands at the frontier | Read, stop (this sets an abort flag the owner tab obeys) |
| **S5 Complete** | Settled: `AIによる日本語訳` (`訳を隠しています` while hidden) · `訳を隠す` / `訳を表示` · `設定` | The preface (collapsed when a saved song is opened again) | All filled. No motion on a return visit; in the session that wrote it the row settles once (§6). | Read, open notes, hide, open settings |
| **S5g Complete with gaps** (some lines failed to parse or align) | Primary `抜けた行を訳す` · `訳を隠す` · `設定` | `{n}行が訳せていません。下の「――」の行です`, plus the blocker in ink when it disables the primary; the preface | Gap lines show a quiet `――` | Request only the gaps (one tap = one request) |
| **S6 Interrupted (reason)** | The seam's button as the primary (`続きを訳す`; `設定を開く` for an invalid key, which drops the head's own `設定`) · `訳を隠す` · `設定`. Track: stands still at {done}/{total}. | `{total}行のうち{done}行を訳してあります`; the preface if it arrived. With `訳を隠す` on, the seam is hidden with the translation, so the seam's sentence is repeated here, in ink, whenever the button cannot simply be pressed (disabled, `設定を開く`); there it says `途中で`/`途中まで`/`途中から` instead of `ここで`/`ここまで`/`この先は`, since no line is there to point at. | Filled lines stay. The **seam** sits at the writing frontier: the first missing line after the last filled one (earlier holes are gaps, `――`). Nothing is drawn below it. | Resume (subject to the reason's rule), hide, settings |
| **S7 Lyrics changed since** (some stored line hashes no longer match the DOM) | Primary `新しい行を訳す` · `訳を隠す` · `設定` | `歌詞が更新されました。まだ訳していない行が{n}行あります`, plus the blocker in ink when it disables the primary; the preface | Matching lines keep their translations; a new line shows a reserved blank slot, or `――` when translated lines follow it | Translate the new lines only |
| **S8 Retranslating** | `訳し直しています` · `止める`. Track: a short segment travels along it. | `訳し終えるまでは、今の訳をそのまま表示します`; the preface | The old edition stays. The new one is buffered out of sight and swapped in all at once when it completes. | Read the old edition, stop |
| **S8f Retranslation failed** (or the finished edition could not be stored) | Settled: `AIによる日本語訳` · `訳を隠す` · `設定` | `訳し直せませんでした。今の訳はそのまま残っています`, then the reason in ink (§4); the preface | Old edition intact; the new partial is discarded | Dismiss by any interaction (while the row is on screen) |

**The seam reasons (S6) and their buttons**

| Reason | Seam sentence | Button rule |
|---|---|---|
| busy (all fallbacks gave 503) | `AIが混み合っていて、ここで途切れました。少しおいてから続きを訳せます` | `続きを訳す`, enabled |
| per-minute limit | `AIの回数制限にかかりました。1分ほどおいてから続きを訳せます` | Disabled until the limit's reset (about 60 s), then enabled. It does not fire on its own. When the wait is longer than 90 s (every model benched), the sentence names the time instead: `AIの回数制限にかかりました。{when}ごろから続きを訳せます`. |
| daily quota | `今日の無料枠を使い切りました。{when}から続きを訳せます` | Disabled until reset, then enabled. It does not fire on its own. |
| invalid key | `APIキーが使えなくなりました。設定でキーを入れ直してください` | `設定を開く` (the head row then drops its own `設定`). The stop stops applying as soon as a configured key is believed to work, whichever page fixed it. |
| safety filter | `この先はAIの安全フィルタで止められました。もう一度試すと通ることがあります` | `続きを訳す` |
| request rejected (400s) | `AIへの依頼が通らず、ここで途切れました。もう一度試すと通ることがあります` | `続きを訳す`, enabled |
| no usable model | `今はAIを使えません。少しおいてから続きを訳せます` | `続きを訳す`, enabled |
| empty answer | `AIの返事が空で、ここで途切れました。もう一度試せます` | `続きを訳す`, enabled |
| network | `接続が切れました。つながったら続きを訳せます` | Disabled while `navigator.onLine` is false, enabled when the connection returns. Never fires automatically. |
| silent (two models timed out) | `AIから返事がなく、ここで途切れました。少しおいてから続きを訳せます` | `続きを訳す`, enabled |
| unusable output | `AIの返事をうまく読み取れず、ここで途切れました。もう一度試せます` | `続きを訳す`. While every model is benched for it (up to 10 min, a stored `until` longer than 90 s ahead) the button is disabled and the sentence names the time: `AIの返事をうまく読み取れず、ここで途切れました。{when}ごろからもう一度試せます`. |
| reader stopped | `ここで止めました` | `続きを訳す` |
| output-length cut (long song) | `長い曲なので、ここで一度区切りました` | `続きを訳す` |
| tab closed or suspended (partial record found, no live lock), or a stop that no longer applies | `ここまで訳してあります` | `続きを訳す` |
| another song holds the lock, or today's quota is known spent | The reason's first sentence, then the blocker: `別の曲を訳し終えると、この曲も訳せます` / `今日の無料枠を使い切りました。{when}から訳せます` (`あとで訳せます` once the time has passed). A busy, per-minute, no-model or silent stop next to a spent quota says only `ここで途切れました`, so two limits are never named. | Disabled until the blocker clears |

The seam is a stop line, not a decoration: a black 2 px rule across the column right after the last translated line, the reason under it, and the next step as an underlined bold button. It is the border between what has been translated and the plain English that follows, so it reads as a statement about the page, not as the translation of the lyric above it. Below it nothing of ours is drawn (no slots, no gaps, no translated repeats) until the reader resumes.

`{when}` is the next Pacific midnight, computed with `Intl` in `America/Los_Angeles` and formatted in `Asia/Tokyo` as `H:MM` (no leading zero: `9:05`). It reads `16:00` or `17:00`, with the prefix `明日 ` when the reset falls on the next JST date.

**Request guards.** A button locks the moment it is pressed. There is one global lock in GM storage, `{songId, tabId, heartbeat}`, with a heartbeat every 2 s; a lock older than 10 s is stale. Before every request the client checks the exhausted registry. Nothing restarts on reload.

**Head guards.** A tapped primary action locks at once, and the next render decides from state whether it stays locked. `止める` ignores a tap in its first 600 ms on screen, so a double tap or a repeating key on `日本語で読む` cannot stop what it just started; focus then rests on the status sentence instead of landing on `止める`. Otherwise focus follows the slot: a link keeps focus when the row around it changes, and never lands on an invisible placeholder.

**Announcements.** The head is a region labelled `Lyric Lens 日本語訳`. The status sentence is one persistent polite live region whose text changes in place, so streaming never re-announces it. The track is a `progressbar` labelled `翻訳の進み具合` (value `{done}` of `{total}`). The `あ` icon and the count are hidden from assistive technology.

## 4. Japanese UI copy (verbatim, complete)

**Head row**
- Status, working or asking: `歌詞を読んでいます` · `訳しています` + `（{done}/{total}行）` · `別のタブで訳しています` · `別の曲を訳しています` · `今日の無料枠を使い切りました` · `訳し直しています`
- Status, settled (small): `AIによる日本語訳` · `訳を隠しています` · `この曲の歌詞は日本語です`
- Primary actions (bold, underlined): `日本語で読む` · `もう一度訳す` · `続きを訳す` · `抜けた行を訳す` · `新しい行を訳す` · `設定を開く`
- Links, in their slots: `止める` · `訳を隠す` / `訳を表示` · `設定`; `あちらを止める` takes the `止める` slot.

**Captions (under the row)**
- `最初に一度だけ、無料のAPIキーを設定します` (S1)
- `{when}から、また訳せます` (S2q)
- `「{title}」を訳し終えると、この曲も訳せます` (S2b)
- `AIの返事を待っています。混み合っていると1分ほどかかることもあります` (S3, after 15 s)
- `この環境では訳がまとめて届きます` (buffered fallback only)
- First request failed (S2f), by reason:
  - busy: `AIが混み合っていて、訳し始められませんでした。少しおいてからもう一度試せます`
  - rate: `AIの回数制限にかかりました。1分ほどおいてから訳せます` (wait over 90 s: `AIの回数制限にかかりました。{when}ごろから訳せます`)
  - quota: `今日の無料枠を使い切りました。{when}から訳せます` (`あとで訳せます` when no time is known)
  - auth: `APIキーが使えなくなりました。設定でキーを入れ直してください` · primary `設定を開く`
  - blocked: `この曲はAIの安全フィルタで止められました。もう一度試すと通ることがあります`
  - rejected: `AIへの依頼が通らず、訳し始められませんでした。もう一度試すと通ることがあります`
  - no-model: `今はAIを使えません。少しおいてからもう一度試せます`
  - empty: `AIの返事が空で、訳し始められませんでした。もう一度試せます`
  - network: `接続が切れて、訳し始められませんでした。つながったら訳せます`
  - silent: `AIから返事がなく、訳し始められませんでした。少しおいてからもう一度試せます`
  - unusable: `AIの返事をうまく読み取れませんでした。もう一度試せます` (benched over 90 s: `AIの返事をうまく読み取れませんでした。{when}ごろからもう一度試せます`)
  - length: `長い曲なので、一度では訳し切れませんでした`
- `{n}行が訳せていません。下の「――」の行です` (S5g)
- `歌詞が更新されました。まだ訳していない行が{n}行あります` (S7)
- `{total}行のうち{done}行を訳してあります` (S6)
- `訳し終えるまでは、今の訳をそのまま表示します` (S8)
- A blocker that disables the primary (S5g, S7, S6 with the translation hidden): `別の曲を訳し終えると、この曲も訳せます` / `今日の無料枠を使い切りました。{when}から訳せます`
- Retranslation failed (S8f): `訳し直せませんでした。今の訳はそのまま残っています`, with the reason in ink on a second line:
  - when it ran and stopped: `AIが混み合っていました。少しおいてからもう一度試せます` · `AIの回数制限にかかりました。1分ほどおいてからもう一度試せます` · `今日の無料枠を使い切りました。{when}からもう一度試せます`（時刻が分からなければ `今日の無料枠を使い切りました`） · `APIキーが使えなくなりました。設定でキーを入れ直してください` · `AIの安全フィルタで止められました` · `AIへの依頼が通りませんでした` · `AIを使えませんでした` · `AIの返事が空でした` · `接続が切れました` · `AIから返事がありませんでした` · `AIの返事をうまく読み取れませんでした` · `長い曲なので、一度では訳し切れませんでした` · `返事が途中で途切れました` · `訳せない行が残りました`
  - when it could not start: `今日の無料枠を使い切りました。{when}からもう一度試せます` · `別の曲を訳しています。訳し終えてからもう一度試せます`
- The reader stopped a retranslation (S8f): `訳し直しを止めました。今の訳はそのまま残っています`, with no reason line (it is their own action, not a failure).
- The edition could not be stored (S8f): `訳を保存できませんでした` with `今は読めますが、このページを閉じると消えます` (the edition stays on screen and is not replaced by a same-song refresh)

**Preface**
- No labels: the sentences say what they are. The first is one natural sentence in the form `AからBへ` (the prompt asks for it: no arrow, at most 40 characters); the second says what the speaker does in the lyrics (at most 80 characters) and is indented one character. Both come from the model.
- Collapsed: the first sentence ends with `続きを読む ▾`, a button with `aria-expanded="false"` that controls the second paragraph. Opening it removes the toggle.

**Seams:** see the table in section 3.

**Lines**
- Gap: `――`, labelled `この行は訳せていません` for assistive technology
- A line of sounds: `♪`, labelled `声だけの行` for assistive technology

**Notes**
- Kind labels, after the English phrase: `〔スラング〕` · `〔言葉遊び〕` · `〔元ネタ〕` · `〔慣用句〕` · `〔二通りに読める〕`
- Conjecture tag: `〔推測〕`
- Grounding: `Geniusの注釈を参考にしました` (the note is ours; より would read as a quotation of Genius' text)
- Disclosure: `Geniusの注釈を英語で読む ▾` with `{votes}票` after it · expanded `たたむ ▴` · truncated text `…` + `続きを読む`
- Close: `注を閉じる` (only while an annotation is unfolded)
- Mark aria-label: `注：{kind}` (with several kinds, joined with `、`); `aria-expanded` says whether it is open

**First-run sheet**
- Title: `日本語訳をはじめる` · `閉じる`
- Step 1: `Google AI Studioを開き、Googleアカウントでログインして無料のAPIキーを作ります` + link `Google AI Studioを開く`
- Step 2: `キーをコピーして、下に貼り付けます`
- Placeholder: `ここに貼り付け`
- Empty field: `キーを貼り付けてください`
- Privacy note: `キーはこのブラウザにだけ保存され、Google以外には送られません。無料枠では、送った歌詞などがGoogleのサービス改善に使われることがあります`
- Primary: `保存してこの曲を訳す` · secondary: `保存だけする`
- While checking: `確かめています…`
- Bad key: `このキーは使えませんでした。コピーし直してください`
- Network: `Googleにつながりませんでした。接続を確認してください`
- The key could not be stored: `キーを保存できませんでした。もう一度試してください`
- Google busy or failing (503, 429, timeout): `Googleが混み合っていて、確かめられませんでした。少しおいてから、もう一度試してください`

**Settings sheet**
- Title: `Lyric Lensの設定` · `閉じる`
- Section: `翻訳に使うAI`
- Row: `Google Gemini`, its status at the right, then the masked key `••••abcd` with `キーを消す` (`キーを入れ直す` while the key is rejected; the new field is then focused), or, with no key, a field, `保存` and `Google AI Studioでキーを作る`
- Row status, in words: `使えます` · `未設定` · `今日の無料枠を使い切りました（{when}から使えます）` · `キーが使えません` · `確かめています…`
- Row messages (after a failed check): for a rejected key only the next step, `コピーし直して、貼り付けてください` (the status already says `キーが使えません`); the first-run sentences for a network failure and a busy Google
- Section: `この曲`
  - `{YYYY}年{M}月{D}日に{model}で訳しました`, with the model as a reader says it (`Gemini 3.5 Flash-Lite`, see §7). A part that is unknown is left out: `Gemma 4で訳しました`, `2026年12月31日に訳しました`.
  - `直近のエラー` (a collapsed disclosure, shown only when the song's stop carries detail): `{model} · {status} · {kind}` (the model as a reader says it; `—` for any part that is unknown) and the error text (at most 200 characters, selectable, small, quiet)
  - `この曲を訳し直す` → confirm `今の訳を残したまま訳し直し、訳し終えたら新しい訳に入れ替えます` · `訳し直す` · `やめる`
  - `この曲の訳を消す` → confirm `この曲の保存した訳を消します。元に戻せません` · `消す` · `やめる`
- Section: `保存データ`, top to bottom:
  - `{n}曲を保存しています（{size}）` (`保存した曲：…` until the count is read; `保存した曲はありません` when there are none)
  - `書き出す` · `読み込む` · `すべて消す`
  - `書き出したファイルは、別の端末でも読み込めます`
  - The result of the last action: `{n}曲を書き出しました` / `書き出せませんでした`; `{n}曲を読み込みました` / `新しく読み込める曲はありませんでした` / `読み込めませんでした。Lyric Lensで書き出したファイルを選んでください`; `消せませんでした` when すべて消す fails
  - `すべて消す` → confirm `保存した{n}曲の訳をすべて消します。元に戻せません` · `すべて消す` · `やめる`

## 5. Notes

**Content contract.** A note is attached to the **first occurrence** of a line. It quotes an exact phrase from that line, has one of the five kinds, a Japanese explanation of at most 2 sentences and about 80 characters, an optional conjecture flag, and an optional `g` (the id of the Genius annotation it drew on). Typical density is no more than one note per 6 lines, and zero is fine. The ceiling is per song, not per request: `max(2, round(unique lines / 6))` from the whole song, minus the notes the record already holds, so a short resume never gets a denser budget. The 2 extra wordplay/ambiguity slots are used once per song.

**Resting state.** A noted line ends with a bold black `※` directly after its Japanese text. There is one mark per line however many notes the line has. Nothing is marked on the English at rest; this is deliberate, to keep the page clean. Exact repeats of a noted line carry the `※` in the quiet grey, and it opens the same note in place.

**Hover (desktop, pointer:fine only).** Hovering over `※` paints `ll-phrase-peek` under the English phrase (a black 2 px underline, no yellow), so the eye links the mark to its words. Nothing depends on hover.

**Opening.** Tap or click `※`, or focus it and press Enter or Space. This happens in one frame:
1. Any other open note closes.
2. `div.ll-note` is inserted after the line node.
3. `ll-phrase` marks the English phrase: yellow behind it and a black 2 px underline.
4. `aria-expanded="true"` is set, and the `※` turns yellow (black on `#FFFF64`).

The phrase in the lyric, the open `※` and the note's heading (below) are the yellow set. They turn yellow together, and yellow is used nowhere else.

**Layout**
- Unboxed: no card, no fill, no border. The note is set 2em in from the English left edge, in 14/24 px ink (13/22 px on phones), directly under its line (the line's bottom padding shrinks to 4 px) and 24 px before the next lyric. It opens at once; nothing animates.
- For each note:
  - Row 1: the quoted English phrase without quotation marks, in Genius' own lyric face (15 px, weight 600), black on yellow; then `〔{kind}〕` in quiet grey (13 px), then `〔推測〕` if flagged. They wrap together. The phrase is always shown, so nothing is lost if the Highlight API or the phrase match fails.
  - Row 2: the explanation.
  - Multiple notes are 12 px apart, with no rule between them.
- When `g` matches a fetched Genius annotation that overlaps this line, a row shows `Geniusの注釈を参考にしました` (quiet, 13 px). When a fetched annotation's fragment overlaps the quoted phrase (with or without `g`), an underlined link `Geniusの注釈を英語で読む ▾` appears, with `{votes}票` after it. Expanded, it reads `たたむ ▴` and shows the plain annotation text in Genius' face (14/22 px), cut at 400 characters with `…` and an underlined `続きを読む`. Only the single highest-voted overlapping annotation is shown.
- `注を閉じる`, an underlined link at the foot of the note, appears only while an annotation is unfolded (a long read worth leaving) and closes the note.

**Closing.** Tap `※` again, press Esc (while focus is on the mark or inside the note; focus returns to `※`), tap `注を閉じる`, or open another note. `訳を隠す` closes it too. Notes never close on scroll. When a note above the viewport closes, the scroll position is compensated.

**Keyboard.** Every `※`, disclosure and control is a real `<button>`, reached with Tab in document order. Focus ring: 2 px outline in `black`, offset 2 px. There are no global shortcuts.

**Phrase matching.** The note's phrase and the line text are normalized the same way (case, straightened quotes, apostrophes, ellipses, whitespace), and a character-offset index is built over the line's text nodes. If no exact normalized match is found, try matching with dropped-g endings (in'/ing), then give up: there is no yellow or underline, but the note still works. Ranges are stored as (line key, start, end) and rebuilt after every observer pass.

**Without the Highlight API.** Feature-detect `CSS.highlights`. If it is missing, the English gets no yellow or underline and everything else stays the same; the note's heading still shows the phrase.

## 6. Visual system

**Direction.** Genius' own grammar in one voice: black on white, square corners, underlined links, `▾` for more, and the marker yellow for the words you asked about. There are no cards, pills, fills or shadows on the reading surface, no accent colour, and no red. The Japanese is body text and is set as such: ink, in the system gothic, directly under its English line. Black and weight are spent only where the reader is needed or Lyric Lens is working.

**Tokens** (prefix `--ll-`, set on `.ll-head`, `.ll-line` and `.ll-note`)

| Token | Light | Dark | Used for |
|---|---|---|---|
| `black` | `#000` | `#F2F2F2` | the primary action, the status, links, the track's fill, the seam's line, the pen, `※`, focus rings |
| `ink` | `#262626` | `#E6E6E6` | the translation, the preface, note text, the seam's sentence, a caption that says why (about 15:1 on white) |
| `quiet` | `#6B6B6B` | `#A3A3A3` | ad-libs, repeats, captions, the count, `〔kind〕`, `Geniusの注釈を参考にしました`, votes, a disabled link (5.3:1 on white) |
| `rule` | `#E5E5E5` | `#3A3A3A` | the head's empty track |
| `yellow` | `#FFFF64` | `#FFFF64` | only the words the reader asked about (§5); text on it is always `#000` |

The sheet (a shadow root) keeps the same five values as `--paper` `#FFFFFF`, `--ink`, `--black`, `--quiet` and `--rule`; dark: `#1C1C1C` paper, `#F2F2F2` ink, `#FFFFFF` black, `#A3A3A3` quiet, `#333333` rule. Its one shadow, `0 8px 24px rgba(0,0,0,.16)` (`.5` in dark), belongs to the desktop popover.

**Dark detection.** Walk up from the first lyrics container to the first computed `background-color` that is at least half opaque. If its luminance (`0.2126 R + 0.7152 G + 0.0722 B`, over 255) is below 0.4, set `ll-dark` on `<html>`, which swaps `black`, `ink`, `quiet` and `rule` for their dark values. The sheet follows `prefers-color-scheme` unless the page itself was detected as dark. Re-check on every refresh, so navigation re-detects.

**Type**
- **No web fonts.** Every `ll-` node uses one stack (only the `♪` of a line of sounds skips its Latin part, see Lines): Genius' lyric face first (for Latin letters and digits), then the Japanese system gothics: `"Hiragino Sans"`, `"Hiragino Kaku Gothic ProN"`, `"BIZ UDPGothic"` (standard on Windows 10 1809 and later, and sturdier than Yu Gothic), `"Noto Sans CJK JP"`, `"Noto Sans JP"`, `"Yu Gothic UI"`, `Meiryo`, `system-ui`, `sans-serif`. Gothic only: mincho does not suit the spoken register of rap, reads poorly on a phone, and Android ships none.
- **Latin from Genius, generic families dropped.** At start and on every refresh the first lyrics container's computed `font-family` is read (today Programme). Its generic families (`serif`, `sans-serif`, `monospace`, `cursive`, `fantasy`, `system-ui`, `ui-*`, `math`, `emoji`, `fangsong`, `-apple-system`, `BlinkMacSystemFont`) are dropped, and the rest is set as `--ll-latin` on `<html>`. A generic family left at the end would make the browser draw our Japanese in its default face before it ever reached our Japanese stack. Until it is read, the stack starts `Programme, "Helvetica Neue", Arial`.
- Sizes (px, size / line height):

| Element | Desktop | Phone | Weight · colour |
|---|---|---|---|
| Japanese line | 16 / 26 | 15 / 24 | 400 · `ink` (`quiet` for repeats and ad-libs) |
| Row status | 15 (settled row: 13) | same | 400 · `black` |
| Primary action | 15 | same | 700 · `black`, underlined |
| Link (`止める`, `訳を隠す`, `設定`) | 13 / 20, 44 tall, 18 apart | same | 400 · `black`, underlined |
| Count | 15 | not shown | `quiet`, tabular figures |
| Caption | 13 / 21 | same | `quiet` (`ink` when it says why), tabular figures |
| Preface, `AからBへ` | 16 / 26 | 15 / 24 | 700 · `black` |
| Preface, paragraph | 15 / 26, indented 1em | 15 / 24 | 400 · `ink` |
| `続きを読む ▾` | 13 / 26 | same | 400 · `black`, underlined |
| `※` | 15, in a 22 px box | same | 700 · `black` |
| Seam sentence | 14 / 22 | same | `ink` |
| Seam button | 15 | same | 700 · `black`, underlined |
| Note body | 14 / 24 | 13 / 22 | `ink` |
| Note phrase | 15 / 22, Genius' face | same | 600 · `black` on yellow |
| `〔kind〕`, `〔推測〕`, `Geniusの注釈を参考にしました` | 13 | same | `quiet` |
| Genius disclosure, `続きを読む`, `注を閉じる` | 13 / 32 | same | `black`, underlined |
| Votes `312票` | 12 | same | `quiet`, tabular figures |
| Genius annotation text | 14 / 22, Genius' face | same | `ink` |

- Underlines are 1 px, offset 3 px; where hover exists they thicken to 2 px.
- Focused controls keep 72 px clear of Genius' sticky nav (140 px on phones, where the nav and its ad slot are about 125 px) and 24 px clear of the bottom edge.

**Japanese typesetting** (on every `ll-` node)
- `line-break: strict;`
- `word-break: auto-phrase;` with a `normal` fallback
- `overflow-wrap: anywhere;`
- `text-spacing-trim: trim-start;` where supported
- `hanging-punctuation: none;`
- `letter-spacing: .02em;` (none on English phrases and Genius' annotation text)
- `text-wrap: pretty;` on the Japanese lines, the preface paragraph, note text, captions and seam sentences
- No `palt`: tightening the spacing makes body text harder to read.
- Copy is set without hand-typed spaces between Japanese and Latin letters (`Google AI Studioを開く`); `text-autospace: normal`, on the sheet and on every `ll-` node of the reading surface, does the spacing where it is supported.

**Spacing**
- The head sits 16 px under Genius' header and 28 px above the first lyric (24 px on phones). The row is 44 px tall; the first caption is 8 px under it (2 px between captions) and the preface 16 px under the row and captions.
- A line node has padding `2px 0 12px` (10 px bottom on phones) and starts at the English left edge with no indent: 2 px between an English line and its Japanese, 12 px from there to the next English line, so the two read as a pair. It is at least one line tall (26 px; 24 px on phones).
- A seam is padded 18 px above and 22 px below.

**Lines**
- **A line not yet written is a reserved blank slot**, one line tall, drawn with nothing: no dots, no bars, no dashes, which would read as unfinished.
- **The pen** stands in the slot at the writing frontier (the first missing line after the last filled one): a 1.5 × 17 px black vertical line (16 px on phones) at the place where the first character will land. It breathes, like a breath and not a keystroke, so it does not pull the eye from the line being read. There is one pen at a time. It sits in a slot of fixed height, so it never makes its line grow. When the translation arrives, the text is set at once and the pen moves on.
- **A written line** is `ink`, with no fade and no rise: text is set, it does not appear.
- **A gap** (a line the model skipped) shows `――` in `quiet`, announced as `この行は訳せていません`.
- **A line of sounds** shows `♪` in `quiet`, announced as `声だけの行`: the mark Japanese captions put on music. Its row is set in the Japanese face, because a Latin face (Arial) draws a small, thin note that reads as a stray mark; the whole row rather than the mark, so the row keeps the height of the others. A row that has nothing left once its sounds go, or that only repeats its English line (the prompt leaves nothing but sounds as written), shows the same `♪`, unless the line is Japanese already. So, wherever line nodes are drawn, a line without Japanese says why: `♪` needs none, `――` was skipped, and plain English below the seam is still to come.
- **A repeat** (an exact normalized repeat) is `quiet` as a whole, with no mark (no `↺`): readable, but a reader who has already read it can skip it. Its `※`, if any, is quiet too. A line that differs by one word is distinct and gets `ink`.
- **Ad-libs.** When the English line's parentheses are all at its end, the matching trailing `（…）` groups of the translation are set in `quiet`, so the eye lands on the line itself.
- **The parting** (the opening animation): see Motion.
- **訳を隠す** hides the line nodes (the seam too), the notes and the preface with `display: none`, so the page reads as plain Genius.

**Link resets.** All `ll-` nodes get `background: transparent !important; text-decoration: none !important; cursor: auto; font-style: normal;` and their own colours with `!important`, so Genius' link styles never reach them. Our underlined links set their own underline back.

**Highlights**
- `::highlight(ll-phrase)`: `background-color: #FFFF64; color: #000; text-decoration: underline 2px #000; text-underline-offset: 3px;`
- `ll-phrase-peek`: the same underline with no background.

**Motion**
- **The parting.** On the reader's tap that creates the slots, the room for the Japanese opens under the lines within 600 px of the viewport, over 260 ms (`cubic-bezier(.2,0,0,1)`, from no height and no padding to a full line). Every other slot is simply there. The English is seen to part once. It never plays on a cached render or an ordinary re-render.
- **The pen** breathes: opacity 1 → .3 → 1 over 1.4 s, ease-in-out, for as long as its slot is waiting.
- **The track.** Each arriving line widens the fill over 240 ms (`cubic-bezier(.2,0,0,1)`). While waiting (S3, S8) a 56 px segment travels along the track, 0.7 s each way (`cubic-bezier(.4,0,.6,1)`, alternating).
- **Settling**, once per translation finished in this session: the track has filled, then the row becomes the settled label and the status `AIによる日本語訳` fades in over 360 ms (`data-settle` holds for 600 ms). A song opened from storage never settles.
- **Touch and hover.** A pressed control dims to 55 % at once, with no transition.
- **Sheet.** The desktop popover fades in with a 4 px drop over 160 ms (`cubic-bezier(.2,0,0,1)`); centred, without an anchor, it only fades. The phone sheet rises from the bottom edge over 280 ms, its backdrop fading in over 200 ms.
- **Everything else is instant**: a written line, a note opening or closing, `訳を隠す` / `訳を表示` (the English line being read is held in place by scroll compensation). Nothing fades in line by line.
- `prefers-reduced-motion: reduce`: the pen stops breathing (a steady line), the parting does not play, the track fills without a transition, the waiting segment is not drawn (parked, it would read as 10 % done; the sentence says it is waiting), the settle fade is dropped, and the sheet and its backdrop only fade over 100 ms.
- A cached render has no motion at all.

**The sheet** (settings, first run) is a square panel in a shadow root: `paper` with a 1 px `black` border, no radius.
- Its title row is 48 px tall: the title (15 px, 700) at the left, an underlined `閉じる` (a 44 px target) at the right, and a 1 px `black` rule underneath, the same rule Genius draws under its own headings. The body (14 px / 1.6, `ink`) scrolls inside the panel.
- Sections are 24 px apart with a 1 px `rule` between them; section titles are 13 px bold. Helper lines, explanations and messages are 13 / 21 px `quiet`.
- Actions are underlined 13 px links, 32 px tall (44 px on phones), 18 px apart. The one black button, `black` with `paper` text, 15 px bold, 44 px tall (full width and 48 px on phones), is for the one thing the sheet is for (`保存してこの曲を訳す`) and for the confirmations (`訳し直す`, `消す`, `すべて消す`). Disabled, it is `#333333` with white text.
- The key field is 48 px tall with a 1 px `black` border and no radius; its text is 15 px (16 px on phones, so iOS does not zoom). Focus draws a 2 px outline, offset 2 px, on links, buttons and the field, and the field also gets an inset line.
- First-run steps are numbered because they are a real sequence: 24 px black squares with `paper` numerals.
- Status is said in words. There are no dots, no red and no green: a rejected key is bold, and an error line is bold black.
- Dark: the same roles on `#1C1C1C`; the black button inverts to a white one.

## 7. Settings

**Where it opens:** `設定` in the head row (the panel hangs from its right edge), the userscript menu (centred), and `設定を開く`, the primary action of a key-error stop. It closes with `閉じる`, Esc or a press on the backdrop, and focus goes back to where it was.

**First run (S1).** Tapping `日本語で読む` with no key saved opens the first-run sheet: the title row, two numbered steps with the link to Google AI Studio, the key field, a message line, the privacy note, then the one black button `保存してこの曲を訳す` and, below it, the link `保存だけする`. The key is checked with Gemini's model-list endpoint, never a generation call, when the reader presses a button or Enter, and the message line says `確かめています…` meanwhile. The button is never disabled for an empty field: pressing it with nothing pasted focuses the field, and the line says `キーを貼り付けてください`.
- `保存してこの曲を訳す` saves the key and immediately starts this song's request. The reader's tap already expressed that intent.
- `保存だけする` saves the key and moves to S2.

**Settings layout** (one scrolling column, three sections)
1. **翻訳に使うAI.** One Gemini key row; the engine chooses among Gemini's models itself (§8). The row names the service, `Google Gemini`, and says its status in words at the right; below it are the masked key (`••••abcd`) with `キーを消す`, or, with no key, the field with `保存` and a link `Google AI Studioでキーを作る`. Keys are stored only in `GM.setValue`, never in `localStorage` or the DOM (apart from the field's value while the reader types).
2. **この曲.** Shown when this song has an edition or a recorded error and no request is writing it. One sentence gives the date and the model as a reader says it (this is the only place a model name appears), then `直近のエラー` when there is one, then `この曲を訳し直す` and `この曲の訳を消す`, each with an inline confirmation that replaces the buttons in place. Models are named by `modelLabel`: `gemini-3.5-flash-lite` reads `Gemini 3.5 Flash-Lite`, `gemma-4-31b-it` reads `Gemma 4 31B` (the `-it` build tag is dropped), `gemini-3-flash-preview` reads `Gemini 3 Flash Preview`; an id it does not recognise is shown as it is.
3. **保存データ.** Top to bottom: the status line (count and size, `{n} KB` or `{n.n} MB`), the actions (`書き出す` · `読み込む` · `すべて消す`; with nothing saved only `読み込む` can be pressed), the explanation, and one message line for the result of the last action. Export writes `lyric-lens-YYYYMMDD.json`. Import validates every record, merges only what is strictly better (more translated lines, then finished over cut, then newer), and skips the song a request is writing. Eviction past 300 songs orders by last read and never removes a partly translated song.

**Statuses are words, never colour.** A working key says `使えます`, a rejected one `キーが使えません` in bold. A destructive step is guarded by a sentence and a second tap (`やめる` puts the buttons back), not by a warning colour.

There is no auto-translate, no note-amount setting, no font-size control (the page zoom covers it) and no quota counter.

**Translation-visibility toggle.** `訳を隠す` lives in the head row, not in settings, so reading along with the music is one tap away. It hides the line nodes (the seam too), the notes, the highlights and the preface, so the page reads as plain Genius; the row then says `訳を隠しています` beside `訳を表示`. It is remembered per song, on that song's record (without touching its date). Asking for a translation (any action that starts a request) shows the song again.

## 8. Engine contract (the parts that shape the UX)

**Request.**
- The full lyrics in order, each line tagged with an ID. Exact repeats carry the ID of their first occurrence as `(=L7)`, lines of sounds are shown as `(声)` with no ID (context only, never asked for), and section headers are kept as context.
- Fetched Genius annotations as grounding: the fragment, the text, the votes and an id.
- The model writes the song record first, then one record per **distinct** ID.
- Prompt rules:
  - Tone and temperature come first, meaning second.
  - Keep the speaker's register (俺/僕/あたし, sentence endings).
  - No explanation inside a translation line.
  - Soft guidance: prefer about one phone line (around 24 characters), but never drop tone or a double meaning to fit.
  - The note bar and caps from section 5.
  - The preface: `who` is one natural sentence of the form 「AからBへ」 (at most 40 characters, no arrow, no bracketed asides); `what` says what the speaker does in the lyrics (at most 80 characters).

**Output: line-delimited JSON**, one object per line:
- `{"t":"song","who":"…","what":"…","tone":"…","motifs":[{"en":"…","ja":"…"}]}`. `tone` and `motifs` are stored for resume and not shown.
- `{"t":"line","id":"L12","head":"<first 3 English words>","ja":"…","notes":[{"q":"…","k":"slang|wordplay|reference|idiom|ambiguous","x":"…","c":false,"g":"…"}]}`
- `{"t":"end"}`

**Validation.** A line record whose `head` does not match the normalized first words of that ID's line is dropped, and its slot stays empty (becoming a gap at the end). A record that fails to parse affects only that line. Each valid record is written to storage before it is rendered.

**Model selection and failure handling.**
- Candidates come from the model list per tier: Flash 6, Flash-Lite 3, Gemma 1 (so the newest Flash models never crowd out the tiers with their own quotas). One function builds the set for both the request and the pre-send availability check.
- Order: Flash before Flash-Lite before Gemma; within a tier, models that answered within a week and have not failed since go first (fastest first-text first), unknown ones keep their rank, and models busy or silent in the last half hour go last.
- A model silent for 30 s (first text) is given up on and the next starts at once. After two silent models in a row the call stops (stop reason silent: 「AIから返事がなく…」) instead of waiting out the rest.
- Flash gets a 20 s budget, from the start of the call, for its first line: each Flash attempt waits for what is left of it (8 to 30 s); with less than 8 s left, or once it is spent, the remaining Flash models are skipped and Flash-Lite continues. A Flash model that has started writing is never cut off. Such a timeout is benched like any silence (5 min) but does not count toward the two-silent-models stop, and the next calls for 10 minutes put Flash-Lite first, Flash after it, until a Flash model answers. Pinned models ignore this.
- A 200 response in which no line was accepted is a failure (`unusable`) and moves on to the next model.
- Cooldowns per model: quota until the reset (or Google's stated wait), per-minute limit for its stated wait (at least 60 s), overloaded 2 min, silent 5 min, unusable 10 min, rejected request (400, after one retry without `thinking`) 6 h. Only a quota cooldown makes the head say today's quota is over; the others still allow a tap, and the chain answers it with the right sentence.
- Model list: cached 7 days; if a refresh fails, the stale cached list of any age is used before the built-in `FALLBACK_GEMINI` ids (used only on a first run whose list cannot be fetched).
- Each failed model is logged with `console.warn("[Lyric Lens]", {kind, model, status, detail})` (key scrubbed) and the last error is kept on the song's stop for 「直近のエラー」.

**Resume.** One request. It sends the same full tagged lyrics with already-translated IDs annotated with their Japanese, plus the stored song record, and asks only for the missing IDs. A `t:"song"` record is requested only if none is stored.

**Transport**
- Gemini only (`generativelanguage.googleapis.com`, the script's only `@connect`). Thinking is fixed at low.
- `GM.xmlHttpRequest`, which bypasses Genius' CSP and CORS.
- Use `responseType: "stream"` where available; otherwise parse `onprogress` `responseText` incrementally.
- Where neither is available (some iOS Userscripts builds), buffer the response and show `この環境では訳がまとめて届きます`. The slots then fill all at once.

**Storage**
- One record per song: `{songId, title, song, lines: {hash: {ja, notes}}, status, reason, model, date, lyricsHash, keyVersion}` (`keyVersion` lets a future change of normalisation re-key saved lines).
- Lines are keyed by the normalized-text hash, which is what makes S7 possible.
- LRU eviction beyond 300 songs. A partial song is never evicted.

## 9. Rendering, edge cases and resilience

**Rendering is a pure function of (DOM lines, record, UI state).**
- A MutationObserver watches the lyrics root (the parent of the containers) for `childList` and `characterData` in the subtree.
- It coalesces into at most one render pass per `requestAnimationFrame` and ignores mutations made by our own nodes.
- Each pass:
  1. Rebuild the line model.
  2. Make sure each lyric line has at most one `ll-line` node, right after its `<br>` (a line of sounds gets its `♪`; a Japanese line left as written and every line below the seam get none), and that the seam, when there is one, sits right after the last translated line.
  3. Remove orphans.
  4. Restore the open note.
  5. Rebuild the highlight ranges from stored offsets.
- Re-renders never send requests.

**Scroll compensation (no reliance on browser anchoring)**
1. Before each batch of inserts, record the first English line whose top edge is at or below the viewport top, and its `getBoundingClientRect().top`.
2. After the batch, call `scrollBy` with the difference.
3. This also applies to wraps that grow a slot, to notes opening or closing above the viewport, and to the retranslation swap.

**Clicks inside Genius `<a>`.** Native `click`, `pointerdown` and `mousedown` listeners on our own nodes call `stopPropagation()`. `click` also calls `preventDefault()`, except on our real external links (`Google AI Studioを開く`, `Google AI Studioでキーを作る`). React's root listener therefore never sees them, and the Genius panel never opens from our text. English text and highlight ranges are never our tap targets.

**Annotation click rewrites the URL.** The song identity is unchanged, so nothing happens. Genius' panel opens as usual.

**SPA navigation to another song.** On a new identity, tear down all our nodes, highlights and the sheet, then render the new song from cache or its entry state. An in-flight stream keeps writing to its own song's record and lock. Returning to that song shows S4, filled from storage.

**Two songs at once.** The global lock allows only one in-flight request. The other song shows S2b or the lock-held seam. **The same song in two tabs:** the second tab becomes S4m and follows via `GM_addValueChangeListener`, or by polling every 1.5 s while the tab is visible.

**Repeated choruses.** Each is translated once. Every occurrence fills at the same moment its first occurrence arrives, rendered in the quiet grey with no mark, and carries a quiet `※` if the original has notes. A line that differs by one word is a distinct line and gets normal ink.

**Very long songs.** Deduplication shrinks the output. If the model stops at its output-length limit, the request ends with the "long song" seam, and one tap continues. There are no client-side line caps.

**0 lines.** The S0 state: no UI at all.

**Lyrics edited on Genius.** S7. Lines that still match keep their translations; only the new hashes are requested.

**Browsers without the CSS Highlight API.** No yellow or underline on the English; notes keep the quoted phrase in their heading.

**Phone suspended or tab closed mid-stream.** The lines that arrived are already saved. On reopen the song shows S6 with `ここまで訳してあります`.

## 10. What we deliberately do not build

- **A guide panel, jump-to-line, or a floating progress or jump pill.** The two-line preface is the guide, and the page is the map.
- **Auto-translate on load, auto-resume on reconnect, background retries.** Every request is a tap made at that moment.
- **Quota counters or estimates, model names or "busy, switching" messages on the reading surface.** The model name appears only in settings.
- **Note-amount levels, uncertainty labels on lines, single-line re-analysis.** One strict note bar and `推測` on notes only.
- **A hard character budget.** Length guidance is soft, and tone wins.
- **Kind-coded colours, chips, or resting underlines on the English.** One ※, and one yellow for the words asked about.
- **Floating note popovers or tooltips, or notes that close on scroll.** Notes open inline, one at a time.
- **Tap-to-peek on English lines, or hit-testing of highlight ranges.** The English belongs to Genius.
- **Phrasebook, review cards, furigana, romanization, vocabulary lists, karaoke sync, a listening mode beyond `訳を隠す`.** It is a comprehension tool, not a study app.
- **Translating Genius annotations, or clicking Genius links from our UI.** Their text is shown in English, collapsed, inside our note.
- **Translated section headers, or a colophon or finish toast.** A page with no empty slots is finished.
- **Mincho type, web fonts, or a font-size control.**

## Appendix: how this spec was made, and engineering amendments

This specification was synthesized from five independent first-principles concepts (close reader, listener, learner, calm technology, bold reinvention) plus one earlier draft ("translator's red pen"), scored by three judges (reader value, feasibility, design coherence). The calm "ruled paper" concept won (24.5) narrowly over the "bilingual edition" concept (24.0); grafts came from the listener, learner and bold concepts. That synthesis fixed the structure (one line of Japanese under each English line, notes, seams, one tap per request); its visual direction (ruled paper, a red pen) has since been replaced, see amendment 44 and §6.

Amendments made during implementation:

1. **Head row placement.** Inserted *inside* the first `[data-lyrics-container]`, right after Genius' own lyrics header (`[data-exclude-from-selection]`), not as the container's previous sibling. On desktop the containers' parent is a CSS grid; an extra sibling would be auto-placed into the wrong grid cell. Insertion inside the container was verified on live Genius pages to survive re-renders and annotation clicks.
2. **Line keys.** Lines are keyed by the normalized text itself (lowercased, quotes straightened, trailing punctuation dropped) rather than a hash; same effect, easier to debug.
3. **Head echo tolerance.** `head` must match at least two of the first three normalized words (`-in'`/`-ing` treated alike); a missing `head` is accepted.
4. **Persisted progress carries `stop: closed`** while a request is in flight, so a tab that dies mid-stream leaves a resumable song (S6 "ここまで訳してあります") instead of one that looks finished or "lyrics changed" (S7).
5. **A first request that produced no lines** shows its reason in the head row (with the seam's button rule) instead of drawing a seam at line 1.
6. **Retranslation lands when it mostly succeeds.** If a retranslation is cut ('length') or skips lines ('gaps'), the missing lines keep their previous translation and the new edition is swapped in; only a failure with nothing usable keeps the old edition (S8f). A retranslation that cannot start (quota, another song running) says so in the head row: `訳し直せませんでした。今の訳はそのまま残っています` + reason. The settings sheet hides 「この曲」 while a request is writing this song.
7. **Zero-line failures are not stored** (except an invalid key, which explains why 日本語で読む needs a new key). Reopening such a song shows plain S2.
8. **The seam sits at the writing frontier** (the first missing line after the last filled one); missing lines before it are lines the model skipped and read as `—` (`――` since 44).
9. **The preface is text, not a button.** Only a small ▸/▾ toggle (44 px hit area) opens and closes 「この曲は」; the text stays readable, selectable and announced. (The labels and the ▸/▾ toggle were replaced in 44 by the underlined `続きを読む ▾`; the text is still never a button.)
10. **Reported errors favour what is transient.** If any model was merely busy, the reader is told it was busy, not that today's quota is gone.
11. **Thinking level is low** (later fixed, not configurable). Measured on the same song and model: first line 65 s (medium) vs 3–16 s (low) at comparable quality.
12. **Genius annotations are fetched at idle when the song opens**, not after the tap (same-origin, free, not an LLM request). 日本語で読む is never held back by them, and an opened note does not grow when they arrive. Concurrent fetches for one song share a single request; a failed fetch is not cached.
13. **The state machine is a pure function** (`src/ui/state.ts`, `decide()`), tested state by state and sentence by sentence; the controller only gathers its input and binds its action ids.
14. **Reading a saved edition counts as use.** Storage eviction (LRU) orders by last read, not by translation time, and never evicts a partly translated song before finished ones.
15. **Saved editions travel between devices** by export and import under 保存データ (see §7).
16. **(Superseded by 26.)** A free service the reader had not set up was offered at the moment it would help (`キーを足す`, a Groq/OpenRouter hint on a safety block).
17. **Pending lines are flushed when the tab is hidden or closed**, so a backgrounded phone tab keeps what already arrived.
18. **Translation post-processing.** Half-width `(…)` become `（…）`; a note's phrase quoted in pieces (`a / b`, `a … b`) is widened to the line's own span so the underline can find it; a slang or idiom note whose first sentence only defines a meaning the translation already says is trimmed or dropped (when the translation kept the word itself, the definition stays: it is what the reader needs).
19. **The fallback chain keeps its cooldown table honest.** A model that succeeds is un-benched; one that breaks mid-stream (503, 429) is benched. When every model is cooling down, the reader is told the real wait: a per-minute limit is not reported as today's quota.

20. **Japanese songs are left alone** (SJ): translating Japanese into Japanese would spend a request for nothing.
21. **A storage failure never erases what is on screen.** The edition is shown first and saved second; a failed save says so (S8f) and keeps the edition until the page closes. A failed lock release or a stale page during client-side navigation can no longer leave the tab stuck or write one song's lines under another's id.
22. **A failed Genius annotation fetch is retried** on the next tap instead of being remembered as "no annotations".
23. **Sound-only ad-libs stay sounds:** they are never given an invented meaning (the katakana rendering chosen here, エイ, アー, スカー, is superseded by 45). The preface is held to one plain sentence for 誰が誰に (≤40 characters, no bracketed asides) and what the lyrics support for この曲は (≤80 characters); the song-wide note ceiling is enforced in code (wordplay and ambiguity may use two extra slots).
24. **Accessibility.** The head row's status is one persistent polite live region updated in place (so streaming does not re-announce it); gap and repeat marks are labelled images (44 dropped the repeat mark; 47 adds the `♪`); buttons dim while pressed on touch, and hover styles apply only where hover exists.
25. **Automatically chosen Gemini models adapt to how they have behaved** (`ll3:health`, per key and model, entries older than 14 days dropped): a model that answered within the week and has not failed since goes first, fastest first-text time first; unknown models keep their rank order after those; a model that was busy or silent in the last half hour goes last. Flash always stays ahead of Flash-Lite and Gemma. A model silent for 30 s is given up on, benched for five minutes like a busy one (but skipped, not tried last), and the next model starts at once.

26. **Gemini only.** Groq, OpenRouter and every other provider are removed, along with `キーを足す`, the spare-key text and the settings focus for it; `@connect` is generativelanguage.googleapis.com alone; settings keep one key row, older stored shapes are migrated, and other services' cached lists, cooldowns and health are cleaned at start.
27. **A 200 response with no accepted line is a failure** (`unusable`, 10 min cooldown, next model), so a model that only yields broken output gains no health.
28. **Candidate slots are reserved per tier** (Flash 6, Flash-Lite 3, Gemma 1), shared by the request and the availability check, so exhausted Flash quota no longer hides Flash-Lite.
29. **Two silent models in a row end the call** (stop reason silent); during an outage the reader is not kept waiting minutes.
30. **Error classes have their own copy and cooldowns:** `rejected`, `no-model`, `empty` and `unusable` read differently; a rejected request benches that model for 6 h; the safety-filter sentence is Gemini-only.
31. **LLM errors are recorded:** logged per failed model (API key scrubbed), the last one stored on the song's stop and shown under 「直近のエラー」; a run with misaligned records warns once with the count.
32. **A line starting with a parenthesis passes the head check** if the head matches the line with its leading parenthesised groups removed.
33. **Kana-less CJK lyrics are not Japanese** (SJ also needs ≥30% of lines with kana).
34. **The note ceiling is per song** (whole-song line count minus notes already stored); the 2 bonus slots are once per song.
35. **`FALLBACK_GEMINI` was refreshed** to existing ids, and the model list is cached 7 days with the stale list preferred over the built-in one.
36. **Records carry `keyVersion`** (current 1; `migrateRecord` is the entry point for a future re-keying).
37. **公認 marks `verified` or `accepted` annotations;** a retranslation that carried old lines over keeps the new motifs and records `carried: n` on the record (no UI).
38. **Flash has a 20 s time budget for its first line** (measured live: Flash flaps, 503s and 30 s silences, while Flash-Lite answers its first line in about 1.5 s). The budget runs from the start of the call; each Flash attempt's first-text timeout is the remaining budget (never above 30 s), and no Flash attempt starts with less than 8 s left. It applies only while a Flash-Lite candidate is queued behind to take over (Gemma is slower than a slow Flash), never to a pinned model, and not once any Flash text has arrived. A budget timeout benches the model for 5 min like any silence but is not one of the two silent models that end a call. A call that left Flash for lack of time stores `flashDegradedUntil` = now + 10 min (`ll3:flashdegraded`, per key); until then the order is Flash-Lite, Flash, Gemma, and the next successful Flash answer clears it. `availability()` is unaffected.

39. **Silence is not a lost connection.** Two silent models end the call with stop reason `silent` (「AIから返事がなく…」, button enabled); a wait longer than 90 s (rate or an unusable bench) is shown as `{when}ごろから`, and the button stays disabled until then. A key check that fails on Google's side says 「Googleが混み合っていて、確かめられませんでした…」, not "check your connection". An inline per-minute wait the Flash budget cannot use is skipped, and the reported reason follows each model's latest error.
40. **A line record that is not valid JSON is repaired or salvaged** (stray quotes escaped; else id/head/ja kept without notes); records that still cannot be read are counted (`dropped`) into the stop's detail and the log. Measured: a 59-line song that ended with gaps now completes in one request.
41. **Insults and address terms keep their strength** (no softening to neutral words, no age added for lil'), distinct English words keep distinct renderings, and the motif rendering is reused in every repeat.

42. **(Superseded by 44.)** **Design pass with real screenshots** (headless Chrome at 1280 px and 390 px, real Gemini translations): the next step became a hairline pill instead of bare red text, the head's actions sit right after the status, the seam button matches it, and the settings popover opens under 設定 instead of over the lyrics at the page edge.

43. **(Superseded by 44.)** **Apple-like redesign** (after the reader asked for that direction): the head became one soft card, the next step a tinted capsule, empty slots soft placeholder bars with a shimmer, the seam a callout card, notes rounded cards, and the settings sheet a translucent grouped list with filled and tinted buttons, red destructive actions and a phone grabber. Checked with real-size screenshots on desktop and phone.

44. **Design v4: 「聴きながら、わかる。」** The visual system was rebuilt from the reader's situation (reading along with a song) and from Genius' own grammar instead of from a style, replacing 42, 43 and the interim 対訳 booklet pass (明朝, 金赤 ink, a vertical edition mark). The head is one row in Genius' info-row grammar (an `あ` icon, a bold underlined action or a status sentence, underlined links, a 2 px track that exists only while there is progress and fills in black, captions underneath, a settled `AIによる日本語訳` row once done); the preface lost its labels (the prompt asks for 「AからBへ」, then a paragraph indented one character, `続きを読む ▾` when collapsed); unwritten lines are reserved blank slots with one breathing pen, written lines are plain ink with no fade, gaps are `――`, repeats are quiet grey without `↺`; notes are unboxed and set 2em in with `〔kind〕` and `〔推測〕`, and the phrase in the lyric, the open `※` and the note's heading turn the marker yellow together; the seam is a black line across the column; the sheets are square, with a title rule, underlined links, one black button and statuses in words; no web fonts, no red, no accent colour. Review fixes: the links own fixed slots (`止める` · `訳を隠す` · `設定`) that never move, an absent one held as an invisible placeholder; the pen no longer grows its line; the seam is its own node right after the last translated line, with nothing drawn below it (translated repeats included); the settings panel hangs from the right edge of `設定`; the sheet names models as a reader says them (`modelLabel`), has a privacy note and no hand-typed spaces between Japanese and Latin letters, and 保存データ reads status, actions, explanation, message; Japanese is drawn in our stack, because Genius' lyric font list reaches us as Latin only (generic families dropped); `訳を隠す` is remembered per song and hides the preface with the translation.

45. **Sounds are not translated** (after the reader found ウー for Woah and オー for Oh off-putting, without wanting a free translation either). A line made only of sounds gets no Japanese row at all (§2; superseded by 47, a quiet `♪`), and an older edition's row for it is no longer drawn. The list in `core/sounds.ts` holds non-words only: a question (`Huh?`), a pair that means something (`uh-oh`, `uh-uh`), `who`, and a lone or fused scat syllable (`La` = LA, `Nana`) are lines like any other. Inside a line, the prompt keeps a sound in its own spelling, the same number of times, in its place (`Ayy、マジでイカれてる、ayy`, `（Yeah、待てよ）`), never as katakana and never as a word; sound effects (`brr`, `bop`) likewise. An interjection or a call that means something is translated by that meaning (`Whoa, slow down` → `待て待て、落ち着け`, `hold up` → `待てよ`, `Nah` → `いや`). On the page the Japanese row carries the meaning and the sounds are left to the English line above, as 字幕 does: a trailing `( )` group made only of sounds is not drawn (older editions' `（イェー、イェー）` disappear with it), a sound the model kept between the phrases of a row is taken out with the separator it leaves (`Ayy、マジでイカれてる、ayy` → `マジでイカれてる`; one inside 「」, touching kana or asked as a question, `Huh？`, is a word and stays), and a row that only repeats its English line (`Hey, hey` left as written, a Japanese line in an English song) or holds nothing but sounds is not drawn (a `♪` since 47, unless the line is Japanese). This is done on the page because Flash cannot hold the count: on HUMBLE one run added a leading Ayy to 5 rows, the next dropped them from 7 of 8. Measured with gemini-3.5-flash on God's Plan, HUMBLE, No Role Modelz and Kill Bill: no katakana sound in any row, 4 of God's Plan's 50 lines are lines of sounds.
46. **Copy review: one fact, one phrase.** Three independent reviews of every visible string (reading surface, sheets and docs, consistency and typography). The spent daily quota reads `今日の無料枠を使い切りました` everywhere, with `{when}から` (the reset is exact; `ごろ` is kept for estimated waits); every retry says `もう一度試せます` (never `どうぞ`, never a fragment); a rejected request is `AIへの依頼が通らず` (not `訳しませんでした`, which reads as a refusal); waits name `訳し終える`, not a bare `終わる` that reads as the song ending; `いま` with a past tense is gone; a note drawn from Genius says `Geniusの注釈を参考にしました` (`より` would read as a quotation); kinds are `〔言葉遊び〕` and `〔元ネタ〕`; votes read `{n}票`; times have no leading zero; the reading surface gets `text-autospace` like the sheet; diagnostics name models as a reader says them and drop sentence-final `。`; the README stops pointing at a button that no longer exists. The translation prompt also lost habits a Japanese editor would fix: meaningful English left as katakana (`ホールドアップ` reads as a stick-up, `シスター` as nuns), nigga locked to one motif (`ダチ` for people the speaker despises), `bitch` aimed at men turned into a woman's word, the placeholder `this shit` as the noun `クソ`, and `〜かしら`/`〜のよ` for a contemporary woman.
47. **A line of sounds shows `♪`** (after the reader found that 45's empty rows read as a translation error). On a page where every other line has Japanese under it, a line with nothing under it looks skipped, and it looked exactly like the plain English below the seam, which means not yet translated. Its node is now a quiet `♪` in the Japanese face, a labelled image like `――`, announced as `声だけの行` (§2, §6). So is a row that has nothing left once its sounds go, or that only repeats its English line, which is the model leaving a sound the list does not hold (`Grrah`, `Bop`), since the prompt leaves nothing else as written; a Japanese line in an English song still gets no row. The reader chose it from four treatments drawn with the real styles on God's Plan: nothing (45); `♪`; the sound in its own spelling in `quiet`, which says the line twice and puts sounds back into the Japanese row; and `（声）`, which reads as a stage direction and does not fit Skrrt. The prompt and the request are unchanged.

Each of these came out of many rounds of multi-lens review with adversarial verification, all fixed and covered by the unit tests.
