# Lyric Lens: Final Design Specification

## 1. Thesis and principles

**Thesis.** Lyric Lens works like furigana, but for meaning. The Genius page becomes a bilingual edition on ruled paper: a quiet second line of Japanese sits under every lyric, the translator's red-pen ※ marks the few places where something is hidden, and a two-line preface says who is speaking to whom. The reader came to read a song, not to operate a tool, so the page itself is the interface.

**Principles**
1. **Ink, not interface.** Nearly everything we add is text in the lyric column. Controls appear only when the reader has a real decision to make.
2. **One tap, one request.** A request goes out only from a tap made at that moment. Page loads, re-renders, navigation, annotation clicks, reconnects and retries never send one. There is no auto-translate setting.
3. **Partial is a valid state.** Each line is saved the moment it parses. A half-translated song is a page that is still being written, and missing lines are visible as empty slots.
4. **Genius keeps its layer.** Genius owns the yellow and grey backgrounds, the English tap targets, the annotation panel and the sidebar. We use one vermilion ink, underlines and the ※ sign, and we never wrap Genius' text nodes or capture its clicks.
5. **Silence over explanation.** A note exists only where the Japanese alone would mislead or lose something. A song with zero notes is fine.
6. **Progress is the page filling in.** There are no spinners, percentages, timers or quota meters. Quota is mentioned only when it blocks something, and always with a recovery time in JST.
7. **Consistency comes from the data.** Repeats are deduplicated on the client, so a chorus is translated once and renders the same everywhere.

## 2. Information architecture

All of our CSS lives in one injected `<style id="ll-style">`. Every class uses the `ll-` prefix, and every inline node has `lang="ja"` and `overflow-anchor: none`.

| # | Element | Insertion point | Desktop | Phone (<600 px) |
|---|---|---|---|---|
| 1 | **Head row** `div.ll-head` | Previous sibling of the first `[data-lyrics-container]`, outside the container. Re-inserted by the observer if it is removed. | One row. Status or entry text on the left; `止める` / `訳を隠す` / `設定` as text buttons on the right. The preface sits below in the same block. | Status text full width; controls on their own right-aligned row. Every target is at least 44 px tall. |
| 2 | **Preface** `div.ll-preface` (inside the head row) | — | Two lines: `誰が誰に` and `この曲は`. On a return visit it collapses to the first line plus `▸`. | Same. |
| 3 | **Line node** `span.ll-line[data-ll-key]` (display:block) | Directly after the `<br>` that ends each translatable English line. For the last line of a container, which has no `<br>`, it is appended as the container's last child. It may end up inside a Genius `<a>`. | One node whose state is `empty`, `next`, `filled`, `gap` or `seam`. | Same. |
| 4 | **Mark** `button.ll-mark` | Inside the line node, after the Japanese text. | `※`, with a 44×44 hit area. | Same. |
| 5 | **Note** `div.ll-note` | Immediately after its line node, as a sibling. At most one exists at a time. | Inline, full column width. | Inline. |
| 6 | **Seam** (state of a line node) | The first empty slot after an interruption. | One calm sentence plus a button. | Same; the button is full width. |
| 7 | **Phrase highlights** | `CSS.highlights`: `ll-phrase` (note open) and `ll-phrase-peek` (desktop hover on ※). No DOM change. | — | `ll-phrase` only. |
| 8 | **Sheet** (settings / first run) | A shadow-DOM host appended to `document.body`, position fixed. | A 400 px panel anchored under `設定` that flips upward if there is no room. Max height 70vh, scrolls internally. | A bottom sheet, max height 85vh, with `env(safe-area-inset-bottom)` padding and a backdrop of `rgba(0,0,0,.32)`. |
| 9 | Userscript menu | `GM_registerMenuCommand("Lyric Lens の設定")` | — | — |

Section headers (`[Chorus]`) and blank lines get no line node. There are no floating pills, rings, buttons or toasts.

**Line model.** Walk the text nodes of each container in order, splitting at each `<br>` across nested `<a>` and `<span>` elements. Each line becomes `{index, text, norm, hash, occurrence}`, where `norm` is the text lowercased, with curly quotes and apostrophes straightened, punctuation stripped and whitespace collapsed. Lines with the same `norm` are **exact repeats**. A single changed word makes a line distinct.

## 3. State model

The song identity is the numeric Genius song ID read from the page's song data. The fallback is the path segment ending in `-lyrics`, with any annotation prefix or suffix stripped. When Genius rewrites the URL after an annotation click, the identity does not change, so nothing is torn down.

| State | Head row shows | Line nodes | The reader can |
|---|---|---|---|
| **S0 No lyrics** (no containers, or 0 translatable lines) | Nothing. Lyric Lens is invisible. | — | — |
| **SJ Japanese lyrics** (≥60% of lines are kana/kanji with almost no Latin letters, **and** ≥30% of lines contain kana, so kana-less Chinese lyrics stay translatable; nothing is stored) | `この曲は日本語の歌詞です` (label colour) | None | Nothing: no request is offered or sent. A song with a stored edition is shown as usual. |
| **S1 No API key** | `日本語訳には無料のAPIキーが必要です` + `キーを設定` | None | Open the first-run sheet |
| **S2 Never read** | `日本語で読む` (primary) · `設定` | None | Start the request |
| **S2q Quota known exhausted** (every candidate model is in a quota cooldown, see §8) | `今日の無料枠は終わりました。{when}から訳せます` (label colour) · `設定` | None | Nothing is sent. At reset the button becomes `日本語で読む` again. |
| **S2f First request failed** (a stop is recorded and no line arrived) | The reason in a head-row sentence that points at nothing on the page (no `ここ`, no `続き`, see §4) · `日本語で読む` with the seam's button rule · `設定` (an invalid key shows only `設定を開く`) | None | Retry by tapping. A stop that no longer applies (quota reset, key fixed) reads as plain S2. |
| **S2b Another song translating** (global lock held) | `別の曲（{title}）を訳しています · 終わると訳せます` · `あちらを止める` | None or the existing ones | Stop the other job. The button re-enables itself when the lock is released; no request is sent until the reader taps. |
| **S3 Waiting** (before the preface) | `曲全体を読んでいます` · `止める` | An empty slot under every line; the first slot breathes | Scroll, listen, use Genius, stop |
| **S4 Arriving** | The preface · `止める` · `設定` | Slots fill in order. The first empty slot breathes. Repeats fill together with their first occurrence. | Read, open notes, stop, hide |
| **S4m Mirrored** (the same song is running in another tab) | `別のタブで訳しています` · `止める` | Filled live from storage | Read, stop (this sets an abort flag the owner tab obeys) |
| **S5 Complete** | The preface (collapsed on a return visit) · `訳を隠す` · `設定` | All filled. No animation on a return visit. | Read, open notes, hide, open settings |
| **S5g Complete with gaps** (some lines failed to parse or align) | The preface · `{n}行が訳せていません` · `抜けた行を訳す` | Gap slots show a quiet `—` | Request only the gaps (one tap = one request) |
| **S6 Interrupted (reason)** | The preface if it arrived · `途中まで訳してあります（{done}/{total}行）` · the seam's button | Filled lines stay. The **seam** sits at the writing frontier: the first missing line after the last filled one (earlier holes are gaps, `—`). The slots below stay dotted. With `訳を隠す` on, the seam is hidden with the translation, so the head row repeats its sentence whenever the button cannot simply be pressed (disabled, `設定を開く`). | Resume (subject to the reason's rule), hide, settings |
| **S7 Lyrics changed since** (some stored line hashes no longer match the DOM) | `歌詞が更新され、まだ訳していない行が{n}行あります` · `新しい行を訳す` | Matching lines keep their translations; new lines show empty slots | Translate the new lines only |
| **S8 Retranslating** | `訳し直しています · 終わるまで今の訳を表示します` · `止める` | The old edition stays. The new one is buffered out of sight and swapped in all at once when it completes. | Read the old edition, stop |
| **S8f Retranslation failed** | `訳し直しは途中で止まりました。今の訳はそのままです` + the reason sentence | Old edition intact; the new partial is discarded | Dismiss by any interaction |

**The seam reasons (S6) and their buttons**

| Reason | Seam sentence | Button rule |
|---|---|---|
| busy (all fallbacks gave 503) | `AIが混み合っていて、ここで途切れました。少しおいてから続きを訳せます` | `続きを訳す`, enabled |
| per-minute limit | `AIの回数制限にかかりました。1分ほどおいてから続きを訳せます` | Disabled until the limit's reset (about 60 s), then enabled. It does not fire on its own. |
| daily quota | `今日の無料枠が終わりました。{when}ごろから続きを訳せます` | Disabled until reset, then enabled. It does not fire on its own. |
| invalid key | `APIキーが使えなくなりました。設定でキーを入れ直してください` | `設定を開く` (the head row then drops its own `設定`). The stop stops applying as soon as a configured key is believed to work, whichever page fixed it. |
| safety filter | `この先はAIの安全フィルタで止められました。もう一度試すと通ることがあります` | `続きを訳す` |
| request rejected (400s) | `AIがこの先を訳しませんでした。もう一度試すと通ることがあります` | `続きを訳す`, enabled |
| no usable model | `AIをいま使えません。少しおいてから続きを訳せます` | `続きを訳す`, enabled |
| empty answer | `AIの返事が空のまま、ここで途切れました。もう一度試せます` | `続きを訳す`, enabled |
| network | `接続が切れました。つながったら続きを訳せます` | Disabled while `navigator.onLine` is false, enabled when the connection returns. Never fires automatically. |
| unusable output | `AIの返事をうまく読み取れず、ここで途切れました。もう一度試せます` | `続きを訳す` |
| reader stopped | `ここで止めました` | `続きを訳す` |
| output-length cut (long song) | `長い曲なので、ここで一度区切りました` | `続きを訳す` |
| tab closed or suspended (partial record found, no live lock), or a stop that no longer applies | `ここまで訳してあります` | `続きを訳す` |
| another song holds the lock, or today's quota is known spent | The reason's first sentence, plus `別の曲を訳し終えると続きを訳せます` / `今日の無料枠は終わりました。{when}から訳せます` | Disabled until the blocker clears |

The seam is written in the label colour after a short dashed slot, so it reads as a margin note, not as the translation of the lyric above it.

`{when}` is the next Pacific midnight, computed with `Intl` in `America/Los_Angeles` and formatted in `Asia/Tokyo` as `HH:MM`. It reads `16:00` or `17:00`, with the prefix `明日` when the reset falls on the next JST date.

**Request guards.** A button locks the moment it is pressed. There is one global lock in GM storage, `{songId, tabId, heartbeat}`, with a heartbeat every 2 s; a lock older than 10 s is stale. Before every request the client checks the exhausted registry. Nothing restarts on reload.

## 4. Japanese UI copy (verbatim, complete)

**Head row**
- `日本語訳には無料のAPIキーが必要です` · `キーを設定`
- `日本語で読む`
- `今日の無料枠は終わりました。{when}から訳せます`
- First request failed (S2f), by reason:
  - busy: `AIが混み合っていて、訳し始められませんでした。少しおいてからもう一度どうぞ`
  - rate: `AIの回数制限にかかりました。1分ほどおいてから訳せます`
  - quota: `今日の無料枠が終わりました。{when}ごろから訳せます`
  - auth: `APIキーが使えなくなりました。設定でキーを入れ直してください` · `設定を開く`
  - blocked: `この曲はAIの安全フィルタで止められました。もう一度試すと通ることがあります`
  - rejected: `AIがこの曲を訳しませんでした。もう一度試すと通ることがあります`
  - no-model: `AIをいま使えません。少しおいてからもう一度どうぞ`
  - empty: `AIから空の返事が返ってきました。もう一度試せます`
  - network: `接続が切れて、訳し始められませんでした。つながったら訳せます`
  - unusable: `AIの返事をうまく読み取れませんでした。もう一度試せます`
  - length: `長い曲なので、一度では訳し切れませんでした`
- `別の曲（{title}）を訳しています · 終わると訳せます` · `あちらを止める`
- `曲全体を読んでいます`
- `別のタブで訳しています`
- `この環境では訳がまとめて届きます` (buffered fallback only; small label colour)
- `止める` · `訳を隠す` / `訳を表示` · `設定`
- `途中まで訳してあります（{done}/{total}行）` · `続きを訳す`
- `{n}行が訳せていません` · `抜けた行を訳す`
- `歌詞が更新され、まだ訳していない行が{n}行あります` · `新しい行を訳す`
- `訳し直しています · 終わるまで今の訳を表示します`
- `この曲は日本語の歌詞です` (SJ)
- `保存できませんでした` with `この画面では読めますが、ページを閉じると消えます` (the edition could not be stored; it stays on screen and is not replaced by a same-song refresh)
- `訳し直しは途中で止まりました。今の訳はそのままです`, with the reason on a second line: `混み合っていました。少しおいてから試せます` · `AIの回数制限にかかりました。1分ほどおいてから試せます` · `今日の無料枠が終わりました（{when}に戻ります）` · `APIキーが使えなくなりました。設定でキーを入れ直してください` · `AIの安全フィルタで止められました` · `AIが訳しませんでした` · `AIをいま使えませんでした` · `AIの返事が空でした` · `接続が切れました` · `AIの返事をうまく読み取れませんでした` · `止めました` · `長い曲なので、一度では訳し切れませんでした` · `返事が途中で途切れました` · `訳せない行が残りました`

**Preface**
- Labels: `誰が誰に` / `この曲は`; the content comes from the model.
- Toggle aria-labels: `この曲についてを開く` / `この曲についてを閉じる`

**Seams:** see the table in section 3.

**Notes**
- Kind labels: `スラング` · `掛詞` · `引用・元ネタ` · `慣用句` · `二通りに読める`
- Conjecture tag: `推測`
- Grounding: `Genius注釈より`
- Disclosure: `Geniusの注釈（英語）▲{votes}` · expanded `たたむ` · truncated text `続きを読む`
- Mark aria-label: `注：{kind}「{phrase}」` (with several notes: `注 {n}件`)

**First-run sheet**
- Title: `日本語訳をはじめる`
- Step 1: `Google AI Studio を開き、Googleアカウントでログインして無料のAPIキーを作ります` + link `Google AI Studio を開く`
- Step 2: `キーをコピーして、下に貼り付けます`
- Placeholder: `APIキーを貼り付け`
- Note: `キーはこのブラウザのユーザースクリプト保存領域にだけ置かれ、Google 以外には送られません`
- Primary: `保存してこの曲を訳す` · secondary: `保存だけする`
- While checking: `確かめています…`
- Bad key: `このキーは使えませんでした。コピーし直してください`
- Network: `確かめられませんでした。接続を確認してください`

**Settings sheet**
- Title: `Lyric Lens の設定` · `閉じる`
- Section: `翻訳に使うAI`
- Row: `Google AI Studio（Gemini）`, with a key field, `キーを作る`, `保存`, `キーを消す` (`キーを入れ直す` while the key is rejected; the new field is then focused)
- Row status: `使えます` · `未設定` · `今日は{when}まで休み` · `キーが使えません` · `確かめています…`
- Section: `この曲`
  - `この曲の訳：{model} · {YYYY}年{M}月{D}日`
  - `直近のエラー` (a collapsed disclosure, shown only when the song's stop carries detail): `{model} · {status} · {kind}` and the error text (at most 200 characters, selectable, small, label colour)
  - `この曲を訳し直す` → confirm `この曲を訳し直しますか？無料枠を1回使います。終わるまで今の訳はそのまま表示されます` · `訳し直す` · `やめる`
  - `この曲の保存データを消す` → confirm `この曲の保存した訳を消しますか？` · `消す` · `やめる`
- Section: `保存データ`
  - `保存した曲：{n}曲 · {size}`
  - Lead: `書き出したファイルは、別の端末でも読み込めます`
  - `書き出す` → `{n}曲を書き出しました` / `書き出せませんでした`
  - `読み込む` → `{n}曲を読み込みました` / `新しく読み込める曲はありませんでした` / `読み込めませんでした。Lyric Lens で書き出したファイルを選んでください`
  - `すべて消す` → confirm `保存したすべての曲（{n}曲）を消しますか？途中まで訳した曲も消えます` · `消す` · `やめる`

## 5. Notes

**Content contract.** A note is attached to the **first occurrence** of a line. It quotes an exact phrase from that line, has one of the five kinds, a Japanese explanation of at most 2 sentences and about 80 characters, an optional conjecture flag, and an optional `g` (the id of the Genius annotation it drew on). Typical density is no more than one note per 6 lines, and zero is fine. The ceiling is per song, not per request: `max(2, round(unique lines / 6))` from the whole song, minus the notes the record already holds, so a short resume never gets a denser budget. The 2 extra wordplay/ambiguity slots are used once per song.

**Resting state.** A noted line ends with a vermilion `※` after its Japanese text. There is one mark per line however many notes the line has. Nothing is marked on the English at rest; this is deliberate, to keep the page clean. Exact repeats of a noted line carry the `※` in the label colour, and it opens the same note in place.

**Hover (desktop, pointer:fine only).** Hovering over `※` paints `ll-phrase-peek` under the English phrase, so the eye links the mark to its words. Nothing depends on hover.

**Opening.** Tap or click `※`, or focus it and press Enter or Space. This happens in one frame:
1. Any other open note closes.
2. `div.ll-note` is inserted after the line node.
3. `ll-phrase` underlines the English phrase.
4. `aria-expanded="true"` is set.

**Layout**
- 2 px vermilion left border, note-background fill, padding 8 px × 12 px, margin 4 px 0 14 px.
- For each note:
  - Row 1: the kind label (11 px, accent, weight 600), then an outlined `推測` tag if flagged.
  - Row 2: the quoted English phrase in Genius' inherited font, italic, 0.78em, wrapped in “ ”. It is always shown, so nothing is lost if the Highlight API or the phrase match fails.
  - Row 3: the explanation.
  - Multiple notes are separated by 10 px.
- When `g` matches a fetched Genius annotation, a last row shows `Genius注釈より`. When a fetched annotation's fragment overlaps the quoted phrase (with or without `g`), a collapsed disclosure `Geniusの注釈（英語）▲{votes}` appears. Expanded, it shows the plain annotation text, cut at 400 characters with `続きを読む`. Only the single highest-voted overlapping annotation is shown.

**Closing.** Tap `※` again, press Esc (while focus is on the mark or inside the note; focus returns to `※`), or open another note. Notes never close on scroll. When a note above the viewport closes, the scroll position is compensated.

**Keyboard.** Every `※`, disclosure and control is a real `<button>`, reached with Tab in document order. Focus ring: 2 px accent outline, offset 2 px. There are no global shortcuts.

**Phrase matching.** The note's phrase and the line text are normalized the same way (case, straightened quotes, apostrophes, ellipses, whitespace), and a character-offset index is built over the line's text nodes. If no exact normalized match is found, try matching with dropped-g endings (in'/ing), then give up: there is no underline, but the note still works. Ranges are stored as (line key, start, end) and rebuilt after every observer pass.

**Without the Highlight API.** Feature-detect `CSS.highlights`. If it is missing, there are no underlines and everything else stays the same.

## 6. Visual system

**Tokens** (on `:root`, prefix `--ll-`)

| Token | Light | Dark |
|---|---|---|
| `ink` (Japanese) | `#4A5260` (7.9:1) | `#B8C0CB` |
| `ink-repeat` | `#6B7380` (4.8:1) | `#8E96A2` |
| `accent` (朱) | `#B0503A` | `#E3876C` |
| `label` | `#6E7581` | `#9AA1AC` |
| `note-bg` | `#F7F3EE` | `#23262B` |
| `rule` (hairlines: preface edge, note dividers) | `#D9DCE1` | `#3A3F46` |
| `slot` (empty-slot dashes) | `#A7ADB6` | `#5A616B` |
| `hl-bg` | `rgba(176,80,58,.08)` | `rgba(227,135,108,.14)` |
| `sheet-bg` / `sheet-ink` | `#FFFFFF` / `#1A1C20` | `#1C1E22` / `#E6E8EB` |

**Dark detection.** Walk up from the first lyrics container to the first non-transparent computed `background-color`. If its relative luminance is below 0.4, set `data-ll-theme="dark"` on our nodes. The head row is tested from its own parent, because some song pages have dark headers. The sheet follows `prefers-color-scheme` unless the page itself was detected as dark. Re-check on navigation.

**Type**
- Font stack: `"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Noto Sans CJK JP","Yu Gothic UI","Meiryo",system-ui,sans-serif`. Gothic only, no mincho, no web fonts.
- Japanese line: `0.84em` of Genius' 18 px (≈15 px). On phones, where Genius uses 16 px, `0.875em` (14 px). Line-height 1.6, weight 400.
- Preface: 0.78em; the `誰が誰に` line uses weight 600 and the labels use the label colour.
- Note body: 0.78em, line-height 1.7. Kind label: 11 px, letter-spacing .04em.
- Head row: 14 px; buttons in the accent colour, weight 600.

**Japanese typesetting** (on every `ll-` node)
- `line-break: strict;`
- `word-break: auto-phrase;` with a `normal` fallback
- `overflow-wrap: anywhere;`
- `font-feature-settings: "palt" 1;`
- `letter-spacing: .02em;`
- `text-spacing-trim: trim-start;` where supported
- `hanging-punctuation: none;`

**Spacing.** A line node has padding `2px 0 12px` (10 px bottom on phones) and starts at the English left edge with no indent. Repeats use `ink-repeat` plus a trailing ` ↺` in the label colour, only for exact normalized repeats.

**Slot.** Height `1.6em` of the Japanese size (one line). A dashed 1 px rule (2 px dash, 6 px period) in the `slot` colour spans `min(60%, 320px)` at the baseline. The next slot (the one being written) is drawn in the accent colour and breathes. It grows only if the translation wraps.

**Ad-libs.** When the English line's parentheses are all at its end, the matching trailing `（…）` groups of the translation are set in the label colour, so the eye lands on the line itself.

**Link resets.** All `ll-` nodes get `background: transparent !important; color: var(--ll-ink) !important; text-decoration: none !important; cursor: auto; font-style: normal;`.

**Highlights**
- `::highlight(ll-phrase)`: `text-decoration: underline 1.5px var(--ll-accent); text-underline-offset: 3px; background-color: var(--ll-hl-bg);`
- `ll-phrase-peek`: the same underline with no background.

**Motion**
- Ink fade: opacity 0 → 1 over 200 ms ease-out, opacity only.
- Breathing: only the next slot, opacity .35 ↔ .7 over 2.4 s.
- Note open: 160 ms height, using a `grid-template-rows: 0fr → 1fr` animation, only when the reader opened it (a re-render that keeps a note open never replays it).
- Sheet: 180 ms fade, with a 12 px rise for the phone sheet.
- `prefers-reduced-motion: reduce`: everything is instant, and breathing becomes a static .6.
- A cached render has no motion at all.

## 7. Settings

**Where it opens:** `設定` in the head row, the userscript menu, and `設定を開く` on a key-error seam.

**First run (S1).** Tapping `キーを設定` opens the first-run sheet. The key is checked with Gemini's model-list endpoint, never a generation call.
- `保存してこの曲を訳す` saves the key and immediately starts this song's request. The reader's tap already expressed that intent.
- `保存だけする` saves the key and moves to S2.

**Settings layout** (one scrolling column, three sections)
1. **翻訳に使うAI.** One Gemini key row; the engine chooses among Gemini's models itself (§8). The row shows its status dot and text. Keys are stored only in `GM.setValue`, never in `localStorage` or the DOM, and are shown masked (`••••abcd`).
2. **この曲.** The model and date of this song's edition (this is the only place a model name appears), plus retranslate and delete, each with an inline confirmation.
3. **保存データ.** The count and size of saved songs, export (`lyric-lens-YYYYMMDD.json`), import, and delete-all. Import validates every record, merges only what is strictly better (more translated lines, then finished over cut, then newer), and skips the song a request is writing. Eviction past 300 songs orders by last read and never removes a partly translated song.

There is no auto-translate, no note-amount setting, no font-size control (the page zoom covers it) and no quota counter.

**Translation-visibility toggle.** `訳を隠す` lives in the head row, not in settings, so reading along with the music is one tap away. It hides line nodes, notes and highlights, and is remembered per viewer in GM storage.

## 8. Engine contract (the parts that shape the UX)

**Request.**
- The full lyrics in order, each line tagged with an ID. Exact repeats carry the ID of their first occurrence as `(=L7)`, and section headers are kept as context.
- Fetched Genius annotations as grounding: the fragment, the text, the votes and an id.
- The model writes the song record first, then one record per **distinct** ID.
- Prompt rules:
  - Tone and temperature come first, meaning second.
  - Keep the speaker's register (俺/僕/あたし, sentence endings).
  - No explanation inside a translation line.
  - Soft guidance: prefer about one phone line (around 24 characters), but never drop tone or a double meaning to fit.
  - The note bar and caps from section 5.

**Output: line-delimited JSON**, one object per line:
- `{"t":"song","who":"…","what":"…","tone":"…","motifs":[{"en":"…","ja":"…"}]}`. `tone` and `motifs` are stored for resume and not shown.
- `{"t":"line","id":"L12","head":"<first 3 English words>","ja":"…","notes":[{"q":"…","k":"slang|wordplay|reference|idiom|ambiguous","x":"…","c":false,"g":"…"}]}`
- `{"t":"end"}`

**Validation.** A line record whose `head` does not match the normalized first words of that ID's line is dropped, and its slot stays empty (becoming a gap at the end). A record that fails to parse affects only that line. Each valid record is written to storage before it is rendered.

**Model selection and failure handling.**
- Candidates come from the model list per tier: Flash 6, Flash-Lite 3, Gemma 1 (so the newest Flash models never crowd out the tiers with their own quotas). One function builds the set for both the request and the pre-send availability check.
- Order: Flash before Flash-Lite before Gemma; within a tier, models that answered within a week and have not failed since go first (fastest first-text first), unknown ones keep their rank, and models busy or silent in the last half hour go last.
- A model silent for 30 s (first text) is given up on and the next starts at once. After two silent models in a row the call stops (stop reason network) instead of waiting out the rest.
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
  2. Make sure each translatable line has exactly one `ll-line[data-ll-key]` after its `<br>`.
  3. Remove orphans.
  4. Restore the open note.
  5. Rebuild the highlight ranges from stored offsets.
- Re-renders never send requests.

**Scroll compensation (no reliance on browser anchoring)**
1. Before each batch of inserts, record the first English line whose top edge is at or below the viewport top, and its `getBoundingClientRect().top`.
2. After the batch, call `scrollBy` with the difference.
3. This also applies to wraps that grow a slot, to notes opening or closing above the viewport, and to the retranslation swap.

**Clicks inside Genius `<a>`.** Native `click`, `pointerdown` and `mousedown` listeners on our own nodes call `stopPropagation()`. `click` also calls `preventDefault()`, except on our real external links (`Google AI Studio を開く`, `キーを作る`). React's root listener therefore never sees them, and the Genius panel never opens from our text. English text and highlight ranges are never our tap targets.

**Annotation click rewrites the URL.** The song identity is unchanged, so nothing happens. Genius' panel opens as usual.

**SPA navigation to another song.** On a new identity, tear down all our nodes, highlights and the sheet, then render the new song from cache or its entry state. An in-flight stream keeps writing to its own song's record and lock. Returning to that song shows S4, filled from storage.

**Two songs at once.** The global lock allows only one in-flight request. The other song shows S2b or the lock-held seam. **The same song in two tabs:** the second tab becomes S4m and follows via `GM_addValueChangeListener`, or by polling every 1.5 s while the tab is visible.

**Repeated choruses.** Each is translated once. Every occurrence fills at the same moment its first occurrence arrives, rendered in `ink-repeat` with `↺`, and carries a grey `※` if the original has notes. A line that differs by one word is a distinct line and gets normal ink.

**Very long songs.** Deduplication shrinks the output. If the model stops at its output-length limit, the request ends with the "long song" seam, and one tap continues. There are no client-side line caps.

**0 lines.** The S0 state: no UI at all.

**Lyrics edited on Genius.** S7. Lines that still match keep their translations; only the new hashes are requested.

**Browsers without the CSS Highlight API.** No underlines; notes keep the quoted phrase.

**Phone suspended or tab closed mid-stream.** The lines that arrived are already saved. On reopen the song shows S6 with `ここまで訳してあります`.

## 10. What we deliberately do not build

- **A guide panel, jump-to-line, or a floating progress or jump pill.** The two-line preface is the guide, and the page is the map.
- **Auto-translate on load, auto-resume on reconnect, background retries.** Every request is a tap made at that moment.
- **Quota counters or estimates, model names or "busy, switching" messages on the reading surface.** The model name appears only in settings.
- **Note-amount levels, uncertainty labels on lines, single-line re-analysis.** One strict note bar and `推測` on notes only.
- **A hard character budget.** Length guidance is soft, and tone wins.
- **Kind-coded colours, chips, or resting underlines on the English.** One accent ink and one ※.
- **Floating note popovers or tooltips, or notes that close on scroll.** Notes open inline, one at a time.
- **Tap-to-peek on English lines, or hit-testing of highlight ranges.** The English belongs to Genius.
- **Phrasebook, review cards, furigana, romanization, vocabulary lists, karaoke sync, a listening mode beyond `訳を隠す`.** It is a comprehension tool, not a study app.
- **Translating Genius annotations, or clicking Genius links from our UI.** Their text is shown in English, collapsed, inside our note.
- **Translated section headers, or a colophon or finish toast.** A page with no empty slots is finished.
- **Mincho type, web fonts, or a font-size control.**
## Appendix: how this spec was made, and engineering amendments

This specification was synthesized from five independent first-principles concepts (close reader, listener, learner, calm technology, bold reinvention) plus one earlier draft ("translator's red pen"), scored by three judges (reader value, feasibility, design coherence). The calm "ruled paper" concept won (24.5) narrowly over the "bilingual edition" concept (24.0); grafts came from the listener, learner and bold concepts.

Amendments made during implementation:

1. **Head row placement.** Inserted *inside* the first `[data-lyrics-container]`, right after Genius' own lyrics header (`[data-exclude-from-selection]`), not as the container's previous sibling. On desktop the containers' parent is a CSS grid; an extra sibling would be auto-placed into the wrong grid cell. Insertion inside the container was verified on live Genius pages to survive re-renders and annotation clicks.
2. **Line keys.** Lines are keyed by the normalized text itself (lowercased, quotes straightened, trailing punctuation dropped) rather than a hash; same effect, easier to debug.
3. **Head echo tolerance.** `head` must match at least two of the first three normalized words (`-in'`/`-ing` treated alike); a missing `head` is accepted.
4. **Persisted progress carries `stop: closed`** while a request is in flight, so a tab that dies mid-stream leaves a resumable song (S6 "ここまで訳してあります") instead of one that looks finished or "lyrics changed" (S7).
5. **A first request that produced no lines** shows its reason in the head row (with the seam's button rule) instead of drawing a seam at line 1.
6. **Retranslation lands when it mostly succeeds.** If a retranslation is cut ('length') or skips lines ('gaps'), the missing lines keep their previous translation and the new edition is swapped in; only a failure with nothing usable keeps the old edition (S8f). A retranslation that cannot start (quota, another song running) says so in the head row: `訳し直せませんでした。今の訳はそのままです` + reason. The settings sheet hides 「この曲」 while a request is writing this song.
7. **Zero-line failures are not stored** (except an invalid key, which explains why 日本語で読む needs a new key). Reopening such a song shows plain S2.
8. **The seam sits at the writing frontier** (the first missing line after the last filled one); missing lines before it are lines the model skipped and read as `—`.
9. **The preface is text, not a button.** Only a small ▸/▾ toggle (44 px hit area) opens and closes 「この曲は」; the text stays readable, selectable and announced.
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
23. **Sound-only ad-libs stay sounds** (ayy, uh, skrrt, funk → エイ, アー, スカー, ファンク): they are never given an invented meaning. The preface is held to one plain sentence for 誰が誰に (≤40 characters, no bracketed asides) and what the lyrics support for この曲は (≤80 characters); the song-wide note ceiling is enforced in code (wordplay and ambiguity may use two extra slots).
24. **Accessibility.** The head row's status is one persistent polite live region updated in place (so streaming does not re-announce it); gap and repeat marks are labelled images; buttons dim while pressed on touch, and hover styles apply only where hover exists.
25. **Automatically chosen Gemini models adapt to how they have behaved** (`ll3:health`, per key and model, entries older than 14 days dropped): a model that answered within the week and has not failed since goes first, fastest first-text time first; unknown models keep their rank order after those; a model that was busy or silent in the last half hour goes last. Flash always stays ahead of Flash-Lite and Gemma. A model silent for 30 s is given up on, benched for five minutes like a busy one (but skipped, not tried last), and the next model starts at once.

26. **Gemini only.** Groq, OpenRouter and every other provider are removed, along with `キーを足す`, the spare-key text and the settings focus for it; `@connect` is generativelanguage.googleapis.com alone; settings keep one key row, older stored shapes are migrated, and other services' cached lists, cooldowns and health are cleaned at start.
27. **A 200 response with no accepted line is a failure** (`unusable`, 10 min cooldown, next model), so a model that only yields broken output gains no health.
28. **Candidate slots are reserved per tier** (Flash 6, Flash-Lite 3, Gemma 1), shared by the request and the availability check, so exhausted Flash quota no longer hides Flash-Lite.
29. **Two silent models in a row end the call** (stop reason network); during an outage the reader is not kept waiting minutes.
30. **Error classes have their own copy and cooldowns:** `rejected`, `no-model`, `empty` and `unusable` read differently; a rejected request benches that model for 6 h; the safety-filter sentence is Gemini-only.
31. **LLM errors are recorded:** logged per failed model (API key scrubbed), the last one stored on the song's stop and shown under 「直近のエラー」; a run with misaligned records warns once with the count.
32. **A line starting with a parenthesis passes the head check** if the head matches the line with its leading parenthesised groups removed.
33. **Kana-less CJK lyrics are not Japanese** (SJ also needs ≥30% of lines with kana).
34. **The note ceiling is per song** (whole-song line count minus notes already stored); the 2 bonus slots are once per song.
35. **`FALLBACK_GEMINI` was refreshed** to existing ids, and the model list is cached 7 days with the stale list preferred over the built-in one.
36. **Records carry `keyVersion`** (current 1; `migrateRecord` is the entry point for a future re-keying).
37. **公認 marks `verified` or `accepted` annotations;** a retranslation that carried old lines over keeps the new motifs and records `carried: n` on the record (no UI).
38. **Flash has a 20 s time budget for its first line** (measured live: Flash flaps, 503s and 30 s silences, while Flash-Lite answers its first line in about 1.5 s). The budget runs from the start of the call; each Flash attempt's first-text timeout is the remaining budget (never above 30 s), and no Flash attempt starts with less than 8 s left. It applies only while a Flash-Lite candidate is queued behind to take over (Gemma is slower than a slow Flash), never to a pinned model, and not once any Flash text has arrived. A budget timeout benches the model for 5 min like any silence but is not one of the two silent models that end a call. A call that left Flash for lack of time stores `flashDegradedUntil` = now + 10 min (`ll3:flashdegraded`, per key); until then the order is Flash-Lite, Flash, Gemma, and the next successful Flash answer clears it. `availability()` is unaffected.

Each of these came out of four rounds of multi-lens review with adversarial verification, all fixed and covered by the unit tests.
