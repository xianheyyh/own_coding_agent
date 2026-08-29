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
  const filesDrawer = $("filesDrawer");
  const previewDrawer = $("previewDrawer");
  const changeListEl = $("changeList");

  let monacoEditor = null;
  let useFallback = false;
  let applying = false;
  let currentPath = "";
  let selectedDir = "";
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
  let activeConvId = "";
  const changedFiles = new Map();
  let historyIndex = [];
  let expandedHistPath = "";
  let histVersions = [];
  let historyView = null;
  const pendingTools = [];
  let lastAssistantText = "";
  let streamWrap = null;
  let streamBody = null;
  let streamRaw = "";

  const TOOL_META = {
    read_file: { icon: "codicon-go-to-file", label: "读取", tone: "read" },
    write_file: { icon: "codicon-new-file", label: "写入", tone: "write" },
    edit_file: { icon: "codicon-diff", label: "修改", tone: "edit" },
    list_dir: { icon: "codicon-folder", label: "列出目录", tone: "read" },
    run_shell: { icon: "codicon-terminal", label: "终端", tone: "shell" },
    remember: { icon: "codicon-bookmark", label: "记住", tone: "mem" },
    update_memory: { icon: "codicon-edit", label: "更新记忆", tone: "mem" },
    forget: { icon: "codicon-discard", label: "废弃记忆", tone: "mem" },
    recall: { icon: "codicon-search", label: "召回约定", tone: "mem" },
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
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
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
    tabName.textContent = (dirty ? "● " : "") + name;
    const empty = $("editorEmpty");
    if (empty) empty.classList.toggle("hidden", !!currentPath);
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
      row.className = "hist-item" + (historyView && historyView.id === item.id ? " active" : "");
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
      wrap.className = "change-block" + (path === currentPath ? " open" : "");
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
      if (meta && meta.count) {
        const n = document.createElement("span");
        n.className = "change-n";
        n.textContent = meta.count + " 版";
        row.appendChild(n);
      }
      row.addEventListener("click", () => {
        openFile(path, reason, false);
        expandHistory(path);
      });
      wrap.appendChild(row);
      if (expandedHistPath === path) wrap.appendChild(renderHistList(path));
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
      const res = await fetch("/api/history/versions?path=" + encodeURIComponent(path));
      if (res.ok) {
        const data = await res.json();
        if (expandedHistPath === path) histVersions = data.items || [];
      }
    } catch (_) {}
    renderChangeList();
  }

  async function viewHistory(path, id, missing) {
    if (missing) {
      historyView = { path, id };
      setEditorContent(path, "");
      setPreviewOpen(true);
      renderChangeList();
      setStatus("该版本时文件还不存在");
      return;
    }
    const res = await fetch(
      "/api/history/content?path=" + encodeURIComponent(path) + "&id=" + encodeURIComponent(id)
    );
    if (!res.ok) {
      appendLog("[历史] 无法打开这个版本", "error");
      return;
    }
    const data = await res.json();
    historyView = { path, id };
    setEditorContent(path, data.content || "");
    setPreviewOpen(true);
    renderChangeList();
  }

  async function restoreHistory(path, id, missing) {
    const tip = missing ? "回退将删除当前文件。继续？" : "把 " + path + " 回退到这个版本？";
    if (!window.confirm(tip)) return;
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
    filesDrawer.classList.toggle("open", open);
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
      const convList = $("convList");
      const icon = $("sendIcon");
      const runBar = $("runBar");
      const statusIcon = $("statusIcon");
      if (btnNew) btnNew.disabled = taskRunning;
      if (convList) convList.style.pointerEvents = taskRunning ? "none" : "";
      if (taskRunning) {
        if (btnSend) {
          btnSend.classList.add("is-stop");
          btnSend.title = "停止";
        }
        if (icon) icon.className = "codicon codicon-debug-stop";
        if (runBar) runBar.classList.remove("hidden");
        if (statusIcon) statusIcon.className = "codicon codicon-sync spin";
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
    convGroups(data).forEach((group) => {
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
      if (group && !e.target.closest(".ws-chev") && !e.target.closest(".conv-item")) {
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
        fillToolResult(m.name, preview, false);
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

  async function newConversation() {
    if (taskRunning) return;
    const res = await fetch("/api/conversations", { method: "POST" });
    if (!res.ok) {
      appendLog("[错误] 无法新建对话", "error");
      return;
    }
    applyConvState(await res.json(), true);
    clearChanges();
    setPreviewOpen(false);
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
      await loadWorkspace();
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

  function toolSummary(name, args) {
    if (args.path) return args.path;
    if (args.command) return args.command;
    if (args.query) return args.query;
    if (args.fact) return String(args.fact).slice(0, 80);
    const keys = Object.keys(args || {});
    return keys.length ? keys.join(", ") : "";
  }

  function lineDiff(oldText, newText) {
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
    const ctxStart = Math.max(0, i - 2);
    for (let k = ctxStart; k < i; k++) rows.push({ t: "ctx", v: a[k] });
    for (let k = i; k <= ai; k++) rows.push({ t: "del", v: a[k] });
    for (let k = i; k <= bi; k++) rows.push({ t: "add", v: b[k] });
    const ctxEnd = Math.min(a.length, ai + 3);
    for (let k = ai + 1; k < ctxEnd; k++) rows.push({ t: "ctx", v: a[k] });
    return rows;
  }

  function renderDiff(oldText, newText) {
    const wrap = document.createElement("div");
    wrap.className = "diff-block";
    lineDiff(oldText, newText).forEach((row) => {
      const line = document.createElement("div");
      line.className = "diff-line diff-" + row.t;
      const mark = row.t === "add" ? "+" : row.t === "del" ? "-" : " ";
      line.textContent = mark + " " + (row.v || "");
      wrap.appendChild(line);
    });
    return wrap;
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

  function appendChip(kind, text) {
    const wrap = document.createElement("div");
    wrap.className = "msg-chip msg-chip-" + kind;
    wrap.textContent = text;
    logEl.appendChild(wrap);
    scrollLog();
  }

  function appendError(text) {
    const wrap = document.createElement("div");
    wrap.className = "msg msg-error";
    wrap.textContent = text;
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
    }
    card.appendChild(head);
    card.appendChild(body);
    logEl.appendChild(card);
    pendingTools.push({ el: card, result: result, name: name, args: args });
    scrollLog();
  }

  function fillToolResult(name, preview, toTerm) {
    const item = pendingTools.shift();
    const text = preview || "";
    if (!item) {
      appendMeta("← " + text);
      return;
    }
    item.result.textContent = text;
    item.result.classList.remove("hidden");
    if (toTerm && (item.name === "run_shell" || name === "run_shell")) {
      termWrite(text + (text.endsWith("\n") ? "" : "\n"));
    }
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
    if (monacoEditor) monacoEditor.updateOptions({ readOnly: !!historyView });
    if (fallback) fallback.readOnly = !!historyView;
  }

  function markDirty() {
    if (applying || historyView || !currentPath) return;
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
  }

  function showCtx(ev, path, isDir) {
    ev.preventDefault();
    ctxTarget = path;
    ctxIsDir = isDir;
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
        selectedDir = node.path || "";
        highlightTree(node.path || "");
      });
    } else {
      row.addEventListener("click", () => openFile(node.path));
    }
    return wrap;
  }

  async function loadTree() {
    if (!treeEl) return;
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
  }

  async function loadWorkspace() {
    const res = await fetch("/api/workspace");
    const data = await res.json();
    workspaceName = data.name;
    workspacePath = data.path;
    workspaceLabel.textContent = data.path;
    const composerWs = $("composerWs");
    if (composerWs) composerWs.textContent = data.name;
    $("termPrompt").textContent = data.name + ">";
    if (!taskRunning) setStatus("工作区 " + data.name + "  |  进行中 " + data.open_tasks + " 条");
  }

  async function setWorkspace(path) {
    const res = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) {
      appendLog("[错误] 无法切换工作区", "error");
      return;
    }
    currentPath = "";
    selectedDir = "";
    setEditorContent("", "");
    clearChanges();
    setPreviewOpen(false);
    setFilesOpen(false);
    appendLog("[工作区] " + path, "meta");
    await loadWorkspace();
    await loadTree();
    await loadConversations(true);
  }

  async function pickFolder() {
    if (window.pywebview && window.pywebview.api && window.pywebview.api.choose_folder) {
      const path = await window.pywebview.api.choose_folder();
      if (path) await setWorkspace(path);
      return;
    }
    const path = window.prompt("工作区路径", workspaceLabel.textContent);
    if (path) await setWorkspace(path);
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

  async function createPath(kind) {
    const base = selectedDir || "";
    const name = window.prompt(kind === "file" ? "新文件名（相对当前目录）" : "新文件夹名");
    if (!name) return;
    const path = joinPath(base, name);
    if (!path) return;
    try {
      await apiPost(kind === "file" ? "/api/new-file" : "/api/new-folder", { path });
      await loadTree();
      setFilesOpen(true);
      if (kind === "file") await openFile(path, "write_file");
      else selectedDir = path;
    } catch (err) {
      appendLog("[资源管理器] " + err.message, "error");
    }
  }

  async function saveFile() {
    if (historyView) {
      appendLog("[保存] 正在看历史版本，请先点「回退」或重新打开当前文件", "meta");
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

  function termWrite(text) {
    termOut.textContent += text;
    termOut.scrollTop = termOut.scrollHeight;
  }

  async function runTerm() {
    const command = termCmd.value.trim();
    if (!command) return;
    termHistory.push(command);
    termHistIdx = termHistory.length;
    termWrite((termOut.textContent ? "\n" : "") + workspaceName + "> " + command + "\n");
    termCmd.value = "";
    try {
      const data = await apiPost("/api/shell", { command });
      termWrite((data.output || "") + "\n");
    } catch (err) {
      termWrite(String(err.message || err) + "\n");
    }
    await loadTree();
  }

  function toggleTerm(show) {
    const hide = show === undefined ? !termPane.classList.contains("collapsed") : !show;
    termPane.classList.toggle("collapsed", hide);
    if (!hide) termCmd.focus();
    requestAnimationFrame(layoutEditors);
  }

  function handleEvent(evt) {
    const kind = evt.kind;
    const payload = evt.payload || {};
    if (kind === "recall") {
      appendChip("recall", payload.ids ? "召回 " + payload.ids : "无情节召回");
    } else if (kind === "queue") {
      appendChip("queue", "队列 " + payload.mode + (payload.id ? " " + payload.id : ""));
    } else if (kind === "step") {
      appendChip("step", "第 " + payload.step + "/" + payload.max + " 轮");
      setRunText("第 " + payload.step + " 轮 · 正在调用模型…");
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
      fillToolResult(payload.name, payload.preview, true);
    } else if (kind === "final") {
      finishAssistantStream();
      const text = payload.text || "";
      if (text && text !== lastAssistantText) appendAssistant(text);
    } else if (kind === "health") {
      const notes = (payload.notes || []).join("；");
      if (notes) appendChip("health", notes);
      setStatus("工作区 " + workspaceName + "  |  进行中 " + (payload.open || 0) + " 条");
    } else if (kind === "open_file") {
      noteFile(payload.path, payload.reason);
      if (payload.reason === "write_file" || payload.reason === "edit_file") {
        loadTree();
        loadHistory();
      }
    } else if (kind === "error") {
      appendError(payload.text || "错误");
    } else if (kind === "done") {
      finishAssistantStream();
      setBusy(false);
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
    const q = await fetch(
      "/api/chat/poll?job_id=" + encodeURIComponent(jobId) + "&after=" + after
    );
    if (!q.ok) throw new Error((await q.text()) || "HTTP " + q.status);
    return q.json();
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
    setRunText("正在停止…");
    if (chatPoll) chatPoll.stop = true;
    try {
      fetch("/api/chat/stop", { method: "POST" });
    } catch (_) {
      /* ignore */
    }
    finishAssistantStream();
    setBusy(false);
    setStatus("已停止");
  }

  async function sendTask(task) {
    try {
      if (taskRunning) return;
      if (!task) return;
      appendUser(task);
      inputEl.value = "";
      growInput();
      pendingTools.length = 0;
      lastAssistantText = "";
      finishAssistantStream();
      setBusy(true);
      await postChat(task);
    } catch (err) {
      try {
        appendError(String(err.message || err));
      } catch (_) {}
    } finally {
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
    const task = inputEl.value.trim();
    if (!task) return;
    if (taskRunning) {
      stopTask();
      return;
    }
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
    window.addEventListener("resize", layoutEditors);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", layoutEditors);
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

  $("btnTheme").addEventListener("click", toggleTheme);
  $("btnBrowse").addEventListener("click", pickFolder);
  $("btnFiles").addEventListener("click", () => {
    const open = !filesDrawer.classList.contains("open");
    setFilesOpen(open);
    if (open) loadTree();
  });
  $("btnCloseFiles").addEventListener("click", () => setFilesOpen(false));
  $("btnClosePreview").addEventListener("click", () => setPreviewOpen(false));
  $("btnNew").addEventListener("click", newConversation);
  $("btnNewFile").addEventListener("click", () => createPath("file"));
  $("btnNewFolder").addEventListener("click", () => createPath("folder"));
  $("btnSave").addEventListener("click", saveFile);
  $("btnTermHide").addEventListener("click", () => toggleTerm(false));
  $("btnTermToggle").addEventListener("click", () => toggleTerm());
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
    if (e.key === "Enter") {
      e.preventDefault();
      runTerm();
    } else if (e.key === "ArrowUp") {
      if (!termHistory.length) return;
      termHistIdx = Math.max(0, termHistIdx - 1);
      termCmd.value = termHistory[termHistIdx] || "";
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      termHistIdx = Math.min(termHistory.length, termHistIdx + 1);
      termCmd.value = termHistory[termHistIdx] || "";
      e.preventDefault();
    }
  });
  ctxEl.addEventListener("click", (e) => {
    const act = e.target.dataset && e.target.dataset.act;
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
    }
  });
  document.addEventListener("click", hideCtx);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveFile();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "`") {
      e.preventDefault();
      toggleTerm();
    }
    if (e.key === "Escape") {
      setPreviewOpen(false);
      setFilesOpen(false);
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

  termWrite("工作区终端。命令在项目根目录执行。Ctrl+` 显示或隐藏。\n");
  syncThemeChrome(currentTheme());
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
