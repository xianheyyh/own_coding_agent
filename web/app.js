(() => {
  const $ = (id) => document.getElementById(id);
  const logEl = $("log");
  const treeEl = $("tree");
  const inputEl = $("input");
  const statusEl = $("status");
  const workspaceLabel = $("workspaceLabel");
  const tabName = $("tabName");
  const editorHost = $("editor");
  const fallback = $("editorFallback");
  const btnSend = $("btnSend");
  const termOut = $("termOut");
  const termCmd = $("termCmd");
  const termPane = $("termPane");
  const ctxEl = $("ctx");
  const termCtxEl = $("termCtx");
  const filesDrawer = $("filesDrawer");
  const previewDrawer = $("previewDrawer");
  const changeListEl = $("changeList");
  const dlgEl = $("dlg");
  const dlgTitle = $("dlgTitle");
  const dlgMsg = $("dlgMsg");
  const dlgInput = $("dlgInput");
  const dlgOk = $("dlgOk");
  const dlgCancel = $("dlgCancel");
  let dlgResolve = null;

  function closeDlg(result) {
    if (dlgEl) dlgEl.classList.add("hidden");
    const done = dlgResolve;
    dlgResolve = null;
    if (done) done(result);
  }

  function askDialog(opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      if (dlgResolve) closeDlg(o.input ? null : false);
      dlgResolve = resolve;
      if (dlgTitle) dlgTitle.textContent = o.title || (o.input ? "输入" : "确认");
      if (dlgMsg) {
        dlgMsg.textContent = o.message || "";
        dlgMsg.classList.toggle("hidden", !String(o.message || "").trim());
      }
      if (dlgOk) {
        dlgOk.textContent = o.ok || "确定";
        dlgOk.classList.toggle("danger", !!o.danger);
      }
      if (dlgCancel) dlgCancel.textContent = o.cancel || "取消";
      if (dlgInput) {
        dlgInput.classList.toggle("hidden", !o.input);
        dlgInput.value = o.value || "";
        dlgInput.placeholder = o.placeholder || "";
      }
      if (dlgEl) dlgEl.classList.remove("hidden");
      requestAnimationFrame(() => {
        if (o.input && dlgInput) dlgInput.focus();
        else if (dlgOk) dlgOk.focus();
      });
    });
  }

  function askConfirm(message, extra) {
    const o = extra || {};
    return askDialog({
      title: o.title || "确认",
      message: message,
      ok: o.ok || "确定",
      cancel: o.cancel || "取消",
      danger: !!o.danger,
    });
  }

  function askPrompt(message, value, extra) {
    const o = extra || {};
    return askDialog({
      title: o.title || "输入",
      message: message,
      value: value || "",
      placeholder: o.placeholder || "",
      ok: o.ok || "确定",
      cancel: o.cancel || "取消",
      input: true,
    });
  }

  let monacoEditor = null;
  let useFallback = false;
  let applying = false;
  let currentPath = "";
  let selectedDir = "";
  let selectedPath = "";
  let ctxTarget = "";
  let ctxIsDir = true;
  let dirty = false;
  let taskRunning = false;
  let workspaceName = "";
  let workspacePath = "";
  const collapsedWs = new Set();
  let didDrag = false;
  let dragKind = "";
  let dragEl = null;
  let termHistory = [];
  let termHistIdx = -1;
  let termSessions = [];
  let termSessIdx = 0;
  let termSeq = 0;
  const termByWorkspace = new Map();
  let dockTab = "";
  let activeConvId = "";
  const changedFiles = new Map();
  let historyIndex = [];
  let expandedHistPath = "";
  let histVersions = [];
  let historyView = null;
  let showingDiff = false;
  const changeDiffs = new Map();
  const pendingTools = [];
  let lastAssistantText = "";
  let streamWrap = null;
  let streamBody = null;
  let streamRaw = "";

  const TOOL_META = {
    glob: { icon: "codicon-files", label: "按名搜索", tone: "search" },
    grep: { icon: "codicon-search", label: "搜索内容", tone: "search" },
    read_file: { icon: "codicon-go-to-file", label: "读取", tone: "read" },
    write_file: { icon: "codicon-new-file", label: "写入", tone: "write" },
    apply_patch: { icon: "codicon-diff", label: "补丁", tone: "edit" },
    edit_file: { icon: "codicon-diff", label: "修改", tone: "edit" },
    list_dir: { icon: "codicon-folder", label: "列出目录", tone: "read" },
    todo: { icon: "codicon-tasklist", label: "待办", tone: "todo" },
    run_shell: { icon: "codicon-terminal", label: "终端", tone: "shell" },
    remember: { icon: "codicon-bookmark", label: "记住", tone: "mem" },
    update_memory: { icon: "codicon-edit", label: "更新记忆", tone: "mem" },
    forget: { icon: "codicon-discard", label: "废弃记忆", tone: "mem" },
    recall: { icon: "codicon-search", label: "召回约定", tone: "mem" },
    recall_episode: { icon: "codicon-history", label: "召回情节", tone: "mem" },
  };

  const LANG = {
    py: "python",
    js: "javascript",
    ts: "typescript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    htm: "html",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
    ini: "ini",
    txt: "plaintext",
    sh: "shell",
    bat: "bat",
    ps1: "powershell",
    xml: "xml",
    svg: "xml",
  };

  function langOf(path) {
    const ext = (path.split(".").pop() || "").toLowerCase();
    return LANG[ext] || "plaintext";
  }

  function parentDir(path) {
    if (!path) return "";
    const i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i);
  }

  function joinPath(dir, name) {
    const n = (name || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
    if (!n) return "";
    return dir ? dir + "/" + n : n;
  }

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function monacoThemeName(theme) {
    return theme === "light" ? "vs" : "vs-dark";
  }

  function syncThemeChrome(theme) {
    const btn = $("btnTheme");
    if (btn) btn.title = theme === "light" ? "切换到深色" : "切换到亮色";
    if (window.monaco && monacoEditor) {
      monaco.editor.setTheme(monacoThemeName(theme));
    }
  }

  function setTheme(theme) {
    const next = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("ca-theme", next);
    } catch (_) {}
    syncThemeChrome(next);
  }

  function toggleTheme() {
    setTheme(currentTheme() === "light" ? "dark" : "light");
  }

  function updateTab() {
    let name = currentPath || "未打开文件";
    if (historyView) name += " · 历史";
    else if (showingDiff) name += " · 差异";
    tabName.textContent = (dirty ? "● " : "") + name;
    const empty = $("editorEmpty");
    const diffEl = $("editorDiff");
    const inDiff = !!(diffEl && !diffEl.classList.contains("hidden"));
    if (empty) empty.classList.toggle("hidden", !!currentPath || inDiff);
    const locked = !!(historyView || showingDiff);
    if (monacoEditor) monacoEditor.updateOptions({ readOnly: locked });
    if (fallback) fallback.readOnly = locked;
    const btn = $("btnSave");
    if (btn) {
      btn.disabled = locked || !currentPath;
      btn.title = historyView
        ? "历史版本不能保存"
        : showingDiff
          ? "差异视图不能保存"
          : "保存 (Ctrl+S)";
    }
  }

  function reasonLabel(reason) {
    if (reason === "write_file") return "写入";
    if (reason === "edit_file") return "修改";
    if (reason === "read_file") return "读取";
    if (reason === "save") return "保存";
    if (reason === "rollback") return "回退";
    if (reason === "create") return "新建";
    return reason || "";
  }

  function changeBadge(reason) {
    if (reason === "delete") return { t: "D", c: "badge-d" };
    if (reason === "edit_file" || reason === "save" || reason === "rollback") return { t: "M", c: "badge-m" };
    if (reason === "write_file" || reason === "create") return { t: "A", c: "badge-a" };
    return { t: "R", c: "badge-r" };
  }

  function fileBase(path) {
    const p = String(path || "").replace(/\\/g, "/");
    const i = p.lastIndexOf("/");
    return i < 0 ? p : p.slice(i + 1);
  }

  function fileDir(path) {
    const p = String(path || "").replace(/\\/g, "/");
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  }

  function histActionLabel(action) {
    if (action === "write_file") return "写入前";
    if (action === "edit_file") return "修改前";
    if (action === "save") return "保存前";
    if (action === "rollback") return "回退前";
    if (action === "create") return "新建前";
    return "版本";
  }

  function historyMeta(path) {
    return historyIndex.find((row) => row.path === path) || null;
  }

  function mergeChangePaths() {
    const paths = [];
    const seen = new Set();
    changedFiles.forEach((_, path) => {
      paths.push(path);
      seen.add(path);
    });
    historyIndex.forEach((row) => {
      if (row.path && !seen.has(row.path)) {
        paths.push(row.path);
        seen.add(row.path);
      }
    });
    return paths;
  }

  function renderHistList(path) {
    const box = document.createElement("div");
    box.className = "hist-list";
    if (!histVersions.length) {
      const empty = document.createElement("div");
      empty.className = "hist-empty";
      empty.textContent = "还没有可回退的版本";
      box.appendChild(empty);
      return box;
    }
    histVersions.forEach((item) => {
      const row = document.createElement("div");
      row.className =
        "hist-item" +
        (historyView && historyView.path === path && String(historyView.id) === String(item.id)
          ? " active"
          : "");
      const main = document.createElement("button");
      main.type = "button";
      main.className = "hist-main";
      const title = document.createElement("span");
      title.textContent = (item.missing ? "当时不存在" : histActionLabel(item.action));
      const time = document.createElement("span");
      time.className = "hist-time";
      time.textContent = formatTime(item.at);
      main.appendChild(title);
      main.appendChild(time);
      main.addEventListener("click", (e) => {
        e.stopPropagation();
        viewHistory(path, item.id, item.missing);
      });
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "hist-restore";
      restore.textContent = "回退";
      restore.addEventListener("click", (e) => {
        e.stopPropagation();
        restoreHistory(path, item.id, item.missing);
      });
      row.appendChild(main);
      row.appendChild(restore);
      box.appendChild(row);
    });
    return box;
  }

  function renderChangeList() {
    const empty = $("changeEmpty");
    const countEl = $("changeCount");
    changeListEl.innerHTML = "";
    const paths = mergeChangePaths();
    if (empty) empty.classList.toggle("hidden", paths.length > 0);
    if (countEl) countEl.textContent = paths.length ? String(paths.length) : "";
    paths.forEach((path) => {
      const wrap = document.createElement("div");
      wrap.className = "change-block" + (expandedHistPath === path ? " open" : "");
      const reason = changedFiles.get(path) || (historyMeta(path) || {}).last_action || "edit_file";
      const row = document.createElement("div");
      row.className = "change-item" + (path === currentPath ? " active" : "");
      const badge = changeBadge(reason);
      const mark = document.createElement("span");
      mark.className = "change-badge " + badge.c;
      mark.textContent = badge.t;
      const body = document.createElement("div");
      body.className = "change-body";
      const name = document.createElement("div");
      name.className = "change-name";
      name.textContent = fileBase(path);
      const sub = document.createElement("div");
      sub.className = "change-path";
      sub.textContent = fileDir(path) || path;
      sub.title = path;
      body.appendChild(name);
      body.appendChild(sub);
      row.appendChild(mark);
      row.appendChild(body);
      const meta = historyMeta(path);
      const diffInfo = changeDiffs.get(path);
      if (diffInfo) {
        const rows = lineDiff(diffInfo.before, diffInfo.after);
        const add = rows.filter((r) => r.t === "add").length;
        const del = rows.filter((r) => r.t === "del").length;
        if (add || del) {
          const stat = document.createElement("span");
          stat.className = "change-stat";
          stat.textContent = "+" + add + " −" + del;
          row.appendChild(stat);
        }
      } else if (meta && meta.count) {
        const n = document.createElement("span");
        n.className = "change-n";
        n.textContent = meta.count + " 版";
        row.appendChild(n);
      }
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "icon-btn change-del";
      delBtn.title = "删除此文件";
      delBtn.innerHTML = '<i class="codicon codicon-trash"></i>';
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSelected(path);
      });
      row.appendChild(delBtn);
      row.addEventListener("click", () => {
        selectedPath = path;
        selectedDir = parentDir(path);
        openChangeDiff(path);
      });
      wrap.appendChild(row);
      if (expandedHistPath === path) {
        const detail = document.createElement("div");
        detail.className = "change-detail";
        detail.appendChild(renderHistList(path));
        wrap.appendChild(detail);
      }
      changeListEl.appendChild(wrap);
    });
  }

  async function loadHistory() {
    try {
      const res = await fetch("/api/history");
      if (res.ok) {
        const data = await res.json();
        historyIndex = data.files || [];
      }
    } catch (_) {}
    renderChangeList();
  }

  async function expandHistory(path) {
    expandedHistPath = path;
    histVersions = [];
    renderChangeList();
    try {
      const [verRes, diffRes] = await Promise.all([
        fetch("/api/history/versions?path=" + encodeURIComponent(path)),
        fetch("/api/history/diff?path=" + encodeURIComponent(path)),
      ]);
      if (expandedHistPath !== path) return;
      if (verRes.ok) {
        const data = await verRes.json();
        histVersions = data.items || [];
      }
      if (diffRes.ok) {
        changeDiffs.set(path, await diffRes.json());
      }
    } catch (_) {}
    renderChangeList();
  }

  async function fetchHistoryContent(path, id) {
    const res = await fetch(
      "/api/history/content?path=" + encodeURIComponent(path) + "&id=" + encodeURIComponent(id)
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.content || "";
  }

  async function fetchCurrentContent(path) {
    const res = await fetch("/api/file?path=" + encodeURIComponent(path));
    if (!res.ok) return "";
    const data = await res.json();
    return data.content || "";
  }

  async function openChangeDiff(path) {
    if (!path) return;
    historyView = null;
    let info = changeDiffs.get(path);
    if (!info) {
      try {
        const res = await fetch("/api/history/diff?path=" + encodeURIComponent(path));
        if (res.ok) {
          info = await res.json();
          changeDiffs.set(path, info);
        }
      } catch (_) {}
    }
    const hasDiff = info && String(info.before || "") !== String(info.after || "");
    if (hasDiff) {
      const caption = info.created
        ? "新建 · 全部为新增 · 只读"
        : info.deleted
          ? "已删除 · 以下为删除前内容 · 只读"
          : "相较上一版 · 只读，不能保存";
      showEditorDiff(path, info.before, info.after, { caption });
    } else {
      await openFile(path, changedFiles.get(path) || "edit_file", false);
    }
    expandHistory(path);
  }

  async function viewHistory(path, id, missing) {
    historyView = { path, id };
    dirty = false;
    let before = "";
    if (!missing) {
      const text = await fetchHistoryContent(path, id);
      if (text === null) {
        appendLog("[历史] 无法打开这个版本", "error");
        historyView = null;
        return;
      }
      before = text;
    }
    let after = "";
    const idx = histVersions.findIndex((item) => String(item.id) === String(id));
    if (idx > 0) {
      const newer = histVersions[idx - 1];
      if (newer && !newer.missing) {
        const next = await fetchHistoryContent(path, newer.id);
        if (next !== null) after = next;
      }
    } else {
      after = await fetchCurrentContent(path);
    }
    const caption = missing
      ? "该版本时文件还不存在 · 只读，不能保存"
      : "历史版本 · 只读，不能保存";
    showEditorDiff(path, before, after, { caption, keepHistory: true });
    renderChangeList();
    setStatus(missing ? "该版本时文件还不存在" : "正在查看历史版本（只读）");
  }

  async function restoreHistory(path, id, missing) {
    const tip = missing ? "回退将删除当前文件。继续？" : "把 " + path + " 回退到这个版本？";
    if (!(await askConfirm(tip, { title: "回退", danger: !!missing, ok: "回退" }))) return;
    const res = await fetch("/api/history/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, id }),
    });
    if (!res.ok) {
      appendLog("[回退失败] " + (await res.text()), "error");
      return;
    }
    const data = await res.json();
    historyView = null;
    historyIndex = data.files || historyIndex;
    if (data.missing) {
      currentPath = "";
      setEditorContent("", "");
      setPreviewOpen(false);
      setStatus("已回退：文件已删除");
    } else {
      await openFile(path, "rollback", false);
      setStatus("已回退 " + path);
    }
    await loadHistory();
    await expandHistory(path);
    loadTree();
  }

  function noteFile(path, reason) {
    if (!path) return;
    const prev = changedFiles.get(path);
    if (reason === "read_file" && (prev === "write_file" || prev === "edit_file")) {
      renderChangeList();
      return;
    }
    changedFiles.set(path, reason || prev || "read_file");
    renderChangeList();
  }

  function clearChanges() {
    changedFiles.clear();
    loadHistory();
  }

  function setFilesOpen(open) {
    if (open) showDock("files");
  }

  function readSavedDockWidth() {
    try {
      return parseInt(localStorage.getItem("ca-dock-w") || "", 10) || 0;
    } catch (_) {
      return 0;
    }
  }

  function restoreDockWidth() {
    const dock = $("dock");
    if (!dock || dock.classList.contains("is-closed")) return;
    const saved = readSavedDockWidth();
    if (saved >= 196) {
      dock.style.width = saved + "px";
      dock.style.flexBasis = saved + "px";
    } else {
      dock.style.width = "";
      dock.style.flexBasis = "";
    }
    layoutEditors();
  }

  function bindDockResize() {
    const dock = $("dock");
    const handle = $("dockResize");
    if (!dock || !handle) return;
    let startX = 0;
    let startW = 0;
    const onMove = (e) => {
      const max = Math.floor(window.innerWidth * 0.72);
      const next = Math.max(196, Math.min(max, startW + (startX - e.clientX)));
      dock.style.width = next + "px";
      dock.style.flexBasis = next + "px";
    };
    const onUp = () => {
      dock.classList.remove("resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const w = Math.round(dock.getBoundingClientRect().width);
      try {
        localStorage.setItem("ca-dock-w", String(w));
      } catch (_) {}
      layoutEditors();
    };
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = dock.getBoundingClientRect().width;
      dock.classList.add("resizing");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function readSavedPreviewWidth() {
    try {
      return parseInt(localStorage.getItem("ca-preview-w") || "", 10) || 0;
    } catch (_) {
      return 0;
    }
  }

  function previewMaxWidth() {
    const chat = previewDrawer && previewDrawer.parentElement;
    if (chat) return Math.max(280, chat.clientWidth - 16);
    return Math.floor(window.innerWidth * 0.92);
  }

  function restorePreviewWidth() {
    if (!previewDrawer || !previewDrawer.classList.contains("open")) return;
    const saved = readSavedPreviewWidth();
    const max = previewMaxWidth();
    if (saved >= 240) {
      previewDrawer.style.width = Math.min(saved, max) + "px";
    } else {
      previewDrawer.style.width = "";
    }
    layoutEditors();
  }

  function bindPreviewResize() {
    const handle = $("previewResize");
    if (!previewDrawer || !handle) return;
    let startX = 0;
    let startW = 0;
    const onMove = (e) => {
      const next = Math.max(240, Math.min(previewMaxWidth(), startW + (startX - e.clientX)));
      previewDrawer.style.width = next + "px";
      layoutEditors();
    };
    const onUp = () => {
      previewDrawer.classList.remove("resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const w = Math.round(previewDrawer.getBoundingClientRect().width);
      try {
        localStorage.setItem("ca-preview-w", String(w));
      } catch (_) {}
      layoutEditors();
    };
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = previewDrawer.getBoundingClientRect().width;
      previewDrawer.classList.add("resizing");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function setDockTabOpen(name, open) {
    const tab = document.querySelector('.dock-tab[data-dock="' + name + '"]');
    if (tab) tab.classList.toggle("hidden", !open);
  }

  function openDockNames() {
    return ["changes", "files", "term", "browser"].filter((name) => {
      const tab = document.querySelector('.dock-tab[data-dock="' + name + '"]');
      return tab && !tab.classList.contains("hidden");
    });
  }

  function collapseDock() {
    dockTab = "";
    const dock = $("dock");
    if (dock) {
      dock.classList.add("is-closed");
      dock.style.width = "";
      dock.style.flexBasis = "";
    }
    document.querySelectorAll(".dock-panel").forEach((panel) => {
      panel.classList.remove("active");
    });
    layoutEditors();
  }

  function termWsKey(path) {
    return String(path || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  }

  function snapshotTerms() {
    return {
      sessions: termSessions.map((sess) => ({
        title: sess.title,
        text: sess.text || "",
        history: Array.isArray(sess.history) ? sess.history.slice() : [],
        histIdx: sess.histIdx,
        cwd: sess.cwd || "",
      })),
      sessIdx: termSessIdx,
      seq: termSeq,
      dockOpen: openDockNames().indexOf("term") >= 0 && termSessions.length > 0,
    };
  }

  function saveTermsFor(path) {
    const key = termWsKey(path);
    if (!key) return;
    termByWorkspace.set(key, snapshotTerms());
  }

  function hideTermTab() {
    setDockTabOpen("term", false);
    if (!termSessions.length) {
      if (termOut) termOut.textContent = "";
      if (termCmd) termCmd.value = "";
      renderTermSessions();
    }
    syncTermPrompt();
    if (dockTab === "term") {
      const rest = openDockNames();
      if (rest.length) showDock(rest[rest.length - 1]);
      else collapseDock();
    } else if (!openDockNames().length) {
      collapseDock();
    }
  }

  function applyTermSnapshot(snap) {
    const data = snap || { sessions: [], sessIdx: 0, seq: 0, dockOpen: false };
    termSessions = (data.sessions || []).map((sess) => ({
      title: sess.title,
      text: sess.text || "",
      history: Array.isArray(sess.history) ? sess.history.slice() : [],
      histIdx: sess.histIdx == null ? -1 : sess.histIdx,
      cwd: sess.cwd || "",
    }));
    termSeq = data.seq || 0;
    if (!termSessions.length) {
      termSessIdx = 0;
      hideTermTab();
      return;
    }
    selectTerm(Math.max(0, Math.min(data.sessIdx || 0, termSessions.length - 1)));
    if (data.dockOpen) showDock("term");
    else hideTermTab();
  }

  function bindTermsToWorkspace(prevPath) {
    const prev = termWsKey(prevPath);
    const next = termWsKey(workspacePath);
    if (!next || prev === next) {
      syncTermPrompt();
      return;
    }
    saveTermsFor(prevPath);
    applyTermSnapshot(termByWorkspace.get(next));
  }

  function hideDock(name) {
    if (!name) return;
    setDockTabOpen(name, false);
    if (name === "term") {
      termSessions = [];
      termSessIdx = 0;
      termSeq = 0;
      if (termOut) termOut.textContent = "";
      if (termCmd) termCmd.value = "";
      syncTermPrompt();
      saveTermsFor(workspacePath);
    }
    if (name === "browser") resetBrowser();
    const rest = openDockNames();
    if (dockTab === name) {
      if (rest.length) showDock(rest[rest.length - 1]);
      else collapseDock();
    } else if (!rest.length) {
      collapseDock();
    }
  }

  function showDock(name) {
    if (!name) return;
    setDockTabOpen(name, true);
    const dock = $("dock");
    const wasClosed = !!(dock && dock.classList.contains("is-closed"));
    if (dock) dock.classList.remove("is-closed");
    dockTab = name;
    document.querySelectorAll(".dock-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-dock") === name);
    });
    document.querySelectorAll(".dock-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.getAttribute("data-dock") === name);
    });
    if (wasClosed) restoreDockWidth();
    if (name === "files" && !createDraft) loadTree();
    if (name === "term") {
      const sess = currentTerm();
      if (termOut) termOut.textContent = sess ? sess.text : "";
      syncTermPrompt();
      renderTermSessions();
      scrollTerm();
      if (termCmd) termCmd.focus();
    }
    if (name === "browser") {
      const url = $("browserUrl");
      if (url) url.focus();
    }
    try {
      localStorage.setItem("ca-dock", name);
    } catch (_) {}
  }

  function layoutEditors() {
    if (!monacoEditor) return;
    try {
      monacoEditor.layout();
    } catch (_) {
      /* ignore until monaco is ready */
    }
  }

  function setPreviewOpen(open) {
    previewDrawer.classList.toggle("open", open);
    if (open) {
      restorePreviewWidth();
      requestAnimationFrame(() => {
        layoutEditors();
        requestAnimationFrame(layoutEditors);
      });
    }
  }

  function syncChatEmpty() {
    const empty = $("chatEmpty");
    if (empty) empty.classList.toggle("hidden", logEl.children.length > 0);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function formatInline(s) {
    return escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(
        /\[([^\]]+)\]\((https?:[^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
      );
  }

  function formatTextBlock(text) {
    const lines = String(text || "").split("\n");
    const html = [];
    let inList = false;
    const closeList = () => {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
    };
    lines.forEach((line) => {
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) {
        closeList();
        const n = heading[1].length;
        html.push("<h" + n + ">" + formatInline(heading[2]) + "</h" + n + ">");
        return;
      }
      const item = /^[-*]\s+(.+)$/.exec(line);
      if (item) {
        if (!inList) {
          html.push("<ul>");
          inList = true;
        }
        html.push("<li>" + formatInline(item[1]) + "</li>");
        return;
      }
      closeList();
      if (!line.trim()) html.push("");
      else html.push("<p>" + formatInline(line) + "</p>");
    });
    closeList();
    return html.join("");
  }

  function formatAssistant(text) {
    const raw = String(text || "");
    const re = /```[\w]*\n?([\s\S]*?)```/g;
    const parts = [];
    let last = 0;
    let m;
    while ((m = re.exec(raw))) {
      parts.push({ t: "text", v: raw.slice(last, m.index) });
      parts.push({ t: "code", v: m[1] });
      last = m.index + m[0].length;
    }
    parts.push({ t: "text", v: raw.slice(last) });
    return parts
      .map((c) => {
        if (c.t === "code") {
          return "<pre>" + escapeHtml(c.v.replace(/\n$/, "")) + "</pre>";
        }
        return formatTextBlock(c.v);
      })
      .join("");
  }

  function fileIcon(name, isDir) {
    if (isDir) return "codicon-folder";
    const ext = (String(name || "").split(".").pop() || "").toLowerCase();
    if (ext === "py") return "codicon-symbol-namespace";
    if (ext === "md") return "codicon-markdown";
    if (ext === "json") return "codicon-json";
    if (ext === "txt") return "codicon-file-text";
    return "codicon-file";
  }

  function setBusy(next) {
    taskRunning = !!next;
    try {
      const btnNew = $("btnNew");
      const btnNewWs = $("btnNewWs");
      const convList = $("convList");
      const icon = $("sendIcon");
      const runBar = $("runBar");
      const statusIcon = $("statusIcon");
      if (btnNew) btnNew.disabled = taskRunning;
      if (btnNewWs) btnNewWs.disabled = taskRunning;
      const modelBtn = $("modelBtn");
      if (modelBtn) modelBtn.disabled = taskRunning;
      if (taskRunning) closeModelMenu();
      if (convList) convList.style.pointerEvents = taskRunning ? "none" : "";
      if (taskRunning) {
        if (btnSend) {
          btnSend.classList.add("is-stop");
          btnSend.title = "暂停";
        }
        if (icon) icon.className = "codicon codicon-debug-pause";
        if (runBar) runBar.classList.remove("hidden");
        if (statusIcon) statusIcon.className = "codicon codicon-sync spin";
        const hint = document.querySelector(".composer-hint");
        if (hint) hint.textContent = "Enter 暂停";
        setRunText("正在调用模型…");
        setStatus("运行中…");
      } else {
        if (btnSend) {
          btnSend.classList.remove("is-stop");
          btnSend.title = "发送";
        }
        if (icon) icon.className = "codicon codicon-send";
        if (runBar) runBar.classList.add("hidden");
        if (statusIcon) statusIcon.className = "codicon codicon-check";
        const hint = document.querySelector(".composer-hint");
        if (hint) hint.textContent = "Enter 发送";
      }
    } catch (_) {
      /* ignore */
    }
  }

  function setRunText(text) {
    const el = $("runText");
    if (el) el.textContent = text;
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function growInput() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(Math.max(inputEl.scrollHeight, 40), 180) + "px";
  }

  function formatTime(iso) {
    if (!iso) return "";
    const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (!m) return String(iso).replace("T", " ").slice(0, 16);
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    const diff = (Date.now() - t.getTime()) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff < 172800) return "昨天";
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + " 天前";
    return m[2] + "/" + m[3];
  }

  function convGroups(data) {
    if (data.workspaces && data.workspaces.length) return data.workspaces;
    return [
      {
        path: workspacePath,
        name: workspaceName || "工作区",
        current: true,
        items: data.items || [],
      },
    ];
  }

  function renderConvItem(item, group) {
    const el = document.createElement("div");
    const isActive = group.current && item.id === activeConvId;
    el.className = "conv-item" + (isActive ? " active" : "");
    el.draggable = true;
    el.dataset.id = item.id || "";
    const title = document.createElement("div");
    title.className = "conv-title";
    title.textContent = item.title || "新对话";
    title.title = item.title || "新对话";
    const time = document.createElement("div");
    time.className = "conv-time";
    time.textContent = formatTime(item.updated);
    el.appendChild(title);
    el.appendChild(time);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "conv-del";
    del.title = "删除对话";
    del.innerHTML = '<i class="codicon codicon-trash"></i>';
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteConversation(item.id, group.path);
    });
    el.appendChild(del);
    el.addEventListener("click", () => {
      if (didDrag || isActive) return;
      selectConversation(item.id, group.path);
    });
    return el;
  }

  function renderConvList(data) {
    const list = $("convList");
    list.innerHTML = "";
    activeConvId = data.active_id || "";
    if (data.workspace) workspacePath = data.workspace;
    if (data.workspace_name) workspaceName = data.workspace_name;
    const groups = convGroups(data);
    groups.forEach((group) => {
      const wrap = document.createElement("div");
      const collapsed = collapsedWs.has(group.path) && !group.current;
      wrap.className = "ws-group" + (group.current ? " current" : "") + (collapsed ? " collapsed" : "");
      wrap.draggable = true;
      wrap.dataset.path = group.path || "";

      const head = document.createElement("div");
      head.className = "ws-head";

      const chev = document.createElement("button");
      chev.type = "button";
      chev.className = "ws-chev";
      chev.title = collapsed ? "展开" : "折叠";
      chev.innerHTML = '<i class="codicon codicon-chevron-down"></i>';
      chev.addEventListener("mousedown", () => {
        wrap.draggable = false;
      });
      chev.addEventListener("click", (e) => {
        e.stopPropagation();
        if (wrap.classList.contains("collapsed")) collapsedWs.delete(group.path);
        else collapsedWs.add(group.path);
        wrap.classList.toggle("collapsed");
      });

      const label = document.createElement("button");
      label.type = "button";
      label.className = "ws-label";
      label.title = group.path + "（拖动可调整顺序）";
      const folder = document.createElement("i");
      folder.className = "codicon " + (group.current ? "codicon-folder-opened" : "codicon-folder");
      const name = document.createElement("span");
      name.className = "ws-name";
      name.textContent = group.name || "工作区";
      label.appendChild(folder);
      label.appendChild(name);
      label.addEventListener("click", () => {
        if (didDrag) return;
        if (!group.current) setWorkspace(group.path);
      });

      head.appendChild(chev);
      head.appendChild(label);
      const addConv = document.createElement("button");
      addConv.type = "button";
      addConv.className = "ws-action ws-new";
      addConv.title = "新建对话";
      addConv.innerHTML = '<i class="codicon codicon-add"></i>';
      addConv.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        wrap.draggable = false;
      });
      addConv.addEventListener("click", (e) => {
        e.stopPropagation();
        newConversation(group.path);
      });
      head.appendChild(addConv);
      if (groups.length > 1) {
        const delWs = document.createElement("button");
        delWs.type = "button";
        delWs.className = "ws-action ws-del";
        delWs.title = "删除工作区";
        delWs.innerHTML = '<i class="codicon codicon-trash"></i>';
        delWs.addEventListener("mousedown", (e) => {
          e.stopPropagation();
          wrap.draggable = false;
        });
        delWs.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteWorkspace(group.path);
        });
        head.appendChild(delWs);
      }
      wrap.appendChild(head);

      const threads = document.createElement("div");
      threads.className = "ws-threads";
      threads.addEventListener("mousedown", () => {
        wrap.draggable = false;
      });
      const items = group.items || [];
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "ws-empty";
        empty.textContent = "暂无对话";
        threads.appendChild(empty);
      } else {
        items.forEach((item) => threads.appendChild(renderConvItem(item, group)));
      }
      wrap.appendChild(threads);
      list.appendChild(wrap);
    });
  }

  function restoreGroupDrag() {
    document.querySelectorAll(".ws-group").forEach((g) => {
      g.draggable = true;
    });
  }

  function bindConvListDrag() {
    const list = $("convList");
    if (!list || list.dataset.dragBound) return;
    list.dataset.dragBound = "1";
    list.addEventListener("dragstart", (e) => {
      const conv = e.target.closest(".conv-item");
      if (conv && list.contains(conv)) {
        dragKind = "conv";
        dragEl = conv;
        didDrag = false;
        conv.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", conv.dataset.id || "conv");
        e.stopPropagation();
        return;
      }
      const group = e.target.closest(".ws-group");
      if (group && !e.target.closest(".ws-chev") && !e.target.closest(".ws-action") && !e.target.closest(".conv-item")) {
        dragKind = "ws";
        dragEl = group;
        didDrag = false;
        group.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", group.dataset.path || "ws");
        return;
      }
      e.preventDefault();
    });
    list.addEventListener("dragover", (e) => {
      if (!dragEl) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dragKind === "conv") {
        const over = e.target.closest(".conv-item");
        if (!over || over === dragEl || over.parentNode !== dragEl.parentNode) return;
        const rect = over.getBoundingClientRect();
        const next = e.clientY < rect.top + rect.height / 2 ? over : over.nextSibling;
        if (next !== dragEl) {
          over.parentNode.insertBefore(dragEl, next);
          didDrag = true;
        }
        return;
      }
      if (dragKind === "ws") {
        const over = e.target.closest(".ws-group");
        if (!over || over === dragEl) return;
        const rect = over.getBoundingClientRect();
        const next = e.clientY < rect.top + rect.height / 2 ? over : over.nextSibling;
        if (next !== dragEl) {
          over.parentNode.insertBefore(dragEl, next);
          didDrag = true;
        }
      }
    });
    list.addEventListener("drop", (e) => {
      e.preventDefault();
    });
    list.addEventListener("dragend", () => {
      const kind = dragKind;
      const el = dragEl;
      if (el) el.classList.remove("dragging");
      dragKind = "";
      dragEl = null;
      restoreGroupDrag();
      if (!didDrag || !el) return;
      setTimeout(() => {
        didDrag = false;
      }, 80);
      if (kind === "conv") {
        const threads = el.closest(".ws-threads");
        const group = el.closest(".ws-group");
        if (!threads || !group) return;
        const ids = [...threads.querySelectorAll(".conv-item")].map((n) => n.dataset.id).filter(Boolean);
        fetch("/api/conversations/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids, workspace: group.dataset.path }),
        }).catch(() => {});
        return;
      }
      if (kind === "ws") {
        const paths = [...list.querySelectorAll(".ws-group")].map((n) => n.dataset.path).filter(Boolean);
        fetch("/api/workspaces/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths }),
        }).catch(() => {});
      }
    });
    document.addEventListener("mouseup", restoreGroupDrag);
  }

  function replayMessages(messages) {
    logEl.innerHTML = "";
    pendingTools.length = 0;
    lastAssistantText = "";
    (messages || []).forEach((m) => {
      const role = m.role;
      if (role === "system") return;
      if (role === "user") {
        appendUser(m.content || "");
        return;
      }
      if (role === "assistant") {
        if (m.content) appendAssistant(m.content);
        (m.tool_calls || []).forEach((call) => {
          const fn = call.function || {};
          appendToolCard(fn.name || "tool", fn.arguments || "");
        });
        return;
      }
      if (role === "tool") {
        let preview = m.content || "";
        if (preview.length > 500) preview = preview.slice(0, 500) + "\n...[显示截断]";
        fillToolResult(m.name, preview);
      }
    });
    syncChatEmpty();
  }

  function applyConvState(data, replay) {
    renderConvList(data);
    if (!replay) return;
    const replayNow = () => {
      try {
        replayMessages(data.messages || []);
      } catch (err) {
        appendError("无法回放对话: " + err);
      }
    };
    if (window.requestAnimationFrame) requestAnimationFrame(replayNow);
    else replayNow();
  }

  async function loadConversations(replay) {
    const res = await fetch("/api/conversations");
    if (!res.ok) throw new Error("无法加载对话");
    applyConvState(await res.json(), replay);
  }

  async function newConversation(workspace) {
    if (taskRunning) return;
    const ws = typeof workspace === "string" && workspace ? workspace : undefined;
    const prevWs = workspacePath;
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: ws }),
    });
    if (!res.ok) {
      appendLog("[错误] 无法新建对话", "error");
      return;
    }
    const data = await res.json();
    applyConvState(data, true);
    clearChanges();
    setPreviewOpen(false);
    if (data.workspace_changed) {
      currentPath = "";
      selectedDir = "";
      setEditorContent("", "");
      setFilesOpen(false);
      await loadWorkspace();
      bindTermsToWorkspace(prevWs);
      await loadTree();
    }
  }

  async function deleteConversation(id, workspace) {
    if (taskRunning) return;
    const ok = await askConfirm("", {
      title: "删除对话",
      ok: "删除",
      danger: true,
    });
    if (!ok) return;
    const res = await fetch("/api/conversations/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, workspace: workspace || undefined }),
    });
    if (!res.ok) {
      appendLog("[错误] 无法删除对话", "error");
      return;
    }
    applyConvState(await res.json(), true);
    clearChanges();
    setPreviewOpen(false);
  }

  async function deleteWorkspace(path) {
    if (taskRunning) return;
    const ok = await askConfirm("", {
      title: "删除工作区",
      ok: "删除",
      danger: true,
    });
    if (!ok) return;
    const prevWs = workspacePath;
    const res = await fetch("/api/workspaces/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) {
      appendLog("[错误] 无法删除工作区", "error");
      return;
    }
    const data = await res.json();
    applyConvState(data, true);
    clearChanges();
    setPreviewOpen(false);
    if (data.workspace_changed) {
      currentPath = "";
      selectedDir = "";
      setEditorContent("", "");
      setFilesOpen(false);
      await loadWorkspace();
      bindTermsToWorkspace(prevWs);
      await loadTree();
    }
  }

  async function selectConversation(id, workspace) {
    if (taskRunning) return;
    const res = await fetch("/api/conversations/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, workspace: workspace || undefined }),
    });
    if (!res.ok) {
      appendLog("[错误] 无法切换对话", "error");
      return;
    }
    const data = await res.json();
    applyConvState(data, true);
    clearChanges();
    setPreviewOpen(false);
    if (data.workspace_changed) {
      currentPath = "";
      selectedDir = "";
      setEditorContent("", "");
      setFilesOpen(false);
      const prevWs = workspacePath;
      await loadWorkspace();
      bindTermsToWorkspace(prevWs);
      await loadTree();
    }
  }

  function scrollLog() {
    logEl.scrollTop = logEl.scrollHeight;
    syncChatEmpty();
  }

  function parseArgs(raw) {
    if (!raw) return {};
    if (typeof raw === "object") return raw;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return { _: String(raw) };
    }
  }

  function prettyArgs(args) {
    try {
      return JSON.stringify(args, null, 2);
    } catch (_) {
      return String(args);
    }
  }

  function patchFiles(patch) {
    const files = [];
    String(patch || "").split("\n").forEach((line) => {
      const m = line.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/);
      if (m) files.push(m[1].trim());
    });
    return files;
  }

  function toolSummary(name, args) {
    if (name === "grep" || name === "glob") {
      const pat = args.pattern || "";
      return args.path && args.path !== "." ? pat + " @ " + args.path : pat;
    }
    if (name === "todo" && Array.isArray(args.items)) {
      const n = args.items.length;
      const done = args.items.filter((x) => x && x.status === "done").length;
      return done + "/" + n + " 步";
    }
    if (name === "apply_patch") {
      return patchFiles(args.patch).join(", ") || "补丁";
    }
    if (args.path) return args.path;
    if (args.command) return args.command;
    if (args.query) return args.query;
    if (args.fact) return String(args.fact).slice(0, 80);
    const keys = Object.keys(args || {});
    return keys.length ? keys.join(", ") : "";
  }

  function lineDiff(oldText, newText, full) {
    const a = String(oldText || "").split("\n");
    const b = String(newText || "").split("\n");
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    let ai = a.length - 1;
    let bi = b.length - 1;
    while (ai >= i && bi >= i && a[ai] === b[bi]) {
      ai -= 1;
      bi -= 1;
    }
    const rows = [];
    const ctxStart = full ? 0 : Math.max(0, i - 2);
    for (let k = ctxStart; k < i; k++) rows.push({ t: "ctx", v: a[k] });
    for (let k = i; k <= ai; k++) rows.push({ t: "del", v: a[k] });
    for (let k = i; k <= bi; k++) rows.push({ t: "add", v: b[k] });
    const ctxEnd = full ? a.length : Math.min(a.length, ai + 3);
    for (let k = ai + 1; k < ctxEnd; k++) rows.push({ t: "ctx", v: a[k] });
    return rows;
  }

  function fillDiff(wrap, oldText, newText, full) {
    const rows = lineDiff(oldText, newText, full);
    if (!rows.length) {
      const none = document.createElement("div");
      none.className = "diff-line diff-ctx";
      none.textContent = "  (空)";
      wrap.appendChild(none);
      return;
    }
    rows.forEach((row) => {
      const line = document.createElement("div");
      line.className = "diff-line diff-" + row.t;
      const mark = row.t === "add" ? "+" : row.t === "del" ? "-" : " ";
      line.textContent = mark + " " + (row.v || "");
      wrap.appendChild(line);
    });
  }

  function renderDiff(oldText, newText) {
    const wrap = document.createElement("div");
    wrap.className = "diff-block";
    fillDiff(wrap, oldText, newText, false);
    return wrap;
  }

  function setEditorMode(mode) {
    const diffEl = $("editorDiff");
    if (mode === "diff") {
      if (editorHost) editorHost.classList.add("hidden");
      if (fallback) fallback.classList.add("hidden");
      if (diffEl) diffEl.classList.remove("hidden");
      return;
    }
    showingDiff = false;
    if (diffEl) {
      diffEl.classList.add("hidden");
      diffEl.innerHTML = "";
    }
    if (useFallback) {
      if (editorHost) editorHost.classList.add("hidden");
      if (fallback) fallback.classList.remove("hidden");
    } else {
      if (editorHost) editorHost.classList.remove("hidden");
      if (fallback) fallback.classList.add("hidden");
    }
  }

  function showEditorDiff(path, oldText, newText, opts) {
    opts = opts || {};
    currentPath = path;
    dirty = false;
    showingDiff = true;
    if (!opts.keepHistory) historyView = null;
    setEditorMode("diff");
    const el = $("editorDiff");
    if (el) {
      el.innerHTML = "";
      const cap = document.createElement("div");
      cap.className = "editor-diff-cap";
      cap.textContent = opts.caption || "相较上一版 · 只读";
      el.appendChild(cap);
      const wrap = document.createElement("div");
      wrap.className = "diff-block editor-diff-block";
      if (String(oldText || "") === String(newText || "")) {
        const none = document.createElement("div");
        none.className = "editor-diff-empty";
        none.textContent = "没有文本差异";
        wrap.appendChild(none);
      } else {
        fillDiff(wrap, oldText, newText, true);
      }
      el.appendChild(wrap);
    }
    updateTab();
    setPreviewOpen(true);
  }

  function openChangesView() {
    showDock("changes");
    const paths = mergeChangePaths();
    if (!paths.length) return;
    const pick = currentPath && paths.indexOf(currentPath) >= 0 ? currentPath : paths[0];
    openChangeDiff(pick);
  }

  function appendUser(text) {
    const wrap = document.createElement("div");
    wrap.className = "msg msg-user";
    const body = document.createElement("div");
    body.className = "msg-body";
    body.textContent = String(text || "").replace(/^你：/, "");
    wrap.appendChild(body);
    logEl.appendChild(wrap);
    scrollLog();
  }

  function finishAssistantStream() {
    if (streamBody && streamRaw) {
      streamBody.innerHTML = formatAssistant(streamRaw);
      if (streamWrap) streamWrap.classList.remove("streaming");
    }
    streamWrap = null;
    streamBody = null;
    streamRaw = "";
  }

  function appendAssistantDelta(chunk) {
    const piece = String(chunk || "");
    if (!piece) return;
    streamRaw += piece;
    lastAssistantText = streamRaw;
    if (!streamBody) {
      streamWrap = document.createElement("div");
      streamWrap.className = "msg msg-assistant streaming";
      const kicker = document.createElement("div");
      kicker.className = "msg-kicker";
      kicker.textContent = "Agent";
      streamBody = document.createElement("div");
      streamBody.className = "msg-body";
      streamWrap.appendChild(kicker);
      streamWrap.appendChild(streamBody);
      logEl.appendChild(streamWrap);
    }
    streamBody.textContent = streamRaw;
    scrollLog();
  }

  function appendAssistant(text) {
    const raw = String(text || "");
    if (streamRaw && raw.trim() === streamRaw.trim()) {
      finishAssistantStream();
      return;
    }
    finishAssistantStream();
    lastAssistantText = raw;
    const wrap = document.createElement("div");
    wrap.className = "msg msg-assistant";
    const kicker = document.createElement("div");
    kicker.className = "msg-kicker";
    kicker.textContent = "Agent";
    const body = document.createElement("div");
    body.className = "msg-body";
    body.innerHTML = formatAssistant(raw);
    wrap.appendChild(kicker);
    wrap.appendChild(body);
    logEl.appendChild(wrap);
    scrollLog();
  }

  let lastSentTask = "";
  let turnLogMark = 0;
  let pausePending = false;
  let pauseRequested = false;
  let pauseRolled = false;

  function rollbackPausedTurn() {
    if (pauseRolled) return;
    pauseRolled = true;
    while (logEl.children.length > turnLogMark) {
      logEl.removeChild(logEl.lastChild);
    }
    pendingTools.length = 0;
    lastAssistantText = "";
    streamWrap = null;
    streamBody = null;
    streamRaw = "";
    if (lastSentTask) {
      inputEl.value = lastSentTask;
      growInput();
      try {
        inputEl.focus();
        const n = inputEl.value.length;
        inputEl.setSelectionRange(n, n);
      } catch (_) {}
    }
    syncChatEmpty();
    setStatus("对话已撤回。文件改动仍在，可在「改动」里回退。");
  }

  function appendError(text, canRetry) {
    const wrap = document.createElement("div");
    wrap.className = "msg msg-error";
    const body = document.createElement("div");
    body.textContent = text;
    wrap.appendChild(body);
    if (canRetry && lastSentTask) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "retry-btn";
      btn.textContent = "重试上一条任务";
      btn.addEventListener("click", () => sendTask(lastSentTask));
      wrap.appendChild(btn);
    }
    logEl.appendChild(wrap);
    scrollLog();
  }

  function appendMeta(text) {
    const wrap = document.createElement("div");
    wrap.className = "msg msg-meta";
    wrap.textContent = text;
    logEl.appendChild(wrap);
    scrollLog();
  }

  function appendToolCard(name, argumentsRaw) {
    const args = parseArgs(argumentsRaw);
    const meta = TOOL_META[name] || {
      icon: "codicon-tools",
      label: name || "工具",
      tone: "read",
    };
    const card = document.createElement("div");
    card.className = "tool-card tone-" + meta.tone;
    const head = document.createElement("button");
    head.type = "button";
    head.className = "tool-head";
    const icon = document.createElement("i");
    icon.className = "codicon " + meta.icon;
    const title = document.createElement("span");
    title.className = "tool-title";
    title.textContent = meta.label;
    const summary = document.createElement("span");
    summary.className = "tool-summary";
    summary.textContent = toolSummary(name, args);
    summary.title = summary.textContent;
    const chev = document.createElement("i");
    chev.className = "codicon codicon-chevron-right tool-chev";
    head.appendChild(icon);
    head.appendChild(title);
    head.appendChild(summary);
    head.appendChild(chev);
    const body = document.createElement("div");
    body.className = "tool-body";
    if (name === "edit_file" && (args.old || args.new)) {
      body.appendChild(renderDiff(args.old, args.new));
    }
    if (name === "todo" && Array.isArray(args.items)) {
      args.items.forEach((it) => {
        const chip = document.createElement("div");
        const st = String((it && it.status) || "pending");
        const mark = st === "done" ? "[x]" : st === "in_progress" ? "[>]" : "[ ]";
        chip.className = "msg-chip msg-chip-step todo-chip todo-" + st;
        chip.textContent = mark + " " + ((it && it.content) || "");
        body.appendChild(chip);
      });
    }
    const pre = document.createElement("pre");
    pre.className = "tool-args";
    pre.textContent = prettyArgs(args);
    body.appendChild(pre);
    const result = document.createElement("pre");
    result.className = "tool-result hidden";
    body.appendChild(result);
    head.addEventListener("click", () => {
      card.classList.toggle("open");
    });
    if (args.path) {
      summary.style.cursor = "pointer";
      summary.addEventListener("click", (e) => {
        e.stopPropagation();
        openFile(args.path, name, false);
      });
    } else if (name === "apply_patch") {
      const first = patchFiles(args.patch)[0];
      if (first) {
        summary.style.cursor = "pointer";
        summary.addEventListener("click", (e) => {
          e.stopPropagation();
          openFile(first, name, false);
        });
      }
    }
    card.appendChild(head);
    card.appendChild(body);
    logEl.appendChild(card);
    pendingTools.push({ el: card, result: result, name: name, args: args });
    scrollLog();
  }

  function fillToolResult(name, preview) {
    const item = pendingTools.shift();
    const text = preview || "";
    if (!item) {
      appendMeta("← " + text);
      return;
    }
    item.result.textContent = text;
    item.result.classList.remove("hidden");
    scrollLog();
  }

  function appendLog(text, cls) {
    cls = cls || "assistant";
    if (cls === "user") appendUser(text);
    else if (cls === "assistant") appendAssistant(text);
    else if (cls === "error") appendError(text);
    else appendMeta(text);
  }

  function editorValue() {
    if (monacoEditor) return monacoEditor.getValue();
    return fallback.value;
  }

  function setEditorContent(path, content) {
    currentPath = path;
    dirty = false;
    setEditorMode("code");
    updateTab();
    applying = true;
    if (monacoEditor) {
      const model = monaco.editor.createModel(content, langOf(path));
      const old = monacoEditor.getModel();
      monacoEditor.setModel(model);
      if (old) old.dispose();
    } else {
      fallback.value = content;
    }
    applying = false;
    const locked = !!(historyView || showingDiff);
    if (monacoEditor) monacoEditor.updateOptions({ readOnly: locked });
    if (fallback) fallback.readOnly = locked;
  }

  function markDirty() {
    if (applying || historyView || showingDiff || !currentPath) return;
    dirty = true;
    updateTab();
  }

  async function openFile(path, reason, record) {
    if (!path) return;
    historyView = null;
    if (record !== false) noteFile(path, reason || "read_file");
    const res = await fetch("/api/file?path=" + encodeURIComponent(path));
    if (!res.ok) {
      appendLog("[预览] 无法打开 " + path + "：" + (await res.text()), "meta");
      return;
    }
    const data = await res.json();
    selectedPath = data.path;
    selectedDir = parentDir(data.path);
    setEditorContent(data.path, data.content);
    highlightTree(path);
    renderChangeList();
    setPreviewOpen(true);
  }

  function highlightTree(path) {
    treeEl.querySelectorAll(".tree-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.path === path);
    });
  }

  function hideCtx() {
    ctxEl.classList.add("hidden");
    if (termCtxEl) termCtxEl.classList.add("hidden");
  }

  function showCtx(ev, path, isDir) {
    ev.preventDefault();
    if (termCtxEl) termCtxEl.classList.add("hidden");
    ctxTarget = path;
    ctxIsDir = isDir;
    selectedPath = path;
    selectedDir = isDir ? path : parentDir(path);
    ctxEl.style.left = ev.clientX + "px";
    ctxEl.style.top = ev.clientY + "px";
    ctxEl.classList.remove("hidden");
  }

  function renderNode(node, depth) {
    if (!node || typeof node !== "object") {
      const empty = document.createElement("div");
      empty.className = "tree-item";
      empty.textContent = "无法读取文件树";
      return empty;
    }
    const wrap = document.createElement("div");
    const row = document.createElement("div");
    row.className = "tree-item";
    row.dataset.path = node.path || "";
    row.style.paddingLeft = 8 + depth * 12 + "px";

    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = node.dir ? "▾" : "";
    row.appendChild(chev);

    const icon = document.createElement("i");
    icon.className = "codicon " + fileIcon(node.name, !!node.dir);
    row.appendChild(icon);

    const label = document.createElement("span");
    label.textContent = node.name;
    row.appendChild(label);
    wrap.appendChild(row);

    row.addEventListener("contextmenu", (ev) => showCtx(ev, node.path || "", !!node.dir));

    if (node.dir) {
      const kids = document.createElement("div");
      kids.className = "tree-children";
      (node.children || []).forEach((child) => {
        kids.appendChild(renderNode(child, depth + 1));
      });
      wrap.appendChild(kids);
      chev.addEventListener("click", (ev) => {
        ev.stopPropagation();
        kids.classList.toggle("collapsed");
        chev.textContent = kids.classList.contains("collapsed") ? "▸" : "▾";
      });
      row.addEventListener("click", () => {
        selectedPath = node.path || "";
        selectedDir = node.path || "";
        highlightTree(node.path || "");
      });
    } else {
      row.addEventListener("click", () => {
        selectedPath = node.path || "";
        selectedDir = parentDir(node.path);
        openFile(node.path);
      });
    }
    return wrap;
  }

  async function loadTree() {
    if (!treeEl) return;
    if ($("treeCreateRow")) return;
    const res = await fetch("/api/tree");
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    treeEl.innerHTML = "";
    if (!res.ok || !data || typeof data.dir !== "boolean") {
      const err = document.createElement("div");
      err.className = "tree-empty";
      err.textContent = "无法读取文件树";
      treeEl.appendChild(err);
      return;
    }
    treeEl.appendChild(renderNode(data, 0));
    if (currentPath) highlightTree(currentPath);
    else if (selectedDir) highlightTree(selectedDir);
    if (createDraft) queueCreateRow();
  }

  async function loadWorkspace() {
    const res = await fetch("/api/workspace");
    const data = await res.json();
    workspaceName = data.name;
    workspacePath = data.path;
    workspaceLabel.textContent = data.path;
    const composerWs = $("composerWs");
    if (composerWs) composerWs.textContent = data.name;
    syncTermPrompt();
    if (!taskRunning) setStatus("工作区 " + data.name + "  |  进行中 " + data.open_tasks + " 条");
  }

  const MODEL_NICK = {
    "deepseek-v4-flash": "Flash",
    "deepseek-v4-pro": "Pro",
    "deepseek-chat": "Chat",
    "deepseek-reasoner": "Reasoner",
    "gpt-4o-mini": "GPT-4o mini",
    "gpt-4o": "GPT-4o",
    "gpt-4.1-mini": "GPT-4.1 mini",
  };
  let modelState = { model: "", models: [] };

  function prettyModel(name) {
    if (!name) return "模型";
    if (MODEL_NICK[name]) return MODEL_NICK[name];
    return String(name).replace(/^deepseek-v4-/, "").replace(/^deepseek-/, "");
  }

  function closeModelMenu() {
    const menu = $("modelMenu");
    const picker = $("modelPicker");
    if (menu) menu.classList.add("hidden");
    if (picker) picker.classList.remove("open");
  }

  function fillModelSelect(data) {
    modelState = {
      model: (data && data.model) || "",
      models: (data && data.models) || [],
    };
    const label = $("modelLabel");
    if (label) {
      label.textContent = prettyModel(modelState.model);
      label.title = modelState.model || "";
    }
    const btn = $("modelBtn");
    if (btn) btn.title = modelState.model ? "模型：" + modelState.model : "选择模型";
    renderModelMenu();
  }

  function renderModelMenu() {
    const menu = $("modelMenu");
    if (!menu) return;
    menu.innerHTML = "";
    modelState.models.forEach((name) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "model-item" + (name === modelState.model ? " active" : "");
      item.dataset.model = name;
      const mark = document.createElement("i");
      mark.className = name === modelState.model ? "codicon codicon-check" : "model-item-gap";
      const body = document.createElement("span");
      body.className = "model-item-name";
      const title = document.createElement("span");
      title.className = "model-item-title";
      title.textContent = prettyModel(name);
      const id = document.createElement("span");
      id.className = "model-item-id";
      id.textContent = name;
      body.appendChild(title);
      if (prettyModel(name) !== name) body.appendChild(id);
      item.appendChild(mark);
      item.appendChild(body);
      item.addEventListener("click", () => {
        closeModelMenu();
        if (name !== modelState.model) changeModel(name);
      });
      menu.appendChild(item);
    });
    const sep = document.createElement("div");
    sep.className = "model-sep";
    menu.appendChild(sep);
    const custom = document.createElement("button");
    custom.type = "button";
    custom.className = "model-item";
    custom.innerHTML = '<i class="codicon codicon-edit"></i><span class="model-item-name"><span class="model-item-title">自定义…</span></span>';
    custom.addEventListener("click", async () => {
      closeModelMenu();
      const typed = await askPrompt("模型名称（需与当前网关兼容）", modelState.model || "", {
        title: "自定义模型",
      });
      if (!typed || !typed.trim()) return;
      await changeModel(typed.trim());
    });
    menu.appendChild(custom);
  }

  function toggleModelMenu() {
    if (taskRunning) return;
    const picker = $("modelPicker");
    const menu = $("modelMenu");
    if (!picker || !menu) return;
    const open = picker.classList.toggle("open");
    menu.classList.toggle("hidden", !open);
    if (open) renderModelMenu();
  }

  async function loadModel() {
    const res = await fetch("/api/model");
    if (!res.ok) return;
    fillModelSelect(await res.json());
  }

  async function changeModel(name) {
    const res = await fetch("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name }),
    });
    if (!res.ok) {
      appendError("无法切换模型: " + (await errorDetail(res)));
      await loadModel();
      return;
    }
    const data = await res.json();
    fillModelSelect(data);
  }

  async function applyWorkspaceUi() {
    currentPath = "";
    selectedDir = "";
    setEditorContent("", "");
    clearChanges();
    setPreviewOpen(false);
    setFilesOpen(false);
    const prevWs = workspacePath;
    await loadWorkspace();
    bindTermsToWorkspace(prevWs);
    await loadTree();
    await loadConversations(true);
  }

  async function setWorkspace(path) {
    const res = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) {
      appendError("无法切换工作区: " + (await errorDetail(res)));
      return;
    }
    await applyWorkspaceUi();
  }

  async function errorDetail(res) {
    const raw = await res.text();
    try {
      const j = JSON.parse(raw);
      if (j && j.detail) return typeof j.detail === "string" ? j.detail : raw;
    } catch (_) {}
    return raw || "请求失败";
  }

  async function createNewWorkspace() {
    if (taskRunning) return;
    let path = "";
    if (window.pywebview && window.pywebview.api && window.pywebview.api.choose_folder) {
      path = await window.pywebview.api.choose_folder();
    } else {
      path = await askPrompt("输入工作区文件夹路径", workspacePath || "", {
        title: "打开工作区",
      });
    }
    if (!path) return;
    await setWorkspace(path);
  }

  async function apiPost(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    return res.json();
  }

  let createDraft = null;
  let createBusy = false;

  function treeItemDepth(row) {
    const pad = parseInt((row && row.style.paddingLeft) || "8", 10);
    return Math.max(0, Math.round((pad - 8) / 12));
  }

  function findFolderKids(dir) {
    const key = String(dir || "").replace(/\\/g, "/");
    const row = Array.from(treeEl.querySelectorAll(".tree-item")).find((el) => {
      return !el.classList.contains("tree-create") && (el.dataset.path || "") === key;
    });
    if (!row) return { kids: treeEl, depth: 1 };
    const wrap = row.parentElement;
    const kids = wrap && wrap.querySelector(":scope > .tree-children");
    if (kids) {
      kids.classList.remove("collapsed");
      const chev = row.querySelector(".chev");
      if (chev) chev.textContent = "▾";
      return { kids, depth: treeItemDepth(row) + 1 };
    }
    return { kids: wrap || treeEl, depth: treeItemDepth(row) + 1 };
  }

  function cancelCreateRow() {
    const row = $("treeCreateRow");
    if (row && row.parentNode) row.parentNode.removeChild(row);
    createDraft = null;
  }

  function queueCreateRow() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (createDraft) insertCreateRow(createDraft.kind, createDraft.dir);
      });
    });
  }

  function insertCreateRow(kind, dir) {
    if (!treeEl) return;
    let input = document.querySelector("#treeCreateRow .tree-create-input");
    if (input) {
      input.focus();
      input.select();
      return;
    }
    const place = findFolderKids(dir);
    const row = document.createElement("div");
    row.id = "treeCreateRow";
    row.className = "tree-item tree-create";
    row.style.paddingLeft = 8 + place.depth * 12 + "px";
    const chev = document.createElement("span");
    chev.className = "chev";
    const icon = document.createElement("i");
    icon.className = "codicon " + (kind === "folder" ? "codicon-new-folder" : "codicon-new-file");
    input = document.createElement("input");
    input.className = "tree-create-input";
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.placeholder = kind === "folder" ? "输入文件夹名" : "输入文件名";
    row.appendChild(chev);
    row.appendChild(icon);
    row.appendChild(input);
    row.addEventListener("mousedown", (e) => e.stopPropagation());
    row.addEventListener("click", (e) => e.stopPropagation());
    if (place.kids.firstChild) place.kids.insertBefore(row, place.kids.firstChild);
    else place.kids.appendChild(row);
    row.scrollIntoView({ block: "nearest" });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finishCreate(kind, dir, input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelCreateRow();
      }
    });
    input.focus();
  }

  function createPath(kind) {
    const dir = selectedDir || parentDir(selectedPath || currentPath) || "";
    createDraft = { kind, dir };
    showDock("files");
    if (treeEl && treeEl.querySelector(".tree-item")) queueCreateRow();
    else loadTree();
  }

  async function finishCreate(kind, dir, rawName) {
    if (createBusy) return;
    const name = String(rawName || "").replace(/\\/g, "/").trim();
    if (!name) return;
    const path = joinPath(dir, name);
    if (!path) return;
    createBusy = true;
    createDraft = null;
    const row = $("treeCreateRow");
    if (row && row.parentNode) row.parentNode.removeChild(row);
    try {
      await apiPost(kind === "file" ? "/api/new-file" : "/api/new-folder", { path });
      selectedPath = path;
      selectedDir = kind === "folder" ? path : parentDir(path);
      await loadTree();
      await loadHistory();
      if (kind === "file") {
        noteFile(path, "create");
        await openFile(path, "write_file");
      } else {
        highlightTree(path);
      }
    } catch (err) {
      appendLog("[资源管理器] " + err.message, "error");
      createDraft = { kind, dir };
      insertCreateRow(kind, dir);
      const input = document.querySelector(".tree-create-input");
      if (input) {
        input.value = name;
        input.focus();
        input.select();
      }
    } finally {
      createBusy = false;
    }
  }

  async function deleteSelected(path) {
    const target = (path || selectedPath || currentPath || "").replace(/\\/g, "/");
    if (!target) {
      appendLog("[资源管理器] 先选中要删除的文件或文件夹", "error");
      return;
    }
    if (!(await askConfirm("确定删除 " + target + " ？", { title: "删除", danger: true, ok: "删除" }))) return;
    try {
      await apiPost("/api/delete", { path: target });
      if (
        currentPath === target ||
        (currentPath && currentPath.startsWith(target + "/"))
      ) {
        currentPath = "";
        setEditorContent("", "");
        setPreviewOpen(false);
      }
      if (selectedPath === target || (selectedPath && selectedPath.startsWith(target + "/"))) {
        selectedPath = "";
      }
      if (selectedDir === target || (selectedDir && selectedDir.startsWith(target + "/"))) {
        selectedDir = parentDir(target);
      }
      changedFiles.set(target, "delete");
      changeDiffs.delete(target);
      await loadTree();
      await loadHistory();
      if (dockTab === "changes") expandHistory(target);
    } catch (err) {
      appendLog("[删除失败] " + err.message, "error");
    }
  }

  async function saveFile() {
    if (historyView || showingDiff) {
      appendLog("[保存] 差异和历史版本不能修改保存，请从文件树打开当前文件后再保存", "meta");
      return;
    }
    if (!currentPath) return;
    try {
      await apiPost("/api/save", { path: currentPath, content: editorValue() });
      dirty = false;
      updateTab();
      setStatus("已保存 " + currentPath);
      loadHistory();
    } catch (err) {
      appendLog("[保存失败] " + err.message, "error");
    }
  }

  function termHasSelection() {
    if (
      termCmd &&
      document.activeElement === termCmd &&
      termCmd.selectionStart !== termCmd.selectionEnd
    ) {
      return true;
    }
    const sel = window.getSelection();
    if (!sel || !String(sel)) return false;
    const box = $("termScroll");
    return !!(box && sel.anchorNode && box.contains(sel.anchorNode));
  }

  function selectedTermText() {
    if (
      termCmd &&
      document.activeElement === termCmd &&
      termCmd.selectionStart !== termCmd.selectionEnd
    ) {
      return termCmd.value.slice(termCmd.selectionStart, termCmd.selectionEnd);
    }
    return String(window.getSelection() || "");
  }

  function insertTermText(text) {
    if (!termCmd || text == null) return;
    const first = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")[0];
    const start = termCmd.selectionStart || 0;
    const end = termCmd.selectionEnd || 0;
    const v = termCmd.value;
    termCmd.value = v.slice(0, start) + first + v.slice(end);
    const pos = start + first.length;
    termCmd.focus();
    try {
      termCmd.setSelectionRange(pos, pos);
    } catch (_) {}
  }

  async function copyTermText() {
    const text = selectedTermText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      try {
        document.execCommand("copy");
      } catch (__) {}
    }
  }

  async function pasteTermText() {
    let text = "";
    try {
      const res = await fetch("/api/clipboard");
      if (res.ok) {
        const data = await res.json();
        text = data && data.text ? String(data.text) : "";
      }
    } catch (_) {}
    if (text) insertTermText(text);
  }

  function placeCtxMenu(el, ev) {
    el.style.left = ev.clientX + "px";
    el.style.top = ev.clientY + "px";
    el.classList.remove("hidden");
    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      el.style.left = Math.max(8, window.innerWidth - rect.width - 8) + "px";
    }
    if (rect.bottom > window.innerHeight) {
      el.style.top = Math.max(8, window.innerHeight - rect.height - 8) + "px";
    }
  }

  function showTermCtx(ev) {
    ev.preventDefault();
    ctxEl.classList.add("hidden");
    if (!termCtxEl) return;
    const copyBtn = termCtxEl.querySelector("[data-term-act='copy']");
    if (copyBtn) copyBtn.disabled = !termHasSelection();
    placeCtxMenu(termCtxEl, ev);
  }

  function scrollTerm() {
    const box = $("termScroll");
    if (box) box.scrollTop = box.scrollHeight;
  }

  function termWrite(text) {
    const sess = currentTerm();
    if (sess) sess.text += text;
    termOut.textContent = sess ? sess.text : "";
    scrollTerm();
  }

  function termRoot() {
    return String(workspacePath || "").replace(/\//g, "\\") || "C:\\";
  }

  function winPath(sess) {
    const root = termRoot();
    const rel = String((sess && sess.cwd) || "").replace(/\//g, "\\");
    if (!rel) return root;
    return root + "\\" + rel;
  }

  function syncTermPrompt() {
    const el = $("termPrompt");
    if (el) el.textContent = winPath(currentTerm()) + ">";
  }

  function cmdBanner() {
    return (
      "Microsoft Windows [版本 10.0.22631.2861]\n" +
      "(c) Microsoft Corporation。保留所有权利。\n\n"
    );
  }

  function currentTerm() {
    return termSessions[termSessIdx] || null;
  }

  function parseCd(command) {
    const m = String(command || "").match(/^cd(?:\s+\/d)?(?:\s+(.*))?$/i);
    if (!m) return null;
    return String(m[1] || "").trim().replace(/^["']|["']$/g, "");
  }

  function resolveCd(sess, dest) {
    if (!dest) return sess.cwd || "";
    let next = dest.replace(/\//g, "\\");
    const root = termRoot();
    if (/^[a-zA-Z]:/.test(next)) {
      const full = next.replace(/\\+$/, "");
      const base = root.toLowerCase();
      if (full.toLowerCase() === base) return "";
      if (full.toLowerCase().startsWith(base + "\\")) {
        return full.slice(root.length).replace(/^\\/, "").replace(/\\/g, "/");
      }
      return null;
    }
    if (next === "\\" || next === "/") return "";
    const parts = [];
    const start = next.startsWith("\\") ? [] : String(sess.cwd || "").split("/").filter(Boolean);
    start.concat(next.replace(/^\\/, "").split("\\")).forEach((part) => {
      if (!part || part === ".") return;
      if (part === "..") parts.pop();
      else parts.push(part);
    });
    return parts.join("/");
  }

  function shellAt(sess, command) {
    if (!sess.cwd) return command;
    return "cd /d \"" + winPath(sess).replace(/"/g, "") + "\" & " + command;
  }

  function renderTermSessions() {
    const list = $("termSessList");
    if (!list) return;
    list.innerHTML = "";
    termSessions.forEach((sess, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "term-sess" + (i === termSessIdx ? " active" : "");
      const name = document.createElement("span");
      name.className = "term-sess-name";
      name.textContent = sess.title;
      btn.appendChild(name);
      btn.addEventListener("click", () => selectTerm(i));
      const close = document.createElement("span");
      close.className = "term-sess-close";
      close.textContent = "×";
      close.title = "删除此终端";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTerm(i);
      });
      btn.appendChild(close);
      list.appendChild(btn);
    });
  }

  function selectTerm(i) {
    if (i < 0 || i >= termSessions.length) return;
    termSessIdx = i;
    const sess = currentTerm();
    termOut.textContent = sess ? sess.text : "";
    termHistory = sess ? sess.history : [];
    termHistIdx = sess ? sess.histIdx : -1;
    syncTermPrompt();
    renderTermSessions();
    scrollTerm();
    if (termCmd) termCmd.focus();
  }

  function addTerm(open) {
    termSeq += 1;
    termSessions.push({
      title: termSeq === 1 ? "命令提示符" : "命令提示符 " + termSeq,
      text: cmdBanner(),
      history: [],
      histIdx: -1,
      cwd: "",
    });
    selectTerm(termSessions.length - 1);
    if (open !== false) showDock("term");
  }

  function closeTerm(i) {
    if (i < 0 || i >= termSessions.length) return;
    termSessions.splice(i, 1);
    if (!termSessions.length) {
      hideDock("term");
      return;
    }
    selectTerm(Math.max(0, Math.min(i, termSessions.length - 1)));
  }

  function nextTerm() {
    if (!termSessions.length) {
      addTerm();
      return;
    }
    if (dockTab === "term") {
      selectTerm((termSessIdx + 1) % termSessions.length);
    }
    showDock("term");
  }

  function stripShellOut(raw) {
    let out = raw || "";
    if (out.startsWith("exit_code=")) {
      const nl = out.indexOf("\n");
      const code = out.slice(0, nl < 0 ? out.length : nl);
      const body = nl < 0 ? "" : out.slice(nl + 1);
      out = body || (code === "exit_code=0" ? "" : code + "\n");
    }
    return out;
  }

  async function runTerm() {
    const command = termCmd.value.trim();
    if (!command) return;
    const sess = currentTerm();
    if (!sess) return;
    sess.history.push(command);
    sess.histIdx = sess.history.length;
    termHistory = sess.history;
    termHistIdx = sess.histIdx;
    termWrite(winPath(sess) + ">" + command + "\n");
    termCmd.value = "";
    const low = command.toLowerCase();
    if (low === "cls") {
      sess.text = "";
      termOut.textContent = "";
      return;
    }
    if (low === "exit") {
      closeTerm(termSessIdx);
      return;
    }
    const cdDest = parseCd(command);
    if (cdDest !== null) {
      const next = resolveCd(sess, cdDest);
      if (next === null) {
        termWrite("系统找不到指定的路径。\n");
        syncTermPrompt();
        return;
      }
      if (!cdDest) {
        termWrite(winPath(sess) + "\n");
        return;
      }
      try {
        const check = await apiPost("/api/shell", {
          command: "cd /d \"" + winPath({ cwd: next }).replace(/"/g, "") + "\"",
        });
        const out = stripShellOut(check.output || "");
        if (/exit_code=[1-9]/.test(check.output || "") || /找不到指定的路径|cannot find/i.test(out)) {
          termWrite((out.trim() || "系统找不到指定的路径。") + "\n");
        } else {
          sess.cwd = next;
          if (out.trim()) termWrite(out.replace(/\s+$/, "") + "\n");
        }
      } catch (err) {
        termWrite(String(err.message || err) + "\n");
      }
      syncTermPrompt();
      return;
    }
    try {
      const data = await apiPost("/api/shell", { command: shellAt(sess, command) });
      const out = stripShellOut(data.output || "");
      if (out) termWrite(out.replace(/\r\n/g, "\n").replace(/\r/g, "\n") + (out.endsWith("\n") ? "" : "\n"));
    } catch (err) {
      termWrite(String(err.message || err) + "\n");
    }
    await loadTree();
  }

  function toggleTerm() {
    nextTerm();
  }

  let tabComp = { matches: [], idx: -1, token: null };

  function termLastToken(value, cursor) {
    const left = String(value || "").slice(0, Math.max(0, cursor || 0));
    let quote = "";
    let start = 0;
    for (let i = 0; i < left.length; i++) {
      const c = left[i];
      if (quote) {
        if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (/\s/.test(c) || c === "&" || c === "|") start = i + 1;
    }
    const raw = left.slice(start);
    const q = raw.startsWith('"') || raw.startsWith("'") ? raw[0] : "";
    const body = (q ? raw.slice(1) : raw).replace(/\//g, "\\");
    const cut = body.lastIndexOf("\\");
    return {
      start,
      quote: q,
      dir: cut >= 0 ? body.slice(0, cut) : "",
      base: cut >= 0 ? body.slice(cut + 1) : body,
    };
  }

  function applyTermMatch(token, match, cursor) {
    const dir = String(token.dir || "").replace(/\//g, "\\");
    let filled = (dir ? dir + "\\" : "") + match.name;
    if (match.dir) filled += "\\";
    if (/\s/.test(filled) || token.quote) filled = '"' + filled.replace(/"/g, "") + '"';
    const right = termCmd.value.slice(cursor);
    termCmd.value = termCmd.value.slice(0, token.start) + filled + right;
    const pos = token.start + filled.length;
    termCmd.focus();
    try {
      termCmd.setSelectionRange(pos, pos);
    } catch (_) {}
  }

  async function completeTerm(back) {
    if (!termCmd) return;
    const cursor = termCmd.selectionStart || 0;
    const sess = currentTerm();
    if (!sess) return;
    if (!tabComp.matches.length || !tabComp.token) {
      const token = termLastToken(termCmd.value, cursor);
      let listRel = sess.cwd || "";
      if (token.dir) {
        const next = resolveCd(sess, token.dir);
        if (next === null) return;
        listRel = next;
      }
      let items = [];
      try {
        const res = await fetch("/api/ls?path=" + encodeURIComponent(listRel));
        if (res.ok) {
          const data = await res.json();
          items = data.items || [];
        }
      } catch (_) {
        return;
      }
      const prefix = token.base.toLowerCase();
      const matches = items.filter((it) => String(it.name || "").toLowerCase().startsWith(prefix));
      if (!matches.length) return;
      tabComp = { matches, idx: back ? matches.length : -1, token };
    }
    const n = tabComp.matches.length;
    tabComp.idx = back ? (tabComp.idx - 1 + n) % n : (tabComp.idx + 1) % n;
    applyTermMatch(tabComp.token, tabComp.matches[tabComp.idx], cursor);
  }

  function handleEvent(evt) {
    const kind = evt.kind;
    const payload = evt.payload || {};
    if (kind === "recall" || kind === "queue") {
      return;
    } else if (kind === "step") {
      setRunText("正在调用模型…");
    } else if (kind === "thinking") {
      setRunText("模型思考中…");
    } else if (kind === "delta") {
      setRunText("模型输出中…");
      appendAssistantDelta(payload.text || "");
    } else if (kind === "assistant") {
      appendAssistant(payload.text || "");
    } else if (kind === "tool") {
      finishAssistantStream();
      setRunText("正在调用 " + (payload.name || "工具") + "…");
      appendToolCard(payload.name, payload.arguments);
    } else if (kind === "tool_result") {
      fillToolResult(payload.name, payload.preview);
    } else if (kind === "final") {
      finishAssistantStream();
      const text = payload.text || "";
      if (text && text !== lastAssistantText) appendAssistant(text);
    } else if (kind === "health") {
      setStatus("工作区 " + workspaceName + "  |  进行中 " + (payload.open || 0) + " 条");
    } else if (kind === "open_file") {
      noteFile(payload.path, payload.reason);
      if (
        payload.reason === "write_file" ||
        payload.reason === "edit_file" ||
        payload.reason === "apply_patch"
      ) {
        loadTree();
        loadHistory();
      }
    } else if (kind === "paused") {
      pausePending = true;
    } else if (kind === "error") {
      const t = payload.text || "错误";
      if (/^已暂停$|^已停止$/.test(String(t).trim())) {
        pausePending = true;
      } else {
        appendError(t, true);
      }
    } else if (kind === "done") {
      finishAssistantStream();
      const wasPaused = pausePending;
      setBusy(false);
      if (wasPaused) rollbackPausedTurn();
      pausePending = false;
      pauseRequested = false;
      loadTree();
      loadWorkspace();
      loadConversations(false);
      loadHistory();
    }
  }

  let chatPoll = null;

  async function startChatJob(task) {
    const started = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task }),
    });
    if (!started.ok) {
      throw new Error((await started.text()) || "HTTP " + started.status);
    }
    return started.json();
  }

  async function pollChatJob(jobId, after) {
    let lastErr = null;
    for (let i = 0; i < 4; i++) {
      try {
        const q = await fetch(
          "/api/chat/poll?job_id=" + encodeURIComponent(jobId) + "&after=" + after
        );
        if (q.ok) return q.json();
        const msg = (await q.text()) || "HTTP " + q.status;
        if (q.status < 500 && q.status !== 429) throw new Error(msg);
        lastErr = new Error(msg);
      } catch (err) {
        if (err && err.message && /HTTP 4/.test(err.message) && !/429/.test(err.message)) {
          throw err;
        }
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
    throw lastErr || new Error("轮询失败");
  }

  async function postChat(task) {
    const started = await startChatJob(task);
    const jobId = started && started.job_id;
    if (!jobId) throw new Error("没有收到任务编号");
    const token = { stop: false };
    chatPoll = token;
    let after = 0;
    try {
      while (!token.stop) {
        const data = await pollChatJob(jobId, after);
        if (data && data.error && !data.done) throw new Error(data.error);
        for (const ev of data.events || []) handleEvent(ev);
        after = data.next || after;
        if (data.done) break;
        await new Promise((r) => setTimeout(r, 80));
      }
    } finally {
      if (chatPoll === token) chatPoll = null;
    }
  }

  function stopTask() {
    if (!taskRunning) return;
    pauseRequested = true;
    setRunText("正在暂停…");
    setStatus("正在暂停…");
    fetch("/api/chat/stop", { method: "POST" }).catch(() => {});
  }

  async function sendTask(task) {
    try {
      if (taskRunning) return;
      if (!task) return;
      lastSentTask = task;
      turnLogMark = logEl.children.length;
      pausePending = false;
      pauseRequested = false;
      pauseRolled = false;
      appendUser(task);
      inputEl.value = "";
      growInput();
      pendingTools.length = 0;
      lastAssistantText = "";
      finishAssistantStream();
      setBusy(true);
      await postChat(task);
    } catch (err) {
      if (pauseRequested) {
        pausePending = true;
      } else {
        try {
          appendError(String(err.message || err), true);
        } catch (_) {}
      }
    } finally {
      if (pausePending) rollbackPausedTurn();
      pausePending = false;
      pauseRequested = false;
      setBusy(false);
    }
  }

  let queuedTask = null;
  setInterval(() => {
    if (queuedTask == null || taskRunning) return;
    const t = queuedTask;
    queuedTask = null;
    sendTask(t);
  }, 50);

  function queueSend() {
    if (taskRunning) {
      stopTask();
      return;
    }
    const task = inputEl.value.trim();
    if (!task) return;
    queuedTask = task;
  }

  function initMonaco() {
    const usePlainEditor = () => {
      if (monacoEditor) return;
      useFallback = true;
      if (editorHost) editorHost.classList.add("hidden");
      if (fallback) {
        fallback.classList.remove("hidden");
        fallback.addEventListener("input", markDirty);
      }
    };
    const start = () => {
      if (!window.require) {
        usePlainEditor();
        return;
      }
      window.require.config({
        paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs" },
      });
      window.require(["vs/editor/editor.main"], () => {
        clearTimeout(timer);
        if (useFallback) return;
        monacoEditor = monaco.editor.create(editorHost, {
          value: "",
          language: "plaintext",
          theme: monacoThemeName(currentTheme()),
          readOnly: false,
          minimap: { enabled: false },
          fontSize: 13,
          automaticLayout: true,
          scrollBeyondLastLine: false,
        });
        monacoEditor.onDidChangeModelContent(markDirty);
        monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveFile);
        layoutEditors();
      });
    };
    const timer = setTimeout(usePlainEditor, 4000);
    if (window.require) {
      start();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js";
    script.async = true;
    script.onload = start;
    script.onerror = usePlainEditor;
    document.head.appendChild(script);
  }

  function bindViewportLayout() {
    const onResize = () => {
      restorePreviewWidth();
      layoutEditors();
    };
    window.addEventListener("resize", onResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", onResize);
    }
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(layoutEditors);
      if (editorHost) ro.observe(editorHost);
      if (previewDrawer) ro.observe(previewDrawer);
      const layoutEl = document.querySelector(".layout");
      if (layoutEl) ro.observe(layoutEl);
    }
    if (previewDrawer) {
      previewDrawer.addEventListener("transitionend", (e) => {
        if (e.propertyName === "transform" || e.propertyName === "width") layoutEditors();
      });
    }
  }

  function closeMenus() {
    document.querySelectorAll(".menu").forEach((el) => el.classList.remove("open"));
    document.querySelectorAll(".menu-drop").forEach((el) => el.classList.add("hidden"));
  }

  function openMenu(name) {
    document.querySelectorAll(".menu").forEach((el) => {
      const on = el.querySelector(".menu-btn") && el.querySelector(".menu-btn").getAttribute("data-menu") === name;
      el.classList.toggle("open", on);
    });
    document.querySelectorAll(".menu-drop").forEach((el) => {
      el.classList.toggle("hidden", el.getAttribute("data-for") !== name);
    });
  }

  function runEditCmd(cmd) {
    const locked = !!(historyView || showingDiff);
    if (locked && (cmd === "undo" || cmd === "redo" || cmd === "cut" || cmd === "paste")) {
      return;
    }
    const previewOpen = previewDrawer && previewDrawer.classList.contains("open");
    if (monacoEditor && previewOpen && !useFallback && !showingDiff) {
      if (cmd === "undo") monacoEditor.trigger("menu", "undo");
      else if (cmd === "redo") monacoEditor.trigger("menu", "redo");
      else if (cmd === "cut") monacoEditor.trigger("menu", "editor.action.clipboardCutAction");
      else if (cmd === "copy") monacoEditor.trigger("menu", "editor.action.clipboardCopyAction");
      else if (cmd === "paste") monacoEditor.trigger("menu", "editor.action.clipboardPasteAction");
      else if (cmd === "selectAll") monacoEditor.trigger("menu", "editor.action.selectAll");
      monacoEditor.focus();
      return;
    }
    try {
      document.execCommand(cmd);
    } catch (_) {}
  }

  function runMenuCmd(cmd) {
    if (cmd === "new-conv") newConversation();
    else if (cmd === "new-ws") createNewWorkspace();
    else if (cmd === "new-file") createPath("file");
    else if (cmd === "new-folder") createPath("folder");
    else if (cmd === "save") saveFile();
    else if (cmd === "undo") runEditCmd("undo");
    else if (cmd === "redo") runEditCmd("redo");
    else if (cmd === "cut") runEditCmd("cut");
    else if (cmd === "copy") runEditCmd("copy");
    else if (cmd === "paste") runEditCmd("paste");
    else if (cmd === "select-all") runEditCmd("selectAll");
    else if (cmd === "delete") deleteSelected();
    else if (cmd === "theme") toggleTheme();
    else if (cmd === "view-changes") openChangesView();
    else if (cmd === "view-files") showDock("files");
    else if (cmd === "view-term") nextTerm();
    else if (cmd === "view-browser") showDock("browser");
    else if (cmd === "close-preview") setPreviewOpen(false);
    else if (cmd === "close-panel" && dockTab) hideDock(dockTab);
  }

  const menubar = $("menubar");
  if (menubar) {
    let menuArmed = false;
    menubar.querySelectorAll(".menu-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const name = btn.getAttribute("data-menu");
        const menu = btn.closest(".menu");
        if (menu && menu.classList.contains("open")) {
          closeMenus();
          menuArmed = false;
          return;
        }
        openMenu(name);
        menuArmed = true;
      });
      btn.addEventListener("mouseenter", () => {
        if (menuArmed) openMenu(btn.getAttribute("data-menu"));
      });
    });
    menubar.addEventListener("click", (e) => {
      const hit = e.target.closest("[data-cmd]");
      if (!hit) return;
      e.stopPropagation();
      const cmd = hit.getAttribute("data-cmd");
      closeMenus();
      menuArmed = false;
      runMenuCmd(cmd);
    });
    document.addEventListener("click", () => {
      closeMenus();
      menuArmed = false;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeMenus();
        menuArmed = false;
      }
    });
  }

  $("btnTheme").addEventListener("click", toggleTheme);
  let browserHist = [];
  let browserHistIdx = -1;

  function normalizeBrowseUrl(raw) {
    let url = String(raw || "").trim();
    if (!url) return "";
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = "https://" + url;
    return url;
  }

  function resetBrowser() {
    browserHist = [];
    browserHistIdx = -1;
    const frame = $("browserFrame");
    const empty = $("browserEmpty");
    const url = $("browserUrl");
    if (frame) {
      frame.src = "about:blank";
      frame.classList.add("hidden");
    }
    if (empty) empty.classList.remove("hidden");
    if (url) url.value = "";
  }

  function browseTo(raw, push) {
    const url = normalizeBrowseUrl(raw);
    if (!url) return;
    const frame = $("browserFrame");
    const empty = $("browserEmpty");
    const box = $("browserUrl");
    if (box) box.value = url;
    if (empty) empty.classList.add("hidden");
    if (frame) {
      frame.classList.remove("hidden");
      frame.src = url;
    }
    if (push !== false) {
      browserHist = browserHist.slice(0, browserHistIdx + 1);
      if (browserHist[browserHist.length - 1] !== url) {
        browserHist.push(url);
        browserHistIdx = browserHist.length - 1;
      }
    }
    showDock("browser");
  }

  $("btnChanges").addEventListener("click", openChangesView);
  $("btnFiles").addEventListener("click", () => showDock("files"));
  $("btnBrowser").addEventListener("click", () => showDock("browser"));
  $("btnBrowserBack").addEventListener("click", () => {
    if (browserHistIdx <= 0) return;
    browserHistIdx -= 1;
    browseTo(browserHist[browserHistIdx], false);
  });
  $("btnBrowserFwd").addEventListener("click", () => {
    if (browserHistIdx >= browserHist.length - 1) return;
    browserHistIdx += 1;
    browseTo(browserHist[browserHistIdx], false);
  });
  $("btnBrowserReload").addEventListener("click", () => {
    const frame = $("browserFrame");
    if (frame && frame.src && frame.src !== "about:blank") frame.src = frame.src;
  });
  $("browserUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      browseTo($("browserUrl").value);
    }
  });
  $("btnClosePreview").addEventListener("click", () => setPreviewOpen(false));
  $("btnNew").addEventListener("click", () => newConversation());
  $("btnNewWs").addEventListener("click", createNewWorkspace);
  $("modelBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleModelMenu();
  });
  document.addEventListener("click", (e) => {
    const picker = $("modelPicker");
    if (picker && !picker.contains(e.target)) closeModelMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModelMenu();
  });
  if (treeEl) {
    treeEl.addEventListener("mousedown", (e) => {
      if (!createDraft) return;
      if (e.target.closest(".tree-create")) return;
      cancelCreateRow();
    });
  }
  $("btnNewFile").addEventListener("click", () => createPath("file"));
  $("btnNewFolder").addEventListener("click", () => createPath("folder"));
  $("btnDeletePath").addEventListener("click", () => deleteSelected());
  $("btnNewFileChange").addEventListener("click", () => createPath("file"));
  $("btnNewFolderChange").addEventListener("click", () => createPath("folder"));
  $("btnDeleteChange").addEventListener("click", () => deleteSelected());
  $("btnSave").addEventListener("click", saveFile);
  $("btnNewTerm").addEventListener("click", addTerm);
  const termScroll = $("termScroll");
  if (termScroll) {
    termScroll.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target === termCmd) return;
      if (window.getSelection && String(window.getSelection())) return;
      if (termCmd) termCmd.focus();
    });
    termScroll.addEventListener("contextmenu", showTermCtx);
  }
  if (termCtxEl) {
    termCtxEl.addEventListener("click", (e) => {
      const hit = e.target.closest("[data-term-act]");
      const act = hit && hit.getAttribute("data-term-act");
      if (!act) return;
      hideCtx();
      if (act === "copy") copyTermText();
      else if (act === "paste") pasteTermText();
    });
  }
  $("btnTermToggle").addEventListener("click", nextTerm);
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    queueSend();
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      queueSend();
    }
  });
  btnSend.addEventListener("click", (e) => {
    e.preventDefault();
    queueSend();
  });
  inputEl.addEventListener("input", growInput);
  document.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      inputEl.value = btn.getAttribute("data-prompt") || "";
      growInput();
      inputEl.focus();
    });
  });
  termCmd.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      completeTerm(!!e.shiftKey);
      return;
    }
    if (e.key !== "Shift") tabComp = { matches: [], idx: -1, token: null };
    if (e.key === "Enter") {
      e.preventDefault();
      runTerm();
    } else if (e.key === "ArrowUp") {
      if (!termHistory.length) return;
      termHistIdx = Math.max(0, termHistIdx - 1);
      termCmd.value = termHistory[termHistIdx] || "";
      const sess = currentTerm();
      if (sess) sess.histIdx = termHistIdx;
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      termHistIdx = Math.min(termHistory.length, termHistIdx + 1);
      termCmd.value = termHistory[termHistIdx] || "";
      const sess = currentTerm();
      if (sess) sess.histIdx = termHistIdx;
      e.preventDefault();
    }
  });
  termCmd.addEventListener("input", () => {
    tabComp = { matches: [], idx: -1, token: null };
  });
  ctxEl.addEventListener("click", (e) => {
    const hit = e.target.closest("[data-act]");
    const act = hit && hit.getAttribute("data-act");
    if (!act) return;
    hideCtx();
    if (act === "open") {
      if (ctxIsDir) {
        selectedDir = ctxTarget;
        highlightTree(ctxTarget);
      } else {
        openFile(ctxTarget);
      }
    } else if (act === "new-file") {
      selectedDir = ctxIsDir ? ctxTarget : parentDir(ctxTarget);
      createPath("file");
    } else if (act === "new-folder") {
      selectedDir = ctxIsDir ? ctxTarget : parentDir(ctxTarget);
      createPath("folder");
    } else if (act === "delete") {
      deleteSelected(ctxTarget);
    }
  });
  document.addEventListener("click", hideCtx);
  if (dlgEl) {
    dlgCancel.addEventListener("click", () => {
      closeDlg(dlgInput && !dlgInput.classList.contains("hidden") ? null : false);
    });
    dlgOk.addEventListener("click", () => {
      const inputMode = dlgInput && !dlgInput.classList.contains("hidden");
      closeDlg(inputMode ? dlgInput.value : true);
    });
    dlgEl.addEventListener("mousedown", (e) => {
      if (e.target === dlgEl) {
        closeDlg(dlgInput && !dlgInput.classList.contains("hidden") ? null : false);
      }
    });
    document.addEventListener(
      "keydown",
      (e) => {
        if (dlgEl.classList.contains("hidden")) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeDlg(dlgInput && !dlgInput.classList.contains("hidden") ? null : false);
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          const inputMode = dlgInput && !dlgInput.classList.contains("hidden");
          closeDlg(inputMode ? dlgInput.value : true);
        }
      },
      true
    );
  }
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveFile();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "`") {
      e.preventDefault();
      nextTerm();
    }
    if (e.key === "Delete" && dockTab === "files") {
      const tag = (e.target && e.target.tagName) || "";
      if (tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        deleteSelected();
      }
    }
    if (e.key === "Escape") {
      setPreviewOpen(false);
      closeModelMenu();
    }
  });

  async function boot() {
    const conv = loadConversations(true).catch(() => {
      appendError("无法加载历史对话，请点「新建」重试");
    });
    const ws = loadWorkspace().catch(() => {
      setStatus("工作区加载失败");
    });
    await conv;
    await Promise.all([
      ws,
      loadModel().catch(() => {}),
      loadHistory(),
      loadTree().catch(() => {
        if (treeEl && !treeEl.children.length) {
          const err = document.createElement("div");
          err.className = "tree-empty";
          err.textContent = "无法读取文件树";
          treeEl.appendChild(err);
        }
      }),
    ]);
  }

  document.querySelectorAll(".dock-tab").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const closer = e.target.closest("[data-close]");
      if (closer) {
        e.preventDefault();
        e.stopPropagation();
        hideDock(closer.getAttribute("data-close"));
        return;
      }
      showDock(btn.getAttribute("data-dock"));
    });
  });
  collapseDock();
  syncThemeChrome(currentTheme());
  bindDockResize();
  bindPreviewResize();
  bindViewportLayout();
  updateTab();
  growInput();
  syncChatEmpty();
  renderChangeList();
  bindConvListDrag();
  boot();
  try {
    initMonaco();
  } catch (_) {
    useFallback = true;
  }
  const markBridge = () => document.documentElement.setAttribute("data-bridge", "1");
  window.addEventListener("pywebviewready", markBridge);
  if (window.pywebview && window.pywebview.api) markBridge();
})();
