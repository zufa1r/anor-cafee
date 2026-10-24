(function () {
  "use strict";

  var STATE_LABEL = { new: "Navbatda", cooking: "Tayyorlanmoqda", ready: "Tayyor", done: "Berildi" };
  var DEST_LABEL = { oshxona: "Oshxona", bar: "Bar" };
  var TABLE_TTL = 12 * 3600 * 1000;
  var ORDER_TTL = 3 * 3600 * 1000;

  var S = { table: null, key: null, cart: {}, order: null, status: {}, poll: null };

  function $(id) { return document.getElementById(id); }
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  var toastTimer;
  function msg(text) {
    var t = $("toast");
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  /* ---------- Stol (QR-koddan) ---------- */
  var params = new URLSearchParams(location.search);
  if (params.get("stol") && params.get("k")) {
    S.table = params.get("stol"); S.key = params.get("k");
    store("anor-table", { t: S.table, k: S.key, at: Date.now() });
    if (history.replaceState) history.replaceState(null, "", location.pathname);
  } else {
    var saved = load("anor-table");
    if (saved && Date.now() - saved.at < TABLE_TTL) { S.table = saved.t; S.key = saved.k; }
  }
  var canOrder = !!(S.table && S.key);
  document.body.classList.toggle("can-order", canOrder);
  var banner = $("banner");
  if (canOrder) {
    banner.className = "banner ok";
    banner.textContent = "Siz Stol " + S.table + " dasiz. Taomlarni tanlab, buyurtma bering.";
    $("tableLabel").textContent = "Stol " + S.table;
    $("tableLabel").hidden = false;
  } else {
    banner.textContent = "Buyurtma berish uchun stolingizdagi QR-kodni telefoningiz kamerasi bilan skanerlang.";
  }

  /* ---------- Menyu va savat ---------- */
  var first = document.querySelector("#tabs .tab");
  if (first) first.setAttribute("aria-current", "true");

  function itemEl(id) { return document.querySelector('.item[data-id="' + id + '"]'); }
  function lines() {
    return Object.keys(S.cart).map(function (id) {
      var el = itemEl(id);
      return { id: id, n: el.getAttribute("data-name"), p: Number(el.getAttribute("data-price")), q: S.cart[id] };
    });
  }
  function totals() {
    var count = 0, total = 0;
    lines().forEach(function (l) { count += l.q; total += l.q * l.p; });
    return { count: count, total: total };
  }
  function updateBar() {
    var t = totals();
    $("cartbar").hidden = !(canOrder && t.count > 0 && $("sheet").hidden && !S.order);
    $("cartCount").textContent = "Savat · " + t.count + " ta";
    $("cartSum").textContent = fmt(t.total) + " so'm";
  }
  function setQty(id, q) {
    q = Math.max(0, Math.min(20, q));
    if (q) S.cart[id] = q; else delete S.cart[id];
    var li = itemEl(id);
    li.querySelector(".add").hidden = q > 0;
    li.querySelector(".step").hidden = q === 0;
    li.querySelector(".q").textContent = q;
    updateBar();
  }
  $("menu").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-act]");
    if (!b || !canOrder) return;
    var id = b.closest(".item").getAttribute("data-id");
    var q = S.cart[id] || 0;
    setQty(id, b.getAttribute("data-act") === "plus" ? q + 1 : q - 1);
  });

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  $("tabs").addEventListener("click", function (e) {
    var b = e.target.closest(".tab");
    if (!b) return;
    var el = $("cat-" + b.getAttribute("data-cat"));
    if (el) el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  });
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var id = en.target.id.replace("cat-", "");
        var tabs = $("tabs");
        tabs.querySelectorAll(".tab").forEach(function (t) {
          if (t.getAttribute("data-cat") === id) {
            t.setAttribute("aria-current", "true");
            tabs.scrollTo({ left: t.offsetLeft - tabs.clientWidth / 2 + t.clientWidth / 2, behavior: "auto" });
          } else { t.removeAttribute("aria-current"); }
        });
      });
    }, { rootMargin: "-25% 0px -65% 0px" });
    document.querySelectorAll(".cat").forEach(function (s) { io.observe(s); });
  }

  /* ---------- Savat oynasi va buyurtma ---------- */
  function openSheet() {
    var ls = lines();
    if (!ls.length) return;
    $("lines").innerHTML = ls.map(function (l) {
      return '<li><span class="t">' + l.q + " × " + esc(l.n) + '</span><span class="s">' + fmt(l.q * l.p) + " so'm</span></li>";
    }).join("");
    $("sheetTotal").textContent = fmt(totals().total) + " so'm";
    $("sheetTable").textContent = "Stol " + S.table;
    $("sendErr").hidden = true;
    $("send").disabled = false;
    $("sheet").hidden = false;
    $("cartbar").hidden = true;
  }
  $("openSheet").addEventListener("click", openSheet);
  $("closeSheet").addEventListener("click", function () { $("sheet").hidden = true; updateBar(); });
  function showErr(text) { var e = $("sendErr"); e.textContent = text; e.hidden = false; }

  $("send").addEventListener("click", function () {
    var btn = $("send");
    var ls = lines();
    if (!ls.length) return;
    btn.disabled = true;
    fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        table: S.table, key: S.key, note: $("note").value.trim(),
        items: ls.map(function (l) { return { id: l.id, q: l.q }; })
      })
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (res) {
      if (!res.ok) { btn.disabled = false; showErr(res.d.error || "Buyurtma yuborilmadi."); return; }
      S.order = { id: res.d.id, no: res.d.no, table: S.table, total: res.d.total, dests: res.d.dests, createdAt: Date.now() };
      store("anor-order", S.order);
      Object.keys(S.cart).forEach(function (id) { setQty(id, 0); });
      $("note").value = "";
      $("sheet").hidden = true;
      showDone();
    }).catch(function () {
      btn.disabled = false;
      showErr("Internet bilan aloqa yo'q. Qayta urinib ko'ring.");
    });
  });

  /* ---------- Buyurtma holati ---------- */
  function renderDone() {
    var o = S.order;
    if (!o) return;
    var states = o.dests.map(function (d) { return S.status[d] || "new"; });
    var allReady = states.every(function (s) { return s === "ready" || s === "done"; });
    var allDone = states.every(function (s) { return s === "done"; });
    var head = allDone ? "Yoqimli ishtaha!" : allReady ? "Buyurtmangiz tayyor" : "Buyurtma qabul qilindi";
    var rows = o.dests.map(function (d) {
      var s = S.status[d] || "new";
      return '<div class="trow"><b>' + DEST_LABEL[d] + '</b><span class="pill ' + s + '">' + STATE_LABEL[s] + "</span></div>";
    }).join("");
    $("doneBox").innerHTML =
      '<div><p class="eyebrow">Stol ' + esc(o.table) + " · №" + esc(o.no) + "</p><h1>" + head + "</h1></div>" +
      '<div class="track">' + rows + "</div>" +
      '<p class="eyebrow">Jami: ' + fmt(o.total) + " so'm. Hisobni ofitsiant olib keladi.</p>" +
      '<button class="ghost" type="button" id="again">Yana buyurtma berish</button>';
    $("again").addEventListener("click", function () {
      clearInterval(S.poll); S.poll = null;
      S.order = null; S.status = {}; store("anor-order", null);
      $("view-done").hidden = true; $("view-menu").hidden = false;
      updateBar(); window.scrollTo(0, 0);
    });
  }
  function fetchStatus() {
    if (!S.order) return;
    fetch("/api/orders/" + encodeURIComponent(S.order.id)).then(function (r) {
      if (r.status === 404) { clearInterval(S.poll); return null; }
      return r.json();
    }).then(function (d) {
      if (d && d.status) { S.status = d.status; renderDone(); }
    }).catch(function () {});
  }
  function showDone() {
    $("view-menu").hidden = true;
    $("view-done").hidden = false;
    $("cartbar").hidden = true;
    renderDone();
    fetchStatus();
    clearInterval(S.poll);
    S.poll = setInterval(fetchStatus, 4000);
    window.scrollTo(0, 0);
  }

  var prev = load("anor-order");
  if (canOrder && prev && prev.id && Date.now() - prev.createdAt < ORDER_TTL) {
    S.order = prev;
    showDone();
  }
  updateBar();
})();
