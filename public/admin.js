(function () {
  "use strict";

  var STATE_LABEL = { new: "Navbatda", cooking: "Tayyorlanmoqda", ready: "Tayyor", done: "Berildi" };
  var DEST_LABEL = { oshxona: "Oshxona", bar: "Bar" };
  var NEXT = { new: ["cooking", "Boshlash"], cooking: ["ready", "Tayyor"], ready: ["done", "Berildi"] };

  var S = { orders: [], now: Date.now(), filter: "all", seen: null, sound: false, timer: null, audio: null };

  function $(id) { return document.getElementById(id); }
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var toastTimer;
  function msg(text) {
    var t = $("toast");
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  function showLogin() {
    clearInterval(S.timer);
    $("login").hidden = false; $("board").hidden = true; $("logout").hidden = true;
  }
  function showBoard() {
    $("login").hidden = true; $("board").hidden = false; $("logout").hidden = false;
  }

  function beep() {
    if (!S.sound) return;
    try {
      var ctx = S.audio || (S.audio = new (window.AudioContext || window.webkitAudioContext)());
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.55);
    } catch (e) {}
  }

  function ago(ts) {
    var m = Math.floor((S.now - ts) / 60000);
    return m < 1 ? "hozir" : m + " daq oldin";
  }

  function render() {
    var out = "", shown = 0;
    S.orders.forEach(function (o) {
      var secs = "";
      ["oshxona", "bar"].forEach(function (d) {
        if (S.filter !== "all" && S.filter !== d) return;
        var s = o.status[d];
        if (!s || s === "done") return;
        var its = o.items.filter(function (i) { return i.dest === d; });
        var nx = NEXT[s];
        secs += '<div class="sec"><div class="sechead"><b>' + DEST_LABEL[d] + '</b><span class="pill ' + s + '">' + STATE_LABEL[s] + "</span></div><ul>" +
          its.map(function (i) { return "<li><b>" + i.q + "×</b>" + esc(i.n) + "</li>"; }).join("") +
          '</ul><button class="act" type="button" data-order="' + esc(o.id) + '" data-dest="' + d + '" data-next="' + nx[0] + '">' + nx[1] + "</button></div>";
      });
      if (!secs) return;
      shown++;
      var fresh = S.now - o.createdAt < 120000;
      out += '<article class="card' + (fresh ? " fresh" : "") + '"><div class="chead"><h3>Stol ' + esc(o.table) + '</h3><span class="meta">№' + esc(o.no) +
        "<br>" + ago(o.createdAt) + " · " + fmt(o.total) + " so'm</span></div>" + secs +
        (o.note ? '<p class="note">' + esc(o.note) + "</p>" : "") +
        '<button class="chek" type="button" data-order="' + esc(o.id) + '">Chekni chop etish</button></article>';
    });
    $("cards").innerHTML = out;
    $("count").textContent = shown ? "Faol buyurtmalar: " + shown : "";
    $("empty").hidden = shown > 0;
  }

  function refresh() {
    return fetch("/api/staff/orders", { credentials: "same-origin" }).then(function (r) {
      if (r.status === 401) { showLogin(); return null; }
      return r.json();
    }).then(function (d) {
      if (!d) return;
      showBoard();
      S.orders = d.orders; S.now = d.now;
      var ids = {};
      var isNew = false;
      d.orders.forEach(function (o) {
        ids[o.id] = true;
        if (S.seen && !S.seen[o.id]) isNew = true;
      });
      S.seen = ids;
      if (isNew) beep();
      render();
    }).catch(function () {});
  }
  function startPolling() {
    clearInterval(S.timer);
    refresh();
    S.timer = setInterval(refresh, 3000);
  }

  $("login").addEventListener("submit", function (e) {
    e.preventDefault();
    var err = $("loginErr");
    err.hidden = true;
    fetch("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("pw").value })
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (res) {
      if (!res.ok) { err.textContent = res.d.error || "Kirib bo'lmadi."; err.hidden = false; return; }
      $("pw").value = "";
      S.seen = null;
      startPolling();
    }).catch(function () { err.textContent = "Internet bilan aloqa yo'q."; err.hidden = false; });
  });
  $("logout").addEventListener("click", function () {
    fetch("/api/logout", { method: "POST" }).then(function () { S.seen = null; showLogin(); });
  });

  document.querySelector(".stafftop").addEventListener("click", function (e) {
    var b = e.target.closest(".fchip");
    if (!b) return;
    S.filter = b.getAttribute("data-filter");
    document.querySelectorAll(".fchip").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    render();
  });
  $("soundBtn").addEventListener("click", function () {
    S.sound = !S.sound;
    this.textContent = "Ovoz: " + (S.sound ? "yoqilgan" : "o'chiq");
    if (S.sound) beep();
  });

  $("cards").addEventListener("click", function (e) {
    var chek = e.target.closest(".chek");
    if (chek) { printReceipt(chek.getAttribute("data-order")); return; }
    var b = e.target.closest(".act");
    if (!b || b.disabled) return;
    b.disabled = true;
    fetch("/api/staff/orders/" + encodeURIComponent(b.getAttribute("data-order")) + "/status", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dest: b.getAttribute("data-dest"), next: b.getAttribute("data-next") })
    }).then(function (r) {
      if (r.status === 401) { showLogin(); return; }
      if (r.status === 409) msg("Holat allaqachon o'zgargan.");
      return refresh();
    }).catch(function () { b.disabled = false; msg("Internet bilan aloqa yo'q."); });
  });

  function printReceipt(id) {
    var o = S.orders.filter(function (x) { return x.id === id; })[0];
    if (!o) return;
    var d = new Date(o.createdAt);
    var when = d.toLocaleString("uz-UZ", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    $("receipt").innerHTML =
      "<h2>ANOR KAFE</h2><div class=\"r\"><span>Stol " + esc(o.table) + "</span><span>№" + esc(o.no) + "</span></div>" +
      "<div>" + esc(when) + "</div><hr>" +
      o.items.map(function (i) {
        return '<div class="r"><span>' + i.q + " x " + esc(i.n) + "</span><span>" + fmt(i.q * i.p) + "</span></div>";
      }).join("") +
      '<hr><div class="r"><b>JAMI</b><b>' + fmt(o.total) + " so'm</b></div>" +
      (o.note ? "<hr><div>Izoh: " + esc(o.note) + "</div>" : "") +
      "<hr><div style=\"text-align:center\">Rahmat!</div>";
    document.body.classList.add("printing-receipt");
    var cleanup = function () { document.body.classList.remove("printing-receipt"); };
    window.addEventListener("afterprint", cleanup, { once: true });
    window.print();
    setTimeout(cleanup, 2000);
  }

  refresh().then(function () {
    if (!$("board").hidden) startPolling(); else showLogin();
  });
})();
