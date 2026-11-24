/* The tablet app's library: list, import and remove books in the browser's private storage (OPFS). */
"use strict";
const $ = id => document.getElementById(id);
const MB = 1024 * 1024, GB = 1024 * MB;
let root, books;

async function init() {
  if (!navigator.storage || !navigator.storage.getDirectory) {
    $("books").innerHTML = '<div class="card">This browser can\'t store books offline. Try Firefox or Chrome.</div>';
    return;
  }
  root = await navigator.storage.getDirectory();
  books = await root.getDirectoryHandle("books", { create: true });
  try { await root.removeEntry("book", { recursive: true }); } catch (e) {}   // the old import test's copy, if still there
  if (navigator.storage.persist) await navigator.storage.persist();
  await list();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  // laptop self-test only: ?src=<zip on this server> imports it without the file picker
  const src = new URLSearchParams(location.search).get("src");
  if (src && location.hostname === "localhost") await importZip(await (await fetch(src)).blob());
}

async function dirSize(dir) {
  let n = 0;
  for await (const [, h] of dir.entries()) n += h.kind === "file" ? (await h.getFile()).size : await dirSize(h);
  return n;
}

async function list() {
  const out = [];
  for await (const [name, h] of books.entries()) {
    if (h.kind !== "directory") continue;
    let chapters = "?";
    try {
      const f = await (await (await (await h.getDirectoryHandle("Reader")).getDirectoryHandle("data")).getFileHandle("book.js")).getFile();
      const t = await f.text(); chapters = JSON.parse(t.slice(t.indexOf("(") + 1, t.lastIndexOf(")"))).chapters.length;
    } catch (e) { chapters = "incomplete import"; }
    out.push({ name, chapters, size: await dirSize(h) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  const box = $("books"); box.innerHTML = "";
  if (!out.length) box.innerHTML = '<div class="card muted">No books yet. Import one below.</div>';
  for (const b of out) {
    const c = document.createElement("div"); c.className = "card book";
    const a = document.createElement("a"); a.className = "open"; a.href = "reader.html?book=" + encodeURIComponent(b.name);
    a.innerHTML = '<div class="t"></div><div class="muted"></div>';
    a.firstChild.textContent = b.name;
    a.lastChild.textContent = (typeof b.chapters === "number" ? b.chapters + " chapters · " : b.chapters + " · ") + (b.size / GB).toFixed(2) + " GB";
    const rm = document.createElement("button"); rm.className = "remove"; rm.textContent = "Remove";
    rm.onclick = async () => {
      if (!confirm(`Remove "${b.name}" from this device? You can import it again from its zip.`)) return;
      await books.removeEntry(b.name, { recursive: true }); await list();
    };
    const open = document.createElement("a"); open.className = "btn primary"; open.href = a.href; open.textContent = "Open";
    open.style.cssText = "text-decoration:none;padding:12px 18px;border-radius:10px;background:#1d2127;color:#fff";
    c.append(a, open, rm); box.appendChild(c);
  }
  if (navigator.storage.estimate) {
    const e = await navigator.storage.estimate();
    $("storage").textContent = `Storage used: ${(e.usage / GB).toFixed(2)} GB of ${(e.quota / GB).toFixed(0)} GB available to this app.`;
  }
}

// ---- reading a "stored" (uncompressed) zip entry by entry, never the whole thing in memory
async function view(file, start, len) { return new DataView(await file.slice(start, start + len).arrayBuffer()); }

async function entries(file) {
  const tailLen = Math.min(file.size, 65557 + 20 + 56);
  const tail = await view(file, file.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("that file isn't a zip");
  let count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
  if (cdOff === 0xffffffff || count === 0xffff) {
    const z = await view(file, Number(tail.getBigUint64(eocd - 20 + 8, true)), 56);
    count = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
  }
  const cd = await view(file, cdOff, cdSize), dec = new TextDecoder(), list = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error("the zip looks damaged");
    const method = cd.getUint16(p + 10, true);
    let size = cd.getUint32(p + 20, true), local = cd.getUint32(p + 42, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    let q = p + 46 + nameLen; const end = q + extraLen;
    while (q + 4 <= end) {
      const id = cd.getUint16(q, true), len = cd.getUint16(q + 2, true); let r = q + 4;
      if (id === 0x0001) {
        if (cd.getUint32(p + 24, true) === 0xffffffff) r += 8;
        if (size === 0xffffffff) { size = Number(cd.getBigUint64(r, true)); r += 8; }
        if (local === 0xffffffff) { local = Number(cd.getBigUint64(r, true)); r += 8; }
      }
      q += 4 + len;
    }
    list.push({ name, method, size, local });
    p = end + commentLen;
  }
  return list;
}

async function importZip(file) {
  const items = (await entries(file)).filter(e => !e.name.endsWith("/"));
  const tops = new Set(items.map(e => e.name.split("/")[0]));
  if (tops.size !== 1 || !items.some(e => e.name.endsWith("/Reader/data/book.js")))
    throw new Error("this isn't a book reader zip (it should come from the book tool)");
  if (items.some(e => e.method !== 0)) throw new Error("this zip is compressed; use the zip the book tool made");
  const top = [...tops][0];
  try { await books.removeEntry(top, { recursive: true }); } catch (e) {}     // importing again replaces it
  const total = items.reduce((s, e) => s + e.size, 0);
  $("importing").hidden = false;
  const t0 = performance.now(); let done = 0;
  for (const e of items) {
    const h = await view(file, e.local, 30);
    const start = e.local + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    const parts = e.name.split("/"); let dir = books;
    for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(d, { create: true });
    const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    for (let off = 0; off < e.size; off += 16 * MB) {
      await w.write(file.slice(start + off, start + Math.min(e.size, off + 16 * MB)));
      done += Math.min(16 * MB, e.size - off);
      $("bar").value = done / total;
      const s = (performance.now() - t0) / 1000;
      $("prog").textContent = `Importing "${top}": ${(done / GB).toFixed(2)} of ${(total / GB).toFixed(2)} GB · about ${Math.max(0, Math.round((total - done) / (done / s || 1)))} s left`;
    }
    await w.close();
  }
  $("prog").textContent = `Imported "${top}" (${(total / GB).toFixed(2)} GB). You can delete the zip from your downloads now.`;
  await list();
}

$("zip").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { await importZip(f); }
  catch (err) { $("importing").hidden = false; $("prog").textContent = "Couldn't import: " + err.message; }
  e.target.value = "";
};
$("helpBtn").onclick = () => { $("help").hidden = !$("help").hidden; };
init().catch(err => { $("books").innerHTML = `<div class="card">Something went wrong: ${err.message}</div>`; });
