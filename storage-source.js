/* Storage mode for the reader: the book lives in the browser's private storage (OPFS) under books/<name>/,
   exactly as it was laid out in the zip (Reader/..., Audio/...). Loaded before reader.js on reader.html. */
(function () {
  "use strict";
  var name = new URLSearchParams(location.search).get("book") || "";
  var dirP = navigator.storage.getDirectory()
    .then(function (r) { return r.getDirectoryHandle("books"); })
    .then(function (b) { return b.getDirectoryHandle(name); });

  function fileAt(path) {
    return dirP.then(function (dir) {
      var parts = path.split("/"), i = 0;
      function step(d) {
        if (i === parts.length - 1) return d.getFileHandle(parts[i]).then(function (h) { return h.getFile(); });
        return d.getDirectoryHandle(parts[i++]).then(step);
      }
      return step(dir);
    });
  }
  function dataFile(path) {             // READER.x({...}); -> the object
    return fileAt(path).then(function (f) { return f.text(); })
      .then(function (t) { return JSON.parse(t.slice(t.indexOf("(") + 1, t.lastIndexOf(")"))); });
  }

  var audioUrl = null;
  window.READER_SOURCE = {
    id: "book:" + name,
    libraryUrl: "./",
    loadChapter: function (info, ok, fail) { dataFile("Reader/" + info.file).then(ok, fail); },
    showPage: function (img, p) {
      fileAt("Reader/pages/p" + String(p).padStart(4, "0") + ".webp").then(function (f) {
        if (!img.dataset.shown) return;                 // scrolled away again before it loaded
        img.dataset.url = URL.createObjectURL(f); img.src = img.dataset.url;
      }, function () {});
    },
    hidePage: function (img) {                          // free the memory of pages far out of view
      if (img.dataset.url) { URL.revokeObjectURL(img.dataset.url); delete img.dataset.url; }
      img.removeAttribute("src");
    },
    audioUrl: function (d, cb) {
      fileAt(d.mp3.replace(/^\.\.\//, "")).then(function (f) {
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        audioUrl = URL.createObjectURL(f); cb(audioUrl);
      }, function () { cb(""); });
    }
  };

  document.title = name || "Book reader";
  function boot() {
    dataFile("Reader/data/book.js").then(function (d) {
      d.title = name;
      var t = document.getElementById("bookTitle"); if (t) t.textContent = name;
      window.READER.book(d);
    }, function () {
      document.body.innerHTML = '<p style="font:16px system-ui;padding:24px">This book isn\'t on this device ' +
        '(it may have been removed). <a href="./">Back to the library</a></p>';
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
