// Popup da extensão "PIM Auto Ativar".

const $ = (id) => document.getElementById(id);

let roles = []; // lista vinda do background
let progressByKey = {}; // status de ativação por role.key

const PIM_URL =
  "https://portal.azure.com/#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/azurerbac";

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

// ---------------------------------------------------------------------------
// Preferências (filtro, duração, justificativa) persistidas
// ---------------------------------------------------------------------------
async function loadPrefs() {
  const prefs = await chrome.storage.sync.get([
    "filterPattern",
    "durationHours",
    "justification",
  ]);
  if (prefs.filterPattern) $("filter").value = prefs.filterPattern;
  if (prefs.durationHours) $("duration").value = String(prefs.durationHours);
  if (prefs.justification) $("justification").value = prefs.justification;
}

function savePrefs() {
  chrome.storage.sync.set({
    filterPattern: $("filter").value.trim(),
    durationHours: Number($("duration").value),
    justification: $("justification").value.trim(),
  });
}

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------
function matchesFilter(role) {
  const pat = $("filter").value.trim().toLowerCase();
  if (!pat) return true;
  // Vários termos separados por vírgula: basta um combinar.
  return pat.split(",").some((term) => {
    term = term.trim();
    if (!term) return false;
    return (
      role.roleName.toLowerCase().includes(term) ||
      role.scopeName.toLowerCase().includes(term)
    );
  });
}

function stateLabel(role) {
  const prog = progressByKey[role.key];
  if (prog) {
    if (prog.status === "ok") return { text: "✔ ativada", cls: "ok" };
    if (prog.status === "erro") return { text: "✖ erro", cls: "err" };
    if (prog.status === "ativando") return { text: "… ativando", cls: "warn" };
    if (prog.status === "pendente") return { text: "na fila", cls: "warn" };
  }
  if (role.activeUntil) {
    const until = new Date(role.activeUntil);
    const hh = String(until.getHours()).padStart(2, "0");
    const mm = String(until.getMinutes()).padStart(2, "0");
    return { text: `ativa até ${hh}:${mm}`, cls: "ok" };
  }
  return { text: "elegível", cls: "" };
}

function render() {
  const list = $("list");
  list.textContent = "";
  let shown = 0;
  let checked = 0;

  for (const role of roles) {
    if (!matchesFilter(role)) continue;
    shown++;

    const row = document.createElement("label");
    row.className = "role";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.key = role.key;
    // Pré-marca as que ainda não estão ativas.
    cb.checked = !role.activeUntil && !progressByKey[role.key];
    if (cb.checked) checked++;
    cb.addEventListener("change", updateSummary);

    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = role.roleName;
    const scope = document.createElement("div");
    scope.className = "scope";
    scope.textContent = role.scopeName;
    scope.title = role.scope || "";
    info.append(name, scope);

    const state = document.createElement("span");
    const s = stateLabel(role);
    state.className = "state " + s.cls;
    state.textContent = s.text;

    row.append(cb, info, state);
    list.append(row);

    const prog = progressByKey[role.key];
    if (prog && prog.status === "erro" && prog.message) {
      const msg = document.createElement("div");
      msg.className = "msg";
      msg.textContent = prog.message;
      list.append(msg);
    }
  }

  if (!shown) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = roles.length
      ? "Nenhuma função combina com o filtro."
      : "Nenhuma função elegível encontrada.";
    list.append(empty);
  }
  updateSummary();
}

function selectedRoles() {
  const keys = new Set(
    [...document.querySelectorAll('#list input[type="checkbox"]:checked')].map(
      (cb) => cb.dataset.key
    )
  );
  return roles.filter((r) => keys.has(r.key));
}

function updateSummary() {
  const total = [...document.querySelectorAll('#list input[type="checkbox"]')]
    .length;
  const sel = selectedRoles().length;
  $("summary").textContent = total
    ? `${sel} de ${total} selecionadas`
    : "";
  $("activate").disabled = sel === 0;
}

// ---------------------------------------------------------------------------
// Carregamento
// ---------------------------------------------------------------------------
function setStatus(text, isErr) {
  const el = $("status");
  el.textContent = text;
  el.className = isErr ? "err" : "";
}

async function refresh() {
  setStatus("Carregando funções elegíveis…");
  const tok = await send({ type: "tokenStatus" });
  if (!tok || !tok.hasToken) {
    setStatus(
      "Sem sessão do Azure. Abra o portal (clique aqui) e recarregue. ↻",
      true
    );
    $("status").style.cursor = "pointer";
    $("status").onclick = () => chrome.tabs.create({ url: PIM_URL });
    $("list").innerHTML = '<div class="empty">Aguardando sessão do portal…</div>';
    return;
  }
  const resp = await send({ type: "listRoles" });
  if (!resp || !resp.ok) {
    setStatus("Erro ao listar: " + (resp ? resp.error : "sem resposta"), true);
    return;
  }
  roles = resp.roles;
  setStatus(`${roles.length} função(ões) elegível(is) na sua conta.`);
  render();
}

// Acompanha o progresso da ativação feito pelo background.
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.progress) {
    const p = changes.progress.newValue || {};
    progressByKey = {};
    for (const item of p.items || []) progressByKey[item.key] = item;
    if (p.running) {
      setStatus("Ativando… (pode fechar o popup, continua sozinho)");
    } else if (p.items) {
      const ok = p.items.filter((i) => i.status === "ok").length;
      const err = p.items.filter((i) => i.status === "erro").length;
      setStatus(
        `Concluído: ${ok} ativada(s)` + (err ? `, ${err} com erro.` : ".")
      );
    }
    render();
  }
});

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
$("activate").addEventListener("click", async () => {
  savePrefs();
  const sel = selectedRoles();
  if (!sel.length) return;
  $("activate").disabled = true;
  await send({
    type: "activate",
    roles: sel,
    durationHours: Number($("duration").value),
    justification:
      $("justification").value.trim() || "Ativação diária de rotina",
  });
});

$("reload").addEventListener("click", refresh);
$("filter").addEventListener("input", () => {
  savePrefs();
  render();
});
$("duration").addEventListener("change", savePrefs);
$("justification").addEventListener("change", savePrefs);

$("toggleAll").addEventListener("click", () => {
  const cbs = [...document.querySelectorAll('#list input[type="checkbox"]')];
  const allChecked = cbs.length > 0 && cbs.every((cb) => cb.checked);
  cbs.forEach((cb) => (cb.checked = !allChecked));
  updateSummary();
});

(async () => {
  await loadPrefs();
  // Recupera progresso de uma ativação ainda em andamento, se houver.
  const { progress } = await chrome.storage.session.get("progress");
  if (progress && progress.items) {
    for (const item of progress.items) progressByKey[item.key] = item;
  }
  await refresh();
})();
