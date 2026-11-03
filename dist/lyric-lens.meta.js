// ==UserScript==
// @name         Lyric Lens for Genius
// @namespace    taq.replay.lyrics
// @version      3.0.0
// @description  Genius の歌詞の各行の下に、曲全体の文脈を踏まえた自然な日本語訳を添えます。読み違えやすい語句にだけ短い注を付けます。無料の Gemini API キーで動きます。
// @author       taq
// @match        https://genius.com/*
// @match        https://*.genius.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.listValues
// @grant        GM_registerMenuCommand
// @grant        GM.registerMenuCommand
// @grant        GM_info
// @connect      generativelanguage.googleapis.com
// @run-at       document-idle
// @noframes
// ==/UserScript==
