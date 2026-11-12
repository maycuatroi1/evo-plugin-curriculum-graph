// The page graph of curriculum-graph. It reaches the hub only through window.evo (the hub's UI kit 1, the bridge
// evo-plugin/1) and keeps everything as records of this plugin in the project (permission records:use):
//
// - collection "graph": the graph a harness pushed (schema curriculum-graph/1), as the record "current", which names
//   the build and how many parts it has, and the parts "<build>-000", "<build>-001", ... whose strings joined are the
//   graph's JSON. A record holds at most 64 KiB, so the graph comes in parts.
// - collection "threads": one record per problem or comment, its replies inside it. Every write names the revision it
//   read, so two people never overwrite each other: a 409 reads the record again and applies the change once more.
//
// sigma 3.0.2 draws the graph (vendor/, MIT). The page fetches nothing itself: its CSP has connect-src 'none'.
(function () {
  "use strict";
  var evo = window.evo;
  var REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var POLL_MS = 30000;

  // How each kind of relation and each colour slot looks. Labels come from the graph's legend.
  var KIND_STYLE = {
    prereq: { token: "e-neutral", type: "arrow", size: 1.3 },
    coreq: { token: "e-ink", type: "curve", size: 2.2, curvature: 0.45, both: true },
    handoff: { token: "s1", type: "arrow", size: 2.6 },
    support: { token: "s2", type: "arrow", size: 1.6 },
    merge: { token: "e-light", type: "arrow", size: 1.4 },
    overlap: { token: "critical", type: "curve", size: 1.8, curvature: 0.3, both: true },
    implicit: { token: "critical", type: "arrow", size: 1.5 },
  };
  var DEFAULT_KIND_LABEL = {
    prereq: "Tiên quyết", coreq: "Song hành", handoff: "Giao sản phẩm", support: "Hỗ trợ, khuyến nghị",
    merge: "Gộp môn", overlap: "Trùng nội dung", implicit: "Phụ thuộc ngầm",
  };
  var DEFAULT_CATEGORIES = [
    { key: "needs_decision", label: "Cần quyết định" },
    { key: "text_fix", label: "Sửa văn bản" },
    { key: "evidence", label: "Cần bằng chứng" },
    { key: "review", label: "Từ review" },
    { key: "viewer", label: "Người xem thêm" },
  ];
  var STATUS_CHIP = {
    "nguồn": ["chip", "Có trong nguồn"], "quan sát": ["chip note", "Review: quan sát"], "suy luận": ["chip note", "Review: suy luận"],
    "chưa kiểm chứng": ["chip warn", "Chưa kiểm chứng"], "cần quyết định": ["chip warn", "Cần quyết định"],
  };
  var ICON = {
    problem: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="5" cy="8.4" r="1" fill="currentColor"/></svg>',
    note: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 2h7v4.6H5L3 8.5V6.6H1.5z" fill="currentColor"/></svg>',
    done: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  /* ---------- helpers ---------- */
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === "class") el.className = v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (k === "checked" || k === "disabled") el[k] = !!v;
      else el.setAttribute(k, v === true ? "" : v);
    });
    var kids = Array.prototype.slice.call(arguments, 2);
    (function add(list) {
      list.forEach(function (kid) {
        if (kid == null || kid === false) return;
        if (Array.isArray(kid)) return add(kid);
        el.append(kid instanceof Node ? kid : String(kid));
      });
    })(kids);
    return el;
  }
  var T = {};
  var TOKENS = ["bg", "surface", "surface-2", "fg", "fg-2", "fg-3", "line", "dim", "dim-text", "s1", "s2", "s2-soft", "s3", "s4", "s5", "ghost", "e-neutral", "e-ink", "e-light", "critical", "good", "note", "accent"];
  function toHex(value) {
    // sigma reads hex and rgb(); a token may resolve to anything CSS knows (color-mix, oklch), so let a canvas say it.
    var ctx = toHex.ctx || (toHex.ctx = document.createElement("canvas").getContext("2d"));
    ctx.fillStyle = "#000"; ctx.fillStyle = value;
    return ctx.fillStyle;
  }
  function readTheme() {
    var cs = getComputedStyle(document.documentElement);
    TOKENS.forEach(function (k) { T[k] = toHex(cs.getPropertyValue("--cg-" + k).trim() || "#888"); });
  }
  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso); if (isNaN(d)) return "";
    var p = function (n) { return String(n).padStart(2, "0"); };
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function newKey(prefix) { return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }
  function failText(e) {
    var status = e && e.status;
    if (e && e.code === "not_granted") return "Dự án chưa cấp quyền records:use cho plugin này.";
    if (status === 403) { state.readOnly = true; return "Tài khoản này chỉ có quyền đọc trong dự án."; }
    if (status === 409) return "Có người vừa sửa mục này. Đã tải lại, thử lại lần nữa.";
    if (status === 413 || (e && e.code === "too_large")) return "Nội dung quá dài cho một mục (64 KiB). Rút gọn rồi thử lại.";
    return "Không lưu được: " + ((e && e.message) || "hub không trả lời") + ".";
  }

  /* ---------- records ---------- */
  function call(method, params) { return evo.call(method, params); }
  function getRecord(collection, key) {
    return call("records.get", { collection: collection, key: key }).catch(function (e) {
      if (e && e.status === 404) return null;
      throw e;
    });
  }
  function listAll(collection) {
    var out = [];
    function page(after) {
      var params = { collection: collection, limit: 200 };
      if (after) params.after = after;
      return call("records.list", params).then(function (res) {
        out = out.concat(res.records || []);
        return res.next_after ? page(res.next_after) : out;
      });
    }
    return page(null);
  }
  function loadGraph() {
    return getRecord("graph", "current").then(function (head) {
      if (!head) return null;
      var b = head.body || {};
      var keys = [];
      for (var i = 0; i < (b.parts || 0); i++) keys.push(b.build + "-" + String(i).padStart(3, "0"));
      return Promise.all(keys.map(function (k) { return getRecord("graph", k); })).then(function (parts) {
        if (parts.some(function (p) { return !p; })) throw new Error("graph build " + b.build + " is missing a part");
        var data = JSON.parse(parts.map(function (p) { return p.body.data; }).join(""));
        if (data.schema !== "curriculum-graph/1") throw new Error("graph schema " + data.schema + " is not curriculum-graph/1");
        data.pushedBy = head.updated_by; data.pushedAt = head.updated_at;
        return data;
      });
    });
  }

  /* ---------- boot ---------- */
  var stageMsg = document.getElementById("stageMsg");
  function showStageMsg(title, lines) {
    stageMsg.hidden = false;
    stageMsg.replaceChildren(h("div", null, h("strong", null, title), (lines || []).map(function (l) { return h("p", { class: "small" }, l); })));
  }
  if (!evo) { showStageMsg("Trang này chỉ chạy trong hub.", ["Mở nó từ menu của dự án trên hub."]); return; }
  evo.ready.then(function (context) {
    return loadGraph().then(function (data) {
      if (!data) {
        showStageMsg("Dự án chưa có dữ liệu graph.", ["Harness của dự án đẩy graph lên bằng lệnh:", h("code", null, "python3 scripts/build_curriculum_graph.py --push"), "rồi tải lại trang này."]);
        return;
      }
      stageMsg.hidden = true;
      start(data, context);
    });
  }).catch(function (e) {
    showStageMsg("Không tải được graph.", [(e && e.message) || String(e)]);
  });

  /* ---------- the page, once the graph is here ---------- */
  var state;
  function start(DATA, context) {
    var legend = DATA.legend || {};
    var NODES = new Map(DATA.nodes.map(function (n) { return [n.id, n]; }));
    var EDGES = new Map(DATA.edges.map(function (e) { return [e.id, e]; }));
    var GROUPS = new Map((legend.groups || []).map(function (g) { return [g.key, g]; }));
    var KIND = {};
    Object.keys(KIND_STYLE).forEach(function (k) {
      var l = (legend.kinds || {})[k] || {};
      KIND[k] = Object.assign({}, KIND_STYLE[k], { label: l.label || DEFAULT_KIND_LABEL[k], desc: l.desc || "" });
    });
    DATA.edges.forEach(function (e) { if (!KIND[e.kind]) KIND[e.kind] = { token: "e-neutral", type: "arrow", size: 1.3, label: e.kind, desc: "" }; });
    var CATEGORIES = legend.categories || DEFAULT_CATEGORIES;
    var CATEGORY = {}; CATEGORIES.forEach(function (c) { CATEGORY[c.key] = c.label; });
    if (!CATEGORY.viewer) { CATEGORIES = CATEGORIES.concat([{ key: "viewer", label: "Người xem thêm" }]); CATEGORY.viewer = "Người xem thêm"; }
    var CAT_ORDER = CATEGORIES.map(function (c) { return c.key; });
    var FOCUS = new Set(DATA.nodes.filter(function (n) { return n.group === legend.focusGroup; }).map(function (n) { return n.id; }));
    var NEAR_FOCUS = new Set(FOCUS);
    DATA.edges.forEach(function (e) { if (FOCUS.has(e.source)) NEAR_FOCUS.add(e.target); if (FOCUS.has(e.target)) NEAR_FOCUS.add(e.source); });
    var colLabel = function (s) { return (legend.columnLabels || {})[String(s)] || (legend.columnPrefix || "HK") + s; };
    var role = (context.viewer && context.viewer.role) || "";
    var login = (context.viewer && context.viewer.login) || "";

    document.getElementById("title").textContent = DATA.title || "Bản đồ môn học";
    document.getElementById("subtitle").textContent = DATA.subtitle || "";
    var focusOpt = document.querySelector('#scope option[value="focus"]');
    if (FOCUS.size && GROUPS.get(legend.focusGroup)) focusOpt.textContent = GROUPS.get(legend.focusGroup).label + " và môn liên quan";
    else focusOpt.remove();

    state = {
      selected: null, tab: "info", hovered: null, hoveredEdge: null,
      scope: "all", kinds: new Set(Object.keys(KIND)), ghosts: true,
      threads: new Map(), listFilter: "open", expanded: new Set(), clampOpen: new Set(),
      form: null, drafts: {}, busy: new Set(), errors: {},
      loaded: false, loadError: null, readOnly: role === "reader" || role === "viewer", noteDismissed: false,
    };
    var index = new Map();
    var vis = { nodes: new Set(), edges: new Set() };
    var focus = null;

    function targetLabel(t) {
      if (t === "program") return "Toàn chương trình";
      if (t.indexOf("node:") === 0) return t.slice(5);
      var e = EDGES.get(t.slice(5));
      return e ? e.source + " → " + e.target : t;
    }
    function nodeName(id) { var n = NODES.get(id); return n ? (n.nameVi || n.nameEn || "") : ""; }
    function selKey(s) { if (s === undefined) s = state.selected; return s ? s.kind + ":" + s.id : "program"; }

    /* ----- thread index ----- */
    function rebuildIndex() {
      index = new Map();
      state.threads.forEach(function (t) {
        (Array.isArray(t.targets) ? t.targets : []).forEach(function (tg) {
          if (!index.has(tg)) index.set(tg, []);
          index.get(tg).push(t);
        });
      });
    }
    function statsOf(list) {
      var s = { openProblems: 0, openNotes: 0, resolved: 0 };
      (list || []).forEach(function (t) {
        if (t.status === "resolved") s.resolved++;
        else if (t.type === "comment") s.openNotes++;
        else s.openProblems++;
      });
      s.open = s.openProblems + s.openNotes;
      return s;
    }
    function statsFor(target) { return statsOf(index.get(target)); }
    function sortThreads(list) {
      return Array.from(list).sort(function (a, b) {
        return ((a.status === "resolved") - (b.status === "resolved"))
          || (CAT_ORDER.indexOf(a.category || "viewer") - CAT_ORDER.indexOf(b.category || "viewer"))
          || String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id));
      });
    }

    /* ----- visibility and focus ----- */
    function computeVisibility() {
      var nodes = new Set(), edges = new Set(), issueNodes = null;
      if (state.scope === "issues") {
        issueNodes = new Set();
        index.forEach(function (list, tg) {
          if (!statsOf(list).open) return;
          if (tg.indexOf("node:") === 0) issueNodes.add(tg.slice(5));
          if (tg.indexOf("edge:") === 0) { var e = EDGES.get(tg.slice(5)); if (e) { issueNodes.add(e.source); issueNodes.add(e.target); } }
        });
      }
      DATA.nodes.forEach(function (n) {
        if (n.ghost && !state.ghosts) return;
        if (state.scope === "focus" && !NEAR_FOCUS.has(n.id)) return;
        if (issueNodes && !issueNodes.has(n.id)) return;
        nodes.add(n.id);
      });
      DATA.edges.forEach(function (e) { if (state.kinds.has(e.kind) && nodes.has(e.source) && nodes.has(e.target)) edges.add(e.id); });
      vis = { nodes: nodes, edges: edges };
    }
    function computeFocus() {
      var center = state.hovered || (state.selected && state.selected.kind === "node" ? state.selected.id : null);
      if (center && vis.nodes.has(center)) {
        var ns = new Set([center]), es = new Set();
        graph.forEachEdge(center, function (edge, a, s, t) { if (vis.edges.has(edge)) { es.add(edge); ns.add(s); ns.add(t); } });
        focus = { nodes: ns, edges: es };
      } else if (state.hoveredEdge || (state.selected && state.selected.kind === "edge")) {
        var id = state.hoveredEdge || state.selected.id; var e = EDGES.get(id);
        focus = e ? { nodes: new Set([e.source, e.target]), edges: new Set([id]) } : null;
      } else focus = null;
    }

    /* ----- graph ----- */
    var graph = new graphology.MultiDirectedGraph();
    function nodeSize(n) {
      if (n.ghost) return 5.5;
      if (n.credits == null) return 8;
      return Math.max(6.5, Math.min(14, 4 + n.credits * 1.7));
    }
    DATA.nodes.forEach(function (n) { graph.addNode(n.id, { x: n.x, y: n.y, size: nodeSize(n), label: n.id, type: "ring" }); });
    DATA.edges.forEach(function (e) {
      if (!NODES.has(e.source) || !NODES.has(e.target)) return;
      var k = KIND[e.kind];
      graph.addDirectedEdgeWithKey(e.id, e.source, e.target, { size: k.size, type: k.type, curvature: k.curvature || 0, label: e.label });
    });

    readTheme();
    var R = Sigma.rendering;
    var NodeRing = R.createNodeBorderProgram({ borders: [
      { size: { attribute: "ringSize", defaultValue: 0 }, color: { attribute: "ringColor" } },
      { size: { attribute: "gapSize", defaultValue: 0 }, color: { attribute: "gapColor" } },
      { size: { fill: true }, color: { attribute: "color" } },
    ] });
    function drawHover(ctx, data) {
      var n = NODES.get(data.key);
      var size = 12.5;
      var title = n ? (n.id + "  " + (n.nameVi || n.nameEn || "")).trim() : (data.label || "");
      ctx.font = "600 " + size + "px " + getComputedStyle(document.body).fontFamily;
      var w = ctx.measureText(title).width + 16, hh = size + 12;
      var x = data.x + data.size + 6; var y = data.y - hh / 2;
      if (x + w > ctx.canvas.width / (window.devicePixelRatio || 1) - 4) x = data.x - data.size - 6 - w;
      ctx.fillStyle = T.surface; ctx.strokeStyle = T.line; ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, hh, 6); else ctx.rect(x, y, w, hh);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = T.fg; ctx.fillText(title, x + 8, data.y + size / 3);
    }
    var container = document.getElementById("sigma");
    var codeFont = getComputedStyle(document.documentElement).getPropertyValue("--cg-font-code").trim() || "monospace";
    var uiFont = getComputedStyle(document.documentElement).getPropertyValue("--cg-font-ui").trim() || "sans-serif";
    var renderer = new Sigma(graph, container, {
      allowInvalidContainer: true,
      nodeProgramClasses: { ring: NodeRing },
      edgeProgramClasses: { arrow: R.EdgeArrowProgram, curve: R.EdgeCurveProgram },
      defaultNodeType: "ring", defaultEdgeType: "arrow",
      renderEdgeLabels: true, enableEdgeEvents: true, zIndex: true,
      labelFont: codeFont, labelWeight: "600", labelSize: 11,
      labelColor: { attribute: "labelColor", color: T.fg },
      edgeLabelFont: uiFont, edgeLabelSize: 11, edgeLabelWeight: "500",
      edgeLabelColor: { attribute: "labelColor", color: T["fg-2"] },
      labelRenderedSizeThreshold: 0, labelDensity: 1, labelGridCellSize: 40,
      stagePadding: 72, minCameraRatio: 0.15, maxCameraRatio: 3,
      defaultDrawNodeHover: drawHover,
      nodeReducer: nodeReducer, edgeReducer: edgeReducer,
    });

    function nodeFill(n) {
      if (n.ghost) return T.ghost;
      if (n.slotCourse) return T["s2-soft"];
      var g = GROUPS.get(n.group);
      return T[(g && g.color) || "s5"] || T.s5;
    }
    function nodeReducer(id, attr) {
      var r = Object.assign({}, attr);
      if (!vis.nodes.has(id)) { r.hidden = true; return r; }
      var n = NODES.get(id);
      r.color = nodeFill(n);
      r.labelColor = n.ghost ? T["fg-3"] : T.fg;
      r.forceLabel = true;
      var s = statsFor("node:" + id);
      var ring = s.openProblems ? T.critical : s.openNotes ? T.note : s.resolved ? T.good : null;
      if (ring) { r.ringColor = ring; r.ringSize = 0.3; r.gapColor = T.bg; r.gapSize = 0.14; }
      else if (n.slotCourse || n.ghost) { r.ringColor = n.ghost ? T["fg-3"] : T.s2; r.ringSize = 0.2; r.gapSize = 0; r.gapColor = T.bg; }
      if (focus && !focus.nodes.has(id)) { r.color = T.dim; r.ringColor = T.dim; r.labelColor = T["dim-text"]; r.zIndex = 0; }
      else if (focus) r.zIndex = 2;
      if (state.selected && state.selected.kind === "node" && state.selected.id === id) r.highlighted = true;
      return r;
    }
    function edgeReducer(id, attr) {
      var r = Object.assign({}, attr);
      if (!vis.edges.has(id)) { r.hidden = true; return r; }
      var e = EDGES.get(id); var k = KIND[e.kind];
      r.color = T[k.token];
      r.label = null;
      r.labelColor = T["fg-2"];
      var sel = state.selected && state.selected.kind === "edge" && state.selected.id === id;
      if (focus) {
        if (focus.edges.has(id)) { r.size = attr.size + 0.8; r.label = e.label; r.zIndex = 2; }
        else { r.color = T.dim; r.zIndex = 0; }
      }
      if (sel || state.hoveredEdge === id) { r.size = attr.size + 1.6; r.label = e.label; r.labelColor = T.fg; r.zIndex = 3; }
      return r;
    }

    /* ----- overlays: column bands, badges ----- */
    var stageEl = document.getElementById("stage");
    var bandsEl = document.getElementById("bands");
    var badgesEl = document.getElementById("badges");
    var colWidth = legend.columnWidth || 10;
    var bandEls = (DATA.columns || []).map(function (s, i) {
      var band = h("div", { class: "band" + (i % 2 ? " alt" : "") });
      var head = h("div", { class: "band-head" },
        h("strong", null, colLabel(s.semester)),
        h("span", null, s.credits + " TC, " + s.courses + " môn"),
        s.blank ? h("span", { class: "warn" }, s.blank + " môn chưa có TC") : null);
      bandsEl.append(band, head);
      return { s: s, band: band, head: head };
    });
    function placeBands() {
      var colW = 0;
      bandEls.forEach(function (b) {
        var c = b.s.x;
        var a = renderer.graphToViewport({ x: c - colWidth / 2, y: 0 }).x;
        var z = renderer.graphToViewport({ x: c + colWidth / 2, y: 0 }).x;
        b.band.style.left = a + "px"; b.band.style.width = Math.max(0, z - a) + "px";
        b.head.style.left = (a + z) / 2 + "px";
        colW = z - a;
      });
      stageEl.classList.toggle("narrow", colW < 110);
      stageEl.classList.toggle("tiny", colW < 64);
      stageEl.style.setProperty("--col-w", Math.max(40, colW - 6) + "px");
    }
    var badgeEls = new Map();
    function badgeFor(target) {
      var el = badgeEls.get(target);
      if (!el) {
        el = h("button", { type: "button", class: "badge" });
        el.addEventListener("click", function (ev) {
          ev.stopPropagation();
          if (target.indexOf("node:") === 0) select({ kind: "node", id: target.slice(5) }, "threads");
          else select({ kind: "edge", id: target.slice(5) });
        });
        badgesEl.append(el); badgeEls.set(target, el);
      }
      return el;
    }
    function placeBadges() {
      var seen = new Set();
      index.forEach(function (list, target) {
        if (target === "program") return;
        var s = statsOf(list);
        if (!s.open && !s.resolved) return;
        var x, y, faded = false, isEdge = false, d, v;
        if (target.indexOf("node:") === 0) {
          var id = target.slice(5);
          if (!vis.nodes.has(id)) return;
          d = renderer.getNodeDisplayData(id); if (!d) return;
          v = renderer.framedGraphToViewport(d); var rad = renderer.scaleSize(d.size);
          x = v.x + rad * 0.7; y = v.y - rad * 0.7 - 16;
          faded = !!focus && !focus.nodes.has(id);
        } else {
          var eid = target.slice(5); var e = EDGES.get(eid);
          if (!e || !vis.edges.has(eid)) return;
          var a = renderer.getNodeDisplayData(e.source), b = renderer.getNodeDisplayData(e.target);
          if (!a || !b) return;
          var p = renderer.framedGraphToViewport(a), q = renderer.framedGraphToViewport(b);
          var c = KIND[e.kind].curvature || 0;
          x = (p.x + q.x) / 2 + 0.5 * c * (q.y - p.y) - 8; y = (p.y + q.y) / 2 + 0.5 * c * (p.x - q.x) - 8;
          isEdge = true;
          // An edge's badge shows only while its edge is in focus: a node's ring and badge already say it has problems.
          if (!focus || !focus.edges.has(eid)) return;
        }
        var el = badgeFor(target);
        var kind = s.openProblems ? "problem" : s.openNotes ? "note" : "done";
        var label = [s.openProblems && s.openProblems + " vấn đề mở", s.openNotes && s.openNotes + " ghi chú mở", s.resolved && s.resolved + " đã giải quyết"].filter(Boolean).join(", ");
        var sig = kind + "|" + s.open + "|" + isEdge;
        if (el.dataset.sig !== sig) {
          el.dataset.sig = sig;
          el.className = "badge " + kind + (isEdge ? " edge" : "");
          el.innerHTML = ICON[kind] + (kind === "done" ? "" : "<span>" + s.open + "</span>");
        }
        el.setAttribute("aria-label", targetLabel(target) + ": " + label);
        el.title = targetLabel(target) + ": " + label;
        el.classList.toggle("faded", faded);
        el.style.transform = "translate(" + Math.round(x) + "px, " + Math.round(y) + "px)";
        el.hidden = false;
        seen.add(target);
      });
      badgeEls.forEach(function (el, t) { if (!seen.has(t)) el.hidden = true; });
    }
    renderer.on("afterRender", function () { placeBands(); placeBadges(); });

    /* ----- interactions ----- */
    function hoverRefresh() { computeFocus(); renderer.refresh({ skipIndexation: true }); }
    renderer.on("enterNode", function (ev) { state.hovered = ev.node; container.style.cursor = "pointer"; hoverRefresh(); });
    renderer.on("leaveNode", function () { state.hovered = null; container.style.cursor = ""; hoverRefresh(); });
    renderer.on("enterEdge", function (ev) { state.hoveredEdge = ev.edge; container.style.cursor = "pointer"; hoverRefresh(); });
    renderer.on("leaveEdge", function () { state.hoveredEdge = null; container.style.cursor = ""; hoverRefresh(); });
    renderer.on("clickNode", function (ev) { select({ kind: "node", id: ev.node }); });
    renderer.on("clickEdge", function (ev) { select({ kind: "edge", id: ev.edge }); });
    renderer.on("clickStage", function () { select(null); });

    function select(sel, tab, center) {
      var changed = selKey(sel) !== selKey();
      state.selected = sel;
      if (changed || tab) {
        state.tab = tab || (sel && sel.kind === "node" && state.tab === "threads" ? "threads" : "info");
        state.form = null;
      }
      computeFocus();
      renderer.refresh({ skipIndexation: true });
      renderPanel(changed);
      if (center && sel) centerOn(sel);
    }
    function centerOn(sel) {
      var id = sel.kind === "node" ? sel.id : (EDGES.get(sel.id) || {}).source;
      if (!id || !vis.nodes.has(id)) return;
      var d = renderer.getNodeDisplayData(id); if (!d) return;
      var cam = renderer.getCamera();
      cam.animate({ x: d.x, y: d.y, ratio: Math.min(cam.ratio, 0.8) }, { duration: REDUCED ? 0 : 450 });
    }
    function goto(sel, tab) {
      var scopeEl = document.getElementById("scope");
      if (sel && sel.kind === "node" && !vis.nodes.has(sel.id)) { state.scope = "all"; state.ghosts = true; scopeEl.value = "all"; buildLegend(); refreshAll(false); }
      if (sel && sel.kind === "edge" && !vis.edges.has(sel.id)) {
        var e = EDGES.get(sel.id);
        if (e) { state.scope = "all"; state.ghosts = true; state.kinds.add(e.kind); scopeEl.value = "all"; buildLegend(); refreshAll(false); }
      }
      select(sel, tab, true);
    }
    var anim = { duration: REDUCED ? 0 : 250 };
    document.getElementById("zin").onclick = function () { renderer.getCamera().animatedZoom(anim); };
    document.getElementById("zout").onclick = function () { renderer.getCamera().animatedUnzoom(anim); };
    document.getElementById("zfit").onclick = function () { renderer.getCamera().animatedReset(anim); };

    var q = document.getElementById("q");
    document.getElementById("codes").append.apply(document.getElementById("codes"),
      DATA.nodes.filter(function (n) { return !n.ghost; }).map(function (n) { return h("option", { value: n.id, label: n.nameVi || n.nameEn }); }));
    function runSearch() {
      var v = q.value.trim().toLowerCase(); if (!v) return;
      var n = DATA.nodes.find(function (n) { return n.id.toLowerCase() === v; })
        || DATA.nodes.find(function (n) { return n.id.toLowerCase().indexOf(v) === 0; })
        || DATA.nodes.find(function (n) { return (n.nameVi || "").toLowerCase().indexOf(v) >= 0 || (n.nameEn || "").toLowerCase().indexOf(v) >= 0; });
      if (n) goto({ kind: "node", id: n.id });
    }
    q.addEventListener("change", runSearch);
    q.addEventListener("keydown", function (e) { if (e.key === "Enter") runSearch(); });
    document.getElementById("scope").addEventListener("change", function (e) { state.scope = e.target.value; refreshAll(false); });

    function buildLegend() {
      var body = document.getElementById("legendBody");
      var kinds = Object.keys(KIND).filter(function (k) { return DATA.edges.some(function (e) { return e.kind === k; }); }).map(function (k) {
        var v = KIND[k];
        var style = "color: var(--cg-" + v.token + "); border-top-color: var(--cg-" + v.token + ");" +
          (v.type === "curve" ? " border-color: var(--cg-" + v.token + "); border-left-color: transparent; border-right-color: transparent;" : "");
        return h("li", null, h("label", null,
          h("input", { type: "checkbox", checked: state.kinds.has(k), onchange: function (ev) { if (ev.target.checked) state.kinds.add(k); else state.kinds.delete(k); refreshAll(false); } }),
          h("span", { class: "swatch-line " + (v.type === "curve" ? "curve" : "arrow"), style: style }),
          h("span", null, v.label, v.desc ? h("span", { class: "muted" }, ", " + v.desc) : null)));
      });
      var groups = (legend.groups || []).map(function (g) { return h("li", null, h("span", { class: "dot", style: "background: var(--cg-" + (g.color || "s5") + ")" }), g.label); });
      if (DATA.nodes.some(function (n) { return n.slotCourse; })) groups.push(h("li", null, h("span", { class: "dot", style: "background: var(--cg-s2-soft); box-shadow: inset 0 0 0 2px var(--cg-s2)" }), legend.slotLabel || "Slot lựa chọn"));
      if (DATA.nodes.some(function (n) { return n.ghost; })) groups.push(h("li", null, h("label", null,
        h("input", { type: "checkbox", checked: state.ghosts, onchange: function (ev) { state.ghosts = ev.target.checked; refreshAll(false); } }),
        h("span", { class: "dot", style: "background: var(--cg-ghost); box-shadow: inset 0 0 0 2px var(--cg-fg-3)" }), legend.ghostLabel || "Mã ngoài danh mục")));
      var rings = [["critical", "Có vấn đề mở"], ["note", "Có ghi chú mở, chưa có vấn đề"], ["good", "Đã giải quyết hết"]]
        .map(function (r) { return h("li", null, h("span", { class: "ring", style: "border-color: var(--cg-" + r[0] + ")" }), r[1]); });
      body.replaceChildren(
        h("h3", null, "Quan hệ, bấm để ẩn hoặc hiện"), h("ul", null, kinds),
        h("h3", null, legend.groupTitle || "Nhóm môn"), h("ul", null, groups),
        h("h3", null, "Vòng quanh môn"), h("ul", null, rings),
        h("p", { class: "muted small", style: "margin:0" }, "Cỡ nút theo số tín chỉ. Bấm môn hoặc đường nối để xem chi tiết và ghi chú."));
    }
    document.getElementById("legend").open = false;

    function refreshAll(panelToo) {
      rebuildIndex(); computeVisibility(); computeFocus();
      renderer.refresh({ skipIndexation: true });
      renderTally();
      if (panelToo !== false) renderPanel(false);
    }
    function renderTally() {
      var p = 0, n = 0, r = 0;
      state.threads.forEach(function (t) { if (t.status === "resolved") r++; else if (t.type === "comment") n++; else p++; });
      var go = function (filter) { return function () { state.listFilter = filter; select(null); }; };
      document.getElementById("tally").replaceChildren(
        h("button", { type: "button", onclick: go("open") }, h("span", { class: "dot", style: "background: var(--cg-critical)" }), h("b", null, p), "vấn đề mở"),
        h("button", { type: "button", onclick: go("open") }, h("span", { class: "dot", style: "background: var(--cg-note)" }), h("b", null, n), "ghi chú mở"),
        h("button", { type: "button", onclick: go("resolved") }, h("span", { class: "dot", style: "background: var(--cg-good)" }), h("b", null, r), "đã giải quyết"));
      var msg = !state.loaded ? (state.loadError ? "Không đọc được vấn đề và ghi chú: " + state.loadError : "Đang tải vấn đề và ghi chú...") : null;
      document.getElementById("dbNote").hidden = !msg || state.noteDismissed;
      document.getElementById("dbNoteText").textContent = msg || "";
    }

    /* ----- panel ----- */
    var panel = document.getElementById("panel");
    function renderPanel(reset) {
      var ae = document.activeElement;
      var keep = ae && ae.id && panel.contains(ae) ? { id: ae.id, s: ae.selectionStart, e: ae.selectionEnd } : null;
      var top = panel.scrollTop;
      var pane;
      if (state.selected && state.selected.kind === "node" && NODES.has(state.selected.id)) pane = nodePane(NODES.get(state.selected.id));
      else if (state.selected && state.selected.kind === "edge" && EDGES.has(state.selected.id)) pane = edgePane(EDGES.get(state.selected.id));
      else pane = overviewPane();
      panel.replaceChildren(pane);
      panel.scrollTop = reset ? 0 : top;
      if (keep) {
        var el = document.getElementById(keep.id);
        if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(keep.s, keep.e); } catch (_) { /* not a text field */ } }
      }
    }
    function backCrumb() { return h("button", { type: "button", class: "crumb", onclick: function () { select(null); } }, "← Tổng quan chương trình"); }
    function nodeChips(n) {
      var g = GROUPS.get(n.group);
      var out = [h("span", { class: "chip strong" }, (g && g.label) || n.group || "Môn học")];
      if (n.semester && !n.ghost) out.push(h("span", { class: "chip" }, colLabel(n.semester)));
      if (!n.ghost) out.push(n.credits == null ? h("span", { class: "chip warn" }, "Chưa có số TC") : h("span", { class: "chip" }, n.credits + " TC"));
      if (n.change) out.push(h("span", { class: "chip note" }, n.change.change));
      if (n.ghost === "missing") out.push(h("span", { class: "chip warn" }, "Không có trong danh mục"));
      if (n.ghost === "merged") out.push(h("span", { class: "chip" }, "Không còn trong danh mục"));
      return h("div", { class: "chips" }, out);
    }
    function nodePane(n) {
      var threads = sortThreads(index.get("node:" + n.id) || []);
      var edgeThreads = [];
      graph.forEachEdge(n.id, function (edge) {
        (index.get("edge:" + edge) || []).forEach(function (t) { if (threads.indexOf(t) < 0 && edgeThreads.indexOf(t) < 0) edgeThreads.push(t); });
      });
      var s = statsOf(threads);
      var tabs = [["info", "Thông tin"]];
      if (n.syllabus) tabs.push(["syllabus", "Đề cương"]);
      tabs.push(["threads", "Vấn đề, ghi chú"]);
      if (!tabs.some(function (t) { return t[0] === state.tab; })) state.tab = "info";
      var tabBar = h("div", { class: "tabs", role: "tablist" }, tabs.map(function (t) {
        return h("button", { type: "button", role: "tab", "aria-selected": String(state.tab === t[0]), onclick: function () { state.tab = t[0]; state.form = null; renderPanel(false); } },
          t[1], t[0] === "threads" && s.open ? h("span", { class: "count" }, s.open) : null);
      }));
      var content = state.tab === "syllabus" ? syllabusTab(n) : state.tab === "threads" ? threadsTab(threads, edgeThreads, "node:" + n.id) : infoTab(n);
      return h("div", { class: "pane" }, backCrumb(),
        h("div", { class: "eyebrow" }, h("span", { class: "code" }, n.id), s.openProblems ? h("span", { class: "chip warn" }, s.openProblems + " vấn đề mở") : null),
        h("h2", null, n.nameVi || n.nameEn || n.id),
        n.nameVi && n.nameEn ? h("p", { class: "muted" }, n.nameEn) : null,
        nodeChips(n), tabBar, content);
    }
    function relList(n) {
      var groups = {};
      graph.forEachEdge(n.id, function (edge, a, src, dst) {
        var e = EDGES.get(edge); var out = src === n.id;
        (groups[e.kind] = groups[e.kind] || []).push({ e: e, out: out, other: out ? dst : src });
      });
      var blocks = Object.keys(KIND).filter(function (k) { return groups[k]; }).map(function (k) {
        return h("div", { class: "rel-group" }, h("h3", null, KIND[k].label), groups[k].map(function (g) {
          var e = g.e, st = statsFor("edge:" + e.id), other = g.other, otherNode = NODES.get(other);
          return h("div", { class: "rel" },
            h("span", { class: "dir", "aria-label": g.out ? "đi tới" : "đến từ" }, KIND[k].both ? "↔" : g.out ? "→" : "←"),
            h("button", { type: "button", class: "go", onclick: function () { goto({ kind: "node", id: other }); } },
              h("span", { class: "code" }, other), " ", h("span", { class: "name" }, nodeName(other) || (otherNode && otherNode.ghost ? "mã ngoài danh mục" : "")),
              e.label && k !== "prereq" && k !== "coreq" ? h("span", { class: "muted small" }, ", " + e.label) : null,
              e.alternatives ? h("span", { class: "muted small" }, ", một trong " + e.alternatives) : null),
            st.open ? h("span", { class: "chip warn" }, st.open) : null,
            h("button", { type: "button", class: "why", onclick: function () { select({ kind: "edge", id: e.id }); } }, "Căn cứ"));
        }));
      });
      return blocks.length ? blocks : [h("p", { class: "muted" }, "Không có quan hệ nào trong dữ liệu.")];
    }
    function infoTab(n) {
      var facts = [];
      var add = function (k, v) { if (v) facts.push(h("dt", null, k), h("dd", null, v)); };
      if (n.ghost === "missing") add("Ghi chú", "Mã này được ghi làm tiên quyết nhưng không có trong danh mục học phần.");
      if (n.ghost === "merged") add("Ghi chú", "Môn cũ: " + ((n.change && n.change.change) || "đã gộp") + ".");
      if (!n.ghost) add("Tiên quyết", n.prereqText || "Không có");
      add("Quy tắc", n.prereqRule);
      if (n.syllabus && n.syllabus.info) Object.keys(n.syllabus.info).forEach(function (k) { if (["Số tín chỉ", "Học kỳ", "Tiên quyết"].indexOf(k) < 0) add(k, n.syllabus.info[k]); });
      if (n.change) add("Thay đổi", n.change.change + ". " + (n.change.note || ""));
      var t1 = n.table1;
      return h("div", { class: "pane flat" },
        facts.length ? h("dl", { class: "facts" }, facts) : null,
        h("div", { class: "block" }, relList(n)),
        t1 ? h("div", { class: "block" }, h("h3", null, t1.source || "Năng lực"),
          h("dl", { class: "facts" },
            h("dt", null, "Kiến thức"), h("dd", null, t1.knowledge),
            h("dt", null, "Kỹ năng"), h("dd", null, t1.skills),
            h("dt", null, "Năng lực"), h("dd", null, t1.outcome),
            h("dt", null, "Phụ thuộc"), h("dd", null, t1.deps))) : null,
        n.sources && n.sources.length ? h("p", { class: "source" }, "Nguồn: " + n.sources.join(", ") + ".") : null);
    }
    function syllabusTab(n) {
      var s = n.syllabus;
      var total = s.assessment.reduce(function (a, x) { return a + (x.weight || 0); }, 0) || 100;
      return h("div", { class: "pane flat" },
        h("div", { class: "block" }, h("h3", null, "Mô tả"), h("p", null, s.description)),
        h("div", { class: "block" }, h("h3", null, "Chuẩn đầu ra (" + s.clos.length + " CLO)"),
          s.clos.map(function (c) { return h("div", { class: "clo" }, h("div", { class: "chips" }, h("span", { class: "chip strong" }, c.id), c.plos.map(function (p) { return h("span", { class: "chip" }, p); })), h("span", null, c.text)); })),
        h("div", { class: "block" }, h("h3", null, s.planTitle || "Kế hoạch giảng dạy"),
          h("div", { class: "scroll-x" }, h("table", { class: "weeks" },
            h("thead", null, h("tr", null, h("th", null, "Tuần"), h("th", null, "Nội dung"), h("th", null, "Hoạt động"))),
            h("tbody", null, s.weeks.map(function (w) { return h("tr", null, h("td", null, w.n), h("td", null, w.content), h("td", null, w.activity)); }))))),
        h("div", { class: "block" }, h("h3", null, s.assessTitle || "Đánh giá"),
          h("div", { class: "weights", role: "img", "aria-label": s.assessment.map(function (a) { return a.text; }).join("; ") },
            s.assessment.map(function (a) { return h("span", { style: "flex: " + ((a.weight || 0) / total), title: a.text }); })),
          h("ul", { class: "plain" }, s.assessment.map(function (a) { return h("li", null, a.text); }))),
        s.materials.length ? h("div", { class: "block" }, h("h3", null, "Học liệu"), h("ul", { class: "plain" }, s.materials.map(function (m) { return h("li", null, m); }))) : null,
        s.tech.length ? h("div", { class: "block" }, h("h3", null, "Công nghệ"), h("ul", { class: "plain" }, s.tech.map(function (m) { return h("li", null, m); }))) : null,
        h("p", { class: "source" }, "Nguồn: " + s.source + "."));
    }
    function edgePane(e) {
      var k = KIND[e.kind];
      var threads = sortThreads(index.get("edge:" + e.id) || []);
      var chip = STATUS_CHIP[e.status] || ["chip", e.status || ""];
      var endpoint = function (id) { return h("button", { type: "button", class: "chip", onclick: function () { goto({ kind: "node", id: id }); } }, h("span", { class: "code" }, id), nodeName(id)); };
      return h("div", { class: "pane" }, backCrumb(),
        h("div", { class: "eyebrow" }, h("span", { class: "chip strong" }, k.label), chip[1] ? h("span", { class: chip[0] }, chip[1]) : null),
        h("h2", null, h("span", { class: "code" }, e.source), k.both ? " ↔ " : " → ", h("span", { class: "code" }, e.target)),
        e.label ? h("p", { class: "muted" }, e.label) : null,
        h("div", { class: "chips" }, endpoint(e.source), endpoint(e.target)),
        e.alternatives ? h("p", { class: "small muted" }, "Tiên quyết ghi dạng lựa chọn: một trong " + e.alternatives + ".") : null,
        e.evidence ? h("div", { class: "block" }, h("h3", null, "Căn cứ"), h("blockquote", { class: "quote" }, e.evidence)) : null,
        threadsTab(threads, [], "edge:" + e.id));
    }
    function threadsTab(threads, related, target) {
      var parts = [];
      if (threads.length) threads.forEach(function (t) { parts.push(threadCard(t)); });
      else parts.push(h("p", { class: "empty" }, state.loaded ? "Chưa có vấn đề hoặc ghi chú gắn trực tiếp ở đây. Thêm cái đầu tiên ở khung bên dưới." : "Đang tải vấn đề và ghi chú..."));
      if (related.length) parts.push(h("div", { class: "list-group" }, h("h3", null, h("span", null, "Trên các quan hệ của môn"), h("span", null, related.length)), related.map(listItem)));
      parts.push(composer(target));
      return h("div", { class: "pane flat" }, parts);
    }
    function chipsFor(t) {
      var out = [h("span", { class: "chip " + (t.type === "comment" ? "note" : "warn") }, t.type === "comment" ? "Ghi chú" : "Vấn đề")];
      if (t.backlog && t.backlog.id) out.push(h("span", { class: "chip code" }, t.backlog.id));
      else if (t.source && t.source !== "viewer") out.push(h("span", { class: "chip code" }, t.id));
      if (t.category && t.category !== "viewer") out.push(h("span", { class: "chip" }, CATEGORY[t.category] || t.category));
      if (t.status === "resolved") out.push(h("span", { class: "chip ok" }, "✓ Đã giải quyết"));
      return h("div", { class: "chips" }, out);
    }
    function targetChips(t, current) {
      var tg = (t.targets || []).filter(function (x) { return x !== current; });
      if (!tg.length) return null;
      var shown = tg.slice(0, 8);
      return h("div", { class: "chips" }, h("span", { class: "small muted" }, current ? "Cũng gắn với:" : "Gắn với:"),
        shown.map(function (x) {
          return h("button", { type: "button", class: "chip", onclick: function () { if (x === "program") select(null); else goto({ kind: x.slice(0, 4), id: x.slice(5) }); } }, targetLabel(x));
        }),
        tg.length > shown.length ? h("span", { class: "chip" }, "+" + (tg.length - shown.length)) : null);
    }
    function who(name) { return name ? (name === login ? "bạn" : name) : "người xem"; }
    function threadCard(t, current) {
      if (current === undefined) current = selKey();
      var open = t.status !== "resolved";
      var replies = t.replies || [];
      var longBody = (t.body || "").length > 260;
      var unclamped = state.clampOpen.has(t.id);
      var origin = t.source && t.source !== "viewer" ? (t.origin || t.ref || t.source) : null;
      var form = state.form && state.form.id === t.id ? state.form.mode : null;
      var busy = state.busy.has(t.id);
      var off = !canWrite();
      return h("article", { class: "thread is-" + (t.type === "comment" ? "comment" : "problem") + " is-" + (open ? "open" : "resolved") },
        chipsFor(t),
        h("h4", null, t.title || "(không có tiêu đề)"),
        t.body ? h("p", { class: "body" + (longBody && !unclamped ? " clamp" : "") }, t.body) : null,
        longBody ? h("button", { type: "button", class: "more", onclick: function () { if (unclamped) state.clampOpen.delete(t.id); else state.clampOpen.add(t.id); renderPanel(false); } }, unclamped ? "Thu gọn" : "Xem thêm") : null,
        targetChips(t, current),
        h("p", { class: "meta" },
          origin ? "Nguồn: " + origin : "Tạo bởi " + who(t.author || t._createdBy) + (t.createdAt ? ", " + fmtDate(t.createdAt) : ""),
          !open && t.resolvedAt ? ". Giải quyết bởi " + who(t.resolvedBy) + ", " + fmtDate(t.resolvedAt) : ""),
        replies.length ? h("ol", { class: "replies" }, replies.map(function (r) {
          return h("li", null,
            h("span", { class: "who" }, who(r.by) + ", " + fmtDate(r.at),
              r.action === "resolve" ? h("span", { class: "act-resolve" }, ", đánh dấu đã giải quyết") : r.action === "reopen" ? h("span", { class: "act-reopen" }, ", mở lại") : null),
            r.body ? h("span", { class: "text" }, r.body) : null);
        })) : null,
        form ? inlineForm(t, form) : h("div", { class: "actions" },
          h("button", { type: "button", class: "btn", disabled: off || busy, onclick: function () { openForm(t.id, "reply"); } }, "Trả lời"),
          open
            ? h("button", { type: "button", class: "btn resolve", disabled: off || busy, onclick: function () { openForm(t.id, "resolve"); } }, "Đánh dấu đã giải quyết")
            : h("button", { type: "button", class: "btn reopen", disabled: off || busy, onclick: function () { openForm(t.id, "reopen"); } }, "Mở lại")),
        state.errors[t.id] ? h("p", { class: "err" }, state.errors[t.id]) : null);
    }
    function openForm(id, mode) {
      state.form = { id: id, mode: mode }; renderPanel(false);
      var el = document.getElementById("f-" + id); if (el) el.focus();
    }
    function inlineForm(t, mode) {
      var key = t.id + ":" + mode;
      var label = { reply: "Trả lời", resolve: "Cách giải quyết (không bắt buộc)", reopen: "Lý do mở lại (không bắt buộc)" }[mode];
      var submit = { reply: "Gửi trả lời", resolve: "Xác nhận đã giải quyết", reopen: "Mở lại" }[mode];
      var busy = state.busy.has(t.id);
      return h("form", { class: "form", onsubmit: function (ev) { ev.preventDefault(); act(t, mode); } },
        h("label", { for: "f-" + t.id, class: "small muted" }, label),
        h("textarea", { id: "f-" + t.id, value: state.drafts[key] || "", maxlength: "4000", oninput: function (ev) { state.drafts[key] = ev.target.value; } }),
        h("div", { class: "actions" },
          h("button", { type: "submit", class: "btn " + (mode === "resolve" ? "resolve" : "primary"), disabled: busy }, busy ? "Đang lưu..." : submit),
          h("button", { type: "button", class: "btn", onclick: function () { state.form = null; renderPanel(false); } }, "Huỷ")));
    }
    function listItem(t) {
      var expanded = state.expanded.has(t.id);
      var tg = t.targets || [];
      var dot = t.status === "resolved" ? "good" : t.type === "comment" ? "note" : "critical";
      return h("div", { class: "item is-" + (t.status === "resolved" ? "resolved" : "open") },
        h("button", { type: "button", "aria-expanded": String(expanded), onclick: function () { if (expanded) state.expanded.delete(t.id); else state.expanded.add(t.id); renderPanel(false); } },
          h("div", { class: "chips" }, h("span", { class: "dot", style: "background: var(--cg-" + dot + "); margin-top: 6px" }),
            (t.backlog && t.backlog.id) || (t.source && t.source !== "viewer") ? h("span", { class: "chip code" }, (t.backlog && t.backlog.id) || t.id) : null,
            h("span", { class: "chip" }, tg.slice(0, 3).map(targetLabel).join(", ") + (tg.length > 3 ? " +" + (tg.length - 3) : ""))),
          h("span", { class: "t" }, t.title || "(không có tiêu đề)")),
        expanded ? threadCard(t, null) : null);
    }
    function canWrite() { return state.loaded && !state.readOnly; }
    function composer(target) {
      var d = state.drafts.new || (state.drafts.new = { type: "problem", title: "", body: "" });
      var where = target === "program" ? "toàn chương trình" : targetLabel(target);
      var busy = state.busy.has("new");
      var reason = !state.loaded ? "Đang tải vấn đề và ghi chú..." : state.readOnly ? "Bạn đang có quyền đọc. Cần quyền ghi trong dự án để thêm, trả lời hoặc giải quyết." : null;
      return h("form", { class: "composer form", onsubmit: function (ev) { ev.preventDefault(); createThread(target); } },
        h("h3", null, "Thêm vào " + where),
        h("div", { class: "seg", role: "radiogroup", "aria-label": "Loại" },
          [["problem", "Vấn đề"], ["comment", "Ghi chú"]].map(function (o) {
            return h("label", null, h("input", { type: "radio", name: "new-type", id: "new-type-" + o[0], value: o[0], checked: d.type === o[0], onchange: function () { d.type = o[0]; renderPanel(false); } }), o[1]);
          })),
        h("input", { type: "text", id: "new-title", placeholder: d.type === "problem" ? "Vấn đề là gì? Ví dụ: tuần 4 dồn quá nhiều chủ đề" : "Tiêu đề ghi chú", maxlength: "160", value: d.title, oninput: function (ev) { d.title = ev.target.value; }, "aria-label": "Tiêu đề" }),
        h("textarea", { id: "new-body", placeholder: "Chi tiết, căn cứ, đề xuất sửa", maxlength: "4000", value: d.body, oninput: function (ev) { d.body = ev.target.value; }, "aria-label": "Nội dung" }),
        state.errors.new ? h("p", { class: "err" }, state.errors.new) : null,
        reason ? h("p", { class: "small muted" }, reason) : null,
        h("div", { class: "actions" }, h("button", { type: "submit", class: "btn primary", disabled: busy || !canWrite() }, busy ? "Đang lưu..." : d.type === "problem" ? "Thêm vấn đề" : "Thêm ghi chú")));
    }
    function overviewPane() {
      var all = sortThreads(state.threads.values());
      var p = 0, n = 0, r = 0;
      all.forEach(function (t) { if (t.status === "resolved") r++; else if (t.type === "comment") n++; else p++; });
      var pr = DATA.program || {};
      var list = all.filter(function (t) { return state.listFilter === "all" || (state.listFilter === "open" ? t.status !== "resolved" : t.status === "resolved"); });
      var groups = CAT_ORDER.map(function (c) { return [c, list.filter(function (t) { return (t.category || "viewer") === c; })]; }).filter(function (g) { return g[1].length; });
      var seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Lọc danh sách" },
        [["open", "Đang mở"], ["resolved", "Đã giải quyết"], ["all", "Tất cả"]].map(function (o) {
          return h("label", null, h("input", { type: "radio", name: "list-filter", id: "lf-" + o[0], value: o[0], checked: state.listFilter === o[0], onchange: function () { state.listFilter = o[0]; renderPanel(false); } }), o[1]);
        }));
      var listBody;
      if (!state.loaded && !all.length) listBody = h("p", { class: "empty" }, state.loadError ? "Không đọc được vấn đề và ghi chú: " + state.loadError : "Đang tải vấn đề và ghi chú. Danh sách sẽ hiện ở đây, nhóm theo việc cần làm.");
      else if (!all.length) listBody = h("p", { class: "empty" }, "Chưa có vấn đề hoặc ghi chú nào. Bấm vào một môn hoặc đường nối trên graph để thêm cái đầu tiên.");
      else if (!groups.length) listBody = h("p", { class: "empty" }, state.listFilter === "resolved" ? "Chưa có mục nào được giải quyết." : "Không còn mục nào đang mở.");
      else listBody = groups.map(function (g) { return h("div", { class: "list-group" }, h("h3", null, h("span", null, CATEGORY[g[0]] || g[0]), h("span", null, g[1].length)), g[1].map(listItem)); });
      var built = DATA.builtAt ? DATA.builtAt.split("-").reverse().join("/") : "";
      return h("div", { class: "pane" },
        h("div", { class: "eyebrow" }, DATA.badge ? h("span", { class: "chip strong" }, DATA.badge) : null,
          h("span", { class: "chip" }, "Dựng từ " + (DATA.commit ? "commit " + DATA.commit + ", " : "") + "ngày " + built)),
        h("h2", null, pr.title || DATA.title || "Chương trình đào tạo"),
        pr.summary ? h("p", { class: "muted" }, pr.summary) : null,
        h("div", { class: "stats" },
          h("div", { class: "stat" }, h("b", null, p), h("span", null, h("span", { class: "dot", style: "background: var(--cg-critical)" }), "vấn đề mở")),
          h("div", { class: "stat" }, h("b", null, n), h("span", null, h("span", { class: "dot", style: "background: var(--cg-note)" }), "ghi chú mở")),
          h("div", { class: "stat" }, h("b", null, r), h("span", null, h("span", { class: "dot", style: "background: var(--cg-good)" }), "đã giải quyết"))),
        seg, listBody,
        composer("program"),
        h("div", { class: "block" }, h("h3", null, "Cách dùng"),
          h("ul", { class: "plain small muted" },
            h("li", null, "Rê chuột lên môn để thấy các môn nối với nó. Bấm để mở thông tin, đề cương và ghi chú."),
            h("li", null, "Bấm vào đường nối để xem căn cứ của quan hệ."),
            h("li", null, "Chấm đỏ trên graph là số vấn đề mở, chấm tím là ghi chú mở, chấm xanh là đã giải quyết hết. Bấm chấm để mở thẳng phần ghi chú."),
            (DATA.notes || []).map(function (t) { return h("li", null, t); }))),
        DATA.sourceNote ? h("p", { class: "source" }, DATA.sourceNote) : null,
        DATA.pushedBy ? h("p", { class: "source" }, "Graph đẩy lên bởi " + DATA.pushedBy + ", " + fmtDate(DATA.pushedAt) + ".") : null);
    }

    /* ----- threads in records ----- */
    function fromRecord(rec) {
      var t = Object.assign({}, rec.body || {});
      t.id = rec.key; t._revision = rec.revision; t._createdBy = rec.created_by;
      if (!t.createdAt) t.createdAt = null;
      return t;
    }
    var loading = null;
    function loadThreads() {
      if (loading) return loading;
      loading = listAll("threads").then(function (records) {
        state.threads = new Map(records.map(function (r) { return [r.key, fromRecord(r)]; }));
        state.loaded = true; state.loadError = null;
        refreshAll();
      }).catch(function (e) {
        state.loadError = (e && e.message) || String(e);
        if (e && e.code === "not_granted") state.loadError = "dự án chưa cấp quyền records:use cho plugin này";
        refreshAll();
      }).then(function () { loading = null; });
      return loading;
    }
    function nowIso() { return new Date().toISOString(); }
    function mutate(id, change, attempt) {
      attempt = attempt || 0;
      return getRecord("threads", id).then(function (rec) {
        if (!rec) throw Object.assign(new Error("mục này đã bị xoá"), { status: 404 });
        var body = change(JSON.parse(JSON.stringify(rec.body || {})));
        return call("records.put", { collection: "threads", key: id, body: body, revision: rec.revision }).catch(function (e) {
          if (e && e.status === 409 && attempt < 2) return mutate(id, change, attempt + 1);
          throw e;
        });
      }).then(function (saved) {
        if (saved && saved.key) state.threads.set(saved.key, fromRecord(saved));
      });
    }
    function createThread(target) {
      var d = state.drafts.new;
      if (!d || !d.title.trim()) { state.errors.new = "Nhập tiêu đề trước khi thêm."; renderPanel(false); return; }
      if (!canWrite()) return;
      state.busy.add("new"); delete state.errors.new; renderPanel(false);
      var key = newKey("v");
      var body = { type: d.type, title: d.title.trim().slice(0, 160), body: d.body.trim().slice(0, 4000), targets: [target], status: "open", source: "viewer", category: "viewer", author: login, createdAt: nowIso(), replies: [] };
      call("records.put", { collection: "threads", key: key, body: body, revision: 0 }).then(function (saved) {
        state.threads.set(saved.key, fromRecord(saved));
        state.drafts.new = { type: d.type, title: "", body: "" };
        evo.toast(d.type === "problem" ? "Đã thêm vấn đề" : "Đã thêm ghi chú", "success").catch(function () {});
      }).catch(function (e) { state.errors.new = failText(e); }).then(function () {
        state.busy.delete("new"); refreshAll();
      });
    }
    function act(t, mode) {
      if (!canWrite()) return;
      var key = t.id + ":" + mode;
      var text = (state.drafts[key] || "").trim().slice(0, 4000);
      if (mode === "reply" && !text) { state.errors[t.id] = "Nhập nội dung trả lời."; renderPanel(false); return; }
      state.busy.add(t.id); delete state.errors[t.id]; renderPanel(false);
      var at = nowIso();
      mutate(t.id, function (body) {
        body.replies = (body.replies || []).concat([{ id: newKey("r"), by: login, at: at, action: mode, body: text }]);
        if (mode === "resolve") { body.status = "resolved"; body.resolvedBy = login; body.resolvedAt = at; body.resolution = text; }
        if (mode === "reopen") { body.status = "open"; body.reopenedBy = login; body.reopenedAt = at; }
        return body;
      }).then(function () {
        delete state.drafts[key]; state.form = null;
        evo.toast({ reply: "Đã gửi trả lời", resolve: "Đã đánh dấu đã giải quyết", reopen: "Đã mở lại" }[mode], "success").catch(function () {});
      }).catch(function (e) {
        state.errors[t.id] = failText(e);
        if (e && e.status === 409) loadThreads();
      }).then(function () { state.busy.delete(t.id); refreshAll(); });
    }

    /* ----- theme, deep link, polling ----- */
    function applyTheme() {
      readTheme();
      renderer.setSetting("labelColor", { attribute: "labelColor", color: T.fg });
      renderer.refresh({ skipIndexation: true });
    }
    evo.on("theme", function () { requestAnimationFrame(applyTheme); });
    document.getElementById("dbNoteClose").onclick = function () { state.noteDismissed = true; renderTally(); };
    buildLegend();
    refreshAll();
    var sub = context.location && context.location.path ? decodeURIComponent(String(context.location.path).replace(/^\/+/, "")) : "";
    if (sub && NODES.has(sub)) goto({ kind: "node", id: sub });
    evo.on("location", function (loc) {
      var p = loc && loc.path ? decodeURIComponent(String(loc.path).replace(/^\/+/, "")) : "";
      if (p && NODES.has(p)) goto({ kind: "node", id: p });
    });
    loadThreads();
    setInterval(function () { if (document.visibilityState === "visible" && !state.busy.size && !state.form) loadThreads(); }, POLL_MS);
  }
})();
