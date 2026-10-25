// ==UserScript==
// @name         Lyric Lens for Genius
// @namespace    taq.replay.lyrics
// @version      3.0.0
// @description  Genius の歌詞を、曲全体の文脈を踏まえた自然な日本語訳と、本当に必要な注釈で読み解く。
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
// @grant        GM_info
// @connect      generativelanguage.googleapis.com
// @connect      api.groq.com
// @connect      api.cerebras.ai
// @connect      openrouter.ai
// @connect      api.mistral.ai
// @connect      models.github.ai
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==
