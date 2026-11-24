/* Click-to-play book reader.
   Where the book's data comes from is a "source":
   - file mode (default; the laptop's double-click version): <script> tags and relative paths, works from file://
   - storage mode (the tablet app): storage-source.js sets window.READER_SOURCE and reads from the browser's
     private storage, handing pages and audio over as object URLs. */
(function () {
  "use strict";
  var book = null;                 // READER.book data
  var chapters = {};               // n -> chapter data (words, sentences, byPage)
  var waiting = {};                // n -> [resolve callbacks]
  var cur = null;                  // chapter data playing
  var curWord = -1, curSent = -1;
  var follow = true, autoScrolling = false;
  var pageEls = {};                // page number -> {el, ov}
  var $ = function (id) { return document.getElementById(id); };
  var audio = $("audio");
  var SOURCE = window.READER_SOURCE || {
    id: location.pathname,
    loadChapter: function (info, ok, fail) {       // the data file calls READER.chapter(...) itself
      var s = document.createElement("script");
      s.src = info.file;
      s.onload = function () { s.remove(); };
      s.onerror = function () { s.remove(); fail(); };
      document.body.appendChild(s);
    },
    showPage: function (img, p) { img.src = "pages/p" + String(p).padStart(4, "0") + ".webp"; },
    hidePage: function () {},
    audioUrl: function (d, cb) { cb(d.mp3); }
  };
  var STORE = "reader-pos:" + SOURCE.id;

  window.READER = {
    book: function (d) { book = d; start(); },
    chapter: function (d) {
      d.byPage = {};
      for (var i = 0; i < d.words.length; i++) {
        var p = d.words[i][2];
        if (p != null) (d.byPage[p] = d.byPage[p] || []).push(i);
      }
      chapters[d.chapter] = d;
      (waiting[d.chapter] || []).forEach(function (f) { f(d); });
      delete waiting[d.chapter];
      markClicky(d);
      // grey out text that isn't read aloud (figure labels, table cells, page headers)
      for (var q in d.quiet || {}) {
        if (!pageEls[q]) continue;
        d.quiet[q].forEach(function (r) { box(pageEls[q].ov, +q, r[0] - 1, r[1] - 1, r[2] + 1, r[3] + 1, "quiet"); });
      }
    }
  };

  var failed = {};                 // n -> time its data file was found missing
  function chapterInfo(n) { return book.chapters.filter(function (c) { return c.n === n; })[0]; }
  function loadChapter(n, cb, quiet) {
    if (chapters[n]) return cb(chapters[n]);
    var info = chapterInfo(n);
    if (!info) return;
    if (quiet && failed[n] && Date.now() - failed[n] < 60000) return;   // don't retry on every page scrolled past
    if (waiting[n]) return waiting[n].push(cb);
    waiting[n] = [cb];
    SOURCE.loadChapter(info, function (d) { window.READER.chapter(d); }, function () {
      delete waiting[n]; failed[n] = Date.now();
      if (!quiet) toast("Chapter " + n + " isn't ready yet: its narration timing is still being made.");
    });
  }
  // only the most recent request (click, chapter pick, restore) gets to act once its data arrives
  var req = 0;
  function latest(fn) { var my = ++req; return function (d) { if (my === req) fn(d); }; }

  function fmt(t) {
    t = Math.max(0, Math.floor(t || 0));
    var h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  }
  function say(msg) { $("nowTitle").textContent = msg; }
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 4000);
  }

  // ---------- layout ----------
  function start() {
    var nav = $("chapters");
    book.chapters.forEach(function (c) {
      var a = document.createElement("a");
      a.href = "#"; a.dataset.n = c.n;
      a.innerHTML = '<span class="n">' + c.n + "</span><span></span>";
      a.lastChild.textContent = c.title;
      a.onclick = function (e) { e.preventDefault(); openChapter(c.n); };
      nav.appendChild(a);
    });
    var main = $("pages");
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        var el = e.target, img = el.querySelector("img"), p = +el.dataset.p;
        if (!e.isIntersecting) {                     // far out of view: let the source free its memory
          if (img.dataset.shown) { delete img.dataset.shown; SOURCE.hidePage(img, p); }
          return;
        }
        if (!img.dataset.shown) { img.dataset.shown = "1"; SOURCE.showPage(img, p); }
        var n = book.pageChapter[p];
        if (n && !chapters[n]) loadChapter(n, function () {}, true);
      });
    }, { root: main, rootMargin: "1500px 0px" });
    book.pages.forEach(function (wh, i) {
      var p = i + 1, el = document.createElement("div");
      el.className = "page"; el.dataset.p = p; el.style.aspectRatio = wh[0] + " / " + wh[1];
      el.innerHTML = '<img alt="Page ' + p + '"><div class="ov"></div>';
      el.onclick = onPageClick;
      el.onmousemove = onPageHover;
      main.appendChild(el);
      pageEls[p] = { el: el, ov: el.querySelector(".ov") };
      io.observe(el);
    });
    // stop following when *you* scroll (wheel, touch, scrollbar drag, scrolling keys) — not when the reader does
    var userScroll = function () { if (!audio.paused && follow) { follow = false; $("follow").hidden = false; } };
    main.addEventListener("wheel", userScroll, { passive: true });
    main.addEventListener("touchmove", userScroll, { passive: true });
    main.addEventListener("mousedown", function (e) { if (e.offsetX > main.clientWidth) userScroll(); });
    document.addEventListener("keydown", function (e) {
      if (["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End"].indexOf(e.code) >= 0) userScroll();
    });
    wire();
    restore();
  }

  function markClicky(d) {
    for (var p in d.byPage) if (pageEls[p]) pageEls[p].el.classList.add("clicky");
  }

  // ---------- finding words ----------
  function pointOnPage(el, e) {
    var r = el.getBoundingClientRect(), wh = book.pages[el.dataset.p - 1];
    return { x: (e.clientX - r.left) / r.width * wh[0], y: (e.clientY - r.top) / r.height * wh[1] };
  }
  function wordAt(d, page, pt) {
    var list = d.byPage[page]; if (!list) return -1;
    // a box containing the point wins (nearest centre if several do); otherwise the nearest box within 4 pt
    var best = -1, bestD = 4, inside = -1, insideD = Infinity;
    for (var k = 0; k < list.length; k++) {
      var w = d.words[list[k]];
      var dx = Math.max(w[3] - pt.x, 0, pt.x - w[5]), dy = Math.max(w[4] - pt.y, 0, pt.y - w[6]);
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist === 0) {
        var c = Math.hypot((w[3] + w[5]) / 2 - pt.x, (w[4] + w[6]) / 2 - pt.y);
        if (c < insideD) { insideD = c; inside = list[k]; }
      } else if (dist < bestD) { bestD = dist; best = list[k]; }
    }
    return inside >= 0 ? inside : best;
  }
  function wordIndexAt(t) {          // last word starting at or before t
    var w = cur.words, lo = 0, hi = w.length - 1, ans = 0;
    while (lo <= hi) { var m = (lo + hi) >> 1; if (w[m][0] <= t + 0.02) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }
  function sentenceOf(i) {
    var s = cur.sentences, lo = 0, hi = s.length - 1, ans = 0;
    while (lo <= hi) { var m = (lo + hi) >> 1; if (s[m] <= i) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }

  function onPageHover(e) {
    var el = e.currentTarget, n = book.pageChapter[el.dataset.p], d = chapters[n];
    el.style.cursor = d && wordAt(d, +el.dataset.p, pointOnPage(el, e)) >= 0 ? "pointer" : "default";
  }
  function onPageClick(e) {
    var el = e.currentTarget, page = +el.dataset.p, n = book.pageChapter[page], pt = pointOnPage(el, e);
    if (!n) return;
    loadChapter(n, latest(function (d) {
      var i = wordAt(d, page, pt);
      if (i < 0) return;
      flash(d.words[i]);
      playFrom(d, d.words[i][0], true);
    }));
  }

  // ---------- playing ----------
  var pending = null;              // the latest jump asked for while the chapter's audio is still loading
  audio.addEventListener("loadedmetadata", function () {
    audio.playbackRate = +$("speed").value;
    if (pending) { var f = pending; pending = null; f(); }
  });
  function useChapter(d, cb) {
    if (cur === d && !audio.error) { if (audio.readyState >= 1) cb(); else pending = cb; return; }
    cur = d; curWord = curSent = -1;
    pending = cb;
    SOURCE.audioUrl(d, function (url) { if (cur === d) audio.src = url; });
    document.querySelectorAll("#chapters a").forEach(function (a) { a.classList.toggle("on", +a.dataset.n === d.chapter); });
    mediaInfo(d);
  }
  // lock-screen / notification controls (Media Session)
  function mediaInfo(d) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "Chapter " + d.chapter + ": " + d.title, artist: (book && book.title) || document.title, album: document.title });
  }
  function mediaControls() {
    if (!("mediaSession" in navigator)) return;
    var ms = navigator.mediaSession, set = function (a, f) { try { ms.setActionHandler(a, f); } catch (e) {} };
    set("play", function () { audio.play(); });
    set("pause", function () { audio.pause(); });
    set("previoustrack", function () { stepSentence(-1); });
    set("nexttrack", function () { stepSentence(1); });
    set("seekbackward", function (e) { audio.currentTime = Math.max(0, audio.currentTime - (e.seekOffset || 10)); });
    set("seekforward", function (e) { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (e.seekOffset || 10)); });
    set("seekto", function (e) { audio.currentTime = e.seekTime; });
    audio.addEventListener("timeupdate", function () {
      if (!audio.duration || !ms.setPositionState) return;
      try { ms.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate }); } catch (e) {}
    });
  }
  function playFrom(d, t, play) {
    useChapter(d, function () {
      audio.currentTime = t;
      follow = true; $("follow").hidden = true;
      if (play) audio.play();
      update(true);
    });
  }
  function openChapter(n, play) {
    loadChapter(n, latest(function (d) {
      playFrom(d, 0, !!play);
      scrollToPage(chapterInfo(n).first, 0);
    }));
  }
  function stepSentence(dir) {
    if (!cur) return;
    var s = Math.max(0, Math.min(cur.sentences.length - 1, sentenceOf(curWord < 0 ? 0 : curWord) + dir));
    playFrom(cur, cur.words[cur.sentences[s]][0], !audio.paused);
  }

  function update(force) {
    if (!cur) return;
    var t = audio.currentTime, i = wordIndexAt(t);
    $("tNow").textContent = fmt(t);
    if (audio.duration) { $("tEnd").textContent = fmt(audio.duration); if (!seeking) $("seek").value = Math.round(t / audio.duration * 1000); }
    if (i === curWord && !force) return;
    curWord = i;
    var s = sentenceOf(i);
    if (s !== curSent || force) { curSent = s; drawSentence(); }
    drawWord();
    if (follow) keepInView(cur.words[i]);
  }
  function clearMarks(cls) { document.querySelectorAll("." + cls).forEach(function (x) { x.remove(); }); }
  function box(ov, page, x0, y0, x1, y1, cls) {
    var wh = book.pages[page - 1], b = document.createElement("div");
    b.className = cls;
    b.style.left = (x0 / wh[0] * 100) + "%"; b.style.top = (y0 / wh[1] * 100) + "%";
    b.style.width = ((x1 - x0) / wh[0] * 100) + "%"; b.style.height = ((y1 - y0) / wh[1] * 100) + "%";
    ov.appendChild(b);
  }
  function drawSentence() {
    clearMarks("hl");
    var a = cur.sentences[curSent], b = cur.sentences[curSent + 1] || cur.words.length, lines = [];
    for (var i = a; i < b; i++) {                // merge the sentence's word boxes line by line
      var w = cur.words[i]; if (w[2] == null) continue;
      var L = lines[lines.length - 1];
      if (L && L.p === w[2] && Math.abs(L.y0 - w[4]) < 3 && w[3] >= L.x0 - 2) {
        L.x1 = Math.max(L.x1, w[5]); L.y1 = Math.max(L.y1, w[6]);
      } else lines.push({ p: w[2], x0: w[3], y0: w[4], x1: w[5], y1: w[6] });
    }
    lines.forEach(function (L) { if (pageEls[L.p]) box(pageEls[L.p].ov, L.p, L.x0 - 1.5, L.y0 - 1, L.x1 + 1.5, L.y1 + 1, "hl"); });
    say("Chapter " + cur.chapter + " · " + cur.title);
  }
  function drawWord() {
    clearMarks("cur");
    var w = cur.words[curWord];
    if (w && w[2] != null && pageEls[w[2]]) box(pageEls[w[2]].ov, w[2], w[3], w[4], w[5], w[6] + 1.5, "cur");
  }
  function flash(w) {
    if (w[2] == null || !pageEls[w[2]]) return;
    box(pageEls[w[2]].ov, w[2], w[3] - 2, w[4] - 2, w[5] + 2, w[6] + 2, "flash");
    setTimeout(function () { clearMarks("flash"); }, 700);
  }
  function scrollToPage(p, y, smooth) {
    var main = $("pages"), el = pageEls[p] && pageEls[p].el; if (!el) return;
    var wh = book.pages[p - 1], target = el.offsetTop + (y / wh[1]) * el.offsetHeight - main.clientHeight * 0.3;
    // glide for nearby moves; jump straight there when it's far (a smooth scroll over many pages takes seconds)
    var glide = smooth && Math.abs(target - main.scrollTop) < main.clientHeight * 1.5;
    autoScrolling = true;
    clearTimeout(scrollToPage.t);
    // our own scrolling isn't "the reader scrolled away": stay in follow mode until this scroll has finished
    var done = function () { main.removeEventListener("scrollend", done); clearTimeout(scrollToPage.t);
                             scrollToPage.t = setTimeout(function () { autoScrolling = false; }, 50); };
    main.addEventListener("scrollend", done);
    scrollToPage.t = setTimeout(done, glide ? 1500 : 300);          // fallback if no scrollend fires
    main.scrollTo({ top: target, behavior: glide ? "smooth" : "auto" });
  }
  function keepInView(w) {
    if (!w || w[2] == null) return;
    var main = $("pages"), el = pageEls[w[2]].el, wh = book.pages[w[2] - 1];
    var y = el.offsetTop + (w[4] / wh[1]) * el.offsetHeight - main.scrollTop;
    if (y < main.clientHeight * 0.12 || y > main.clientHeight * 0.8) scrollToPage(w[2], w[4], true);
  }

  // ---------- controls ----------
  var seeking = false;
  function wire() {
    mediaControls();
    // narrow / touch screens: the chapter list slides in from the ☰ button
    $("menuBtn").onclick = function () { document.body.classList.toggle("navopen"); };
    $("chapters").addEventListener("click", function () { document.body.classList.remove("navopen"); });
    $("pages").addEventListener("click", function () { document.body.classList.remove("navopen"); });
    if (SOURCE.libraryUrl) { var lib = $("libraryLink"); lib.href = SOURCE.libraryUrl; lib.hidden = false; }
    $("play").onclick = function () {
      if (!cur) { openChapter(book.chapters[0].n); return; }
      audio.paused ? audio.play() : audio.pause();
    };
    $("back").onclick = function () { stepSentence(-1); };
    $("fwd").onclick = function () { stepSentence(1); };
    $("speed").onchange = function () { audio.playbackRate = +this.value; save(); };
    $("helpBtn").onclick = function () { $("help").hidden = !$("help").hidden; };
    // greying of unread text: on unless you've switched it off (remembered)
    var GREY = "reader-grey:" + location.pathname, greyOn = true;
    try { greyOn = localStorage.getItem(GREY) !== "off"; } catch (e) {}
    $("greyToggle").checked = greyOn;
    document.body.classList.toggle("noquiet", !greyOn);
    $("greyToggle").onchange = function () {
      document.body.classList.toggle("noquiet", !this.checked);
      try { localStorage.setItem(GREY, this.checked ? "on" : "off"); } catch (e) {}
      this.blur();
    };
    $("follow").onclick = function () {
      follow = true; this.hidden = true;
      var w = cur && cur.words[curWord];
      if (w && w[2] != null) scrollToPage(w[2], w[4], true);
    };
    $("seek").oninput = function () { seeking = true; if (audio.duration) $("tNow").textContent = fmt(this.value / 1000 * audio.duration); };
    $("seek").onchange = function () { seeking = false; if (cur && audio.duration) playFrom(cur, this.value / 1000 * audio.duration, !audio.paused); };
    audio.onplay = function () { $("play").textContent = "❚❚"; $("play").setAttribute("aria-label", "Pause"); if (!raf) loop(); };
    audio.onended = function () {              // carry on into the next chapter
      var i = book.chapters.indexOf(chapterInfo(cur.chapter)), next = book.chapters[i + 1];
      if (!next) { toast("That's the end of the book."); return; }
      try { localStorage.setItem(STORE, JSON.stringify({ chapter: next.n, time: 0, speed: +$("speed").value })); } catch (e) {}
      if (chapters[next.n] || !failed[next.n]) openChapter(next.n, true);
      else toast("End of chapter " + cur.chapter + ". Chapter " + next.n + " isn't ready yet.");
    };
    audio.addEventListener("error", function () {
      if (!cur) return;
      pending = null;
      toast("Couldn't load the narration for chapter " + cur.chapter + ".");
    });
    document.querySelectorAll("#bar button").forEach(function (b) {
      b.addEventListener("mouseup", function () { b.blur(); });   // so Space doesn't also "press" the button
    });
    audio.onpause = function () { $("play").textContent = "▶"; $("play").setAttribute("aria-label", "Play"); save(); };
    audio.onseeked = function () { update(true); };
    document.addEventListener("keydown", function (e) {
      if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
      if (e.code === "Space") { e.preventDefault(); $("play").click(); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); stepSentence(-1); }
      else if (e.code === "ArrowRight") { e.preventDefault(); stepSentence(1); }
    });
    setInterval(function () { if (!audio.paused) save(); }, 5000);
  }
  var raf = 0;
  function loop() { update(false); raf = audio.paused ? 0 : requestAnimationFrame(loop); }

  function save() {
    if (!cur) return;
    if (audio.ended) return;                    // the ended handler saves the next chapter instead
    try { localStorage.setItem(STORE, JSON.stringify({ chapter: cur.chapter, time: audio.currentTime, speed: +$("speed").value })); } catch (e) {}
  }
  function restore() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) {}
    if (!s || !chapterInfo(s.chapter)) return;
    var speeds = [].map.call($("speed").options, function (o) { return o.value; });
    $("speed").value = speeds.indexOf(String(s.speed)) >= 0 ? String(s.speed) : "1";
    loadChapter(s.chapter, latest(function (d) {
      playFrom(d, s.time || 0, false);
      var w = d.words[wordIndexAt(s.time || 0)];
      if (w && w[2] != null) scrollToPage(w[2], w[4]);
    }));
  }
})();
