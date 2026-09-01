/*
 * PIM Auto Ativar — versão para colar no CONSOLE (sem instalar extensão).
 *
 * Como usar (no PC do trabalho):
 * 1. Abra o portal do Azure logado, de preferência na tela do PIM:
 *    https://portal.azure.com/#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/azurerbac
 * 2. Aperte F12 → aba "Console".
 *    (Se o Chrome recusar colar, digite "allow pasting" no console e Enter.)
 * 3. Ajuste o FILTRO abaixo se quiser, cole o script inteiro e dê Enter.
 * 4. Ele lista suas funções elegíveis. Para ativar, digite:  pimAtivar()
 *    - pimAtivar()            → ativa todas que combinam com o FILTRO
 *    - pimAtivar("outro")     → usa outro filtro só desta vez
 *    - pimListar()            → mostra a lista de novo
 *
 * Obs.: NÃO dê F5 na página depois de colar (o script some da memória).
 */
(() => {
  // ========================= CONFIGURAÇÃO =========================
  const FILTRO = ""; // parte do nome da função ou do recurso; vários termos separados por vírgula; "" = todas
  const HORAS = 8; // duração da ativação (máx. 8)
  const JUSTIFICATIVA = "Ativação diária de rotina";
  // ================================================================

  const ARM = "https://management.azure.com";
  const API = "2020-10-01";
  const TAG = "%c[PIM]";
  const ST = "color:#0067b8;font-weight:bold";
  const log = (...a) => console.log(TAG, ST, ...a);

  const VERSAO = 2;
  let token = null;
  let roles = [];
  const urlsVistas = []; // buffer de URLs que o portal chamou (para pimDebug)
  const registrarUrl = (url) => {
    try {
      const u = String(url);
      if (
        /management\.azure\.com|azrbac|mspim|privilegedaccess|roleEligibility|roleAssignment/i.test(u)
      ) {
        urlsVistas.push(u.slice(0, 300));
        if (urlsVistas.length > 300) urlsVistas.shift();
      }
    } catch {}
  };

  // ---- Captura do token: observa as chamadas que o próprio portal faz ----
  const getHeader = (headers, name) => {
    try {
      if (!headers) return null;
      if (typeof headers.get === "function") return headers.get(name);
      if (Array.isArray(headers)) {
        const h = headers.find((x) => x[0].toLowerCase() === name.toLowerCase());
        return h ? h[1] : null;
      }
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === name.toLowerCase()) return headers[k];
      }
    } catch {}
    return null;
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input && input.url;
      registrarUrl(url);
      if (url && url.includes("management.azure.com")) {
        let auth = init && getHeader(init.headers, "Authorization");
        if (!auth && input && typeof input.headers?.get === "function") {
          auth = input.headers.get("Authorization");
        }
        if (auth && auth.startsWith("Bearer ")) token = auth;
      }
    } catch {}
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__pimUrl = url;
    registrarUrl(url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (
        String(this.__pimUrl || "").includes("management.azure.com") &&
        name.toLowerCase() === "authorization" &&
        String(value).startsWith("Bearer ")
      ) {
        token = value;
      }
    } catch {}
    return origSetHeader.apply(this, arguments);
  };

  async function esperarToken(timeoutMs = 120000) {
    if (token) return token;
    log(
      "Aguardando o portal fazer alguma chamada para capturar sua sessão…\n" +
        "→ Clique em 'Atualizar' na tela do PIM, ou navegue em qualquer lista do portal."
    );
    const inicio = Date.now();
    while (!token) {
      if (Date.now() - inicio > timeoutMs) {
        throw new Error(
          "Não capturei o token em 2 min. Clique em algo que carregue dados no portal e rode o script de novo."
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return token;
  }

  // ---- Chamadas à API (as mesmas que a tela do PIM usa) ----
  async function armFetch(path, options = {}) {
    const url = path.startsWith("https://") ? path : ARM + path;
    const resp = await origFetch(url, {
      ...options,
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await resp.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    if (!resp.ok) {
      const msg =
        (body && body.error && (body.error.message || body.error.code)) ||
        `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return body;
  }

  async function armFetchAll(path) {
    let url = path;
    const all = [];
    while (url) {
      const body = await armFetch(url);
      if (body && Array.isArray(body.value)) all.push(...body.value);
      url = body && body.nextLink ? body.nextLink : null;
    }
    return all;
  }

  function combinaFiltro(role, filtro) {
    const pat = (filtro || "").trim().toLowerCase();
    if (!pat) return true;
    return pat.split(",").some((t) => {
      t = t.trim();
      return (
        t &&
        (role.roleName.toLowerCase().includes(t) ||
          role.scopeName.toLowerCase().includes(t))
      );
    });
  }

  // Consulta um tipo de instância (eligibility/assignment) em vários escopos e
  // junta tudo sem duplicatas (a mesma função pode aparecer por herança).
  async function coletarInstancias(tipo, escopos) {
    const porId = new Map();
    for (const escopo of escopos) {
      try {
        const itens = await armFetchAll(
          `${escopo}/providers/Microsoft.Authorization/${tipo}?api-version=${API}&$filter=asTarget()`
        );
        for (const it of itens) porId.set((it.id || "").toLowerCase(), it);
      } catch (e) {
        console.warn(`[PIM] Falha ao consultar ${tipo} em ${escopo}:`, e.message || e);
      }
    }
    return [...porId.values()];
  }

  async function descobrirEscopos() {
    const escopos = [];
    // Assinaturas visíveis para o usuário:
    try {
      const subs = await armFetchAll(`/subscriptions?api-version=2020-01-01`);
      for (const s of subs) escopos.push(`/subscriptions/${s.subscriptionId}`);
      log(`${subs.length} assinatura(s) visível(is).`);
    } catch (e) {
      console.warn("[PIM] Não consegui listar assinaturas:", e.message || e);
    }
    // Grupos de gerenciamento (nem todo usuário enxerga; falha é normal):
    try {
      const mgs = await armFetchAll(
        `/providers/Microsoft.Management/managementGroups?api-version=2021-04-01`
      );
      for (const m of mgs) escopos.push(`/providers/Microsoft.Management/managementGroups/${m.name}`);
    } catch {}
    return escopos;
  }

  async function carregar() {
    await esperarToken();
    log("Sessão capturada. Buscando suas funções elegíveis…");
    // 1ª tentativa: consulta única no escopo raiz (funciona em alguns tenants).
    let [eligible, active] = await Promise.all([
      armFetchAll(
        `/providers/Microsoft.Authorization/roleEligibilityScheduleInstances?api-version=${API}&$filter=asTarget()`
      ).catch(() => []),
      armFetchAll(
        `/providers/Microsoft.Authorization/roleAssignmentScheduleInstances?api-version=${API}&$filter=asTarget()`
      ).catch(() => []),
    ]);

    // 2ª tentativa: se veio vazio, pergunta escopo por escopo (como o portal faz).
    if (!eligible.length) {
      log("Consulta global veio vazia — varrendo assinatura por assinatura…");
      const escopos = await descobrirEscopos();
      if (escopos.length) {
        [eligible, active] = await Promise.all([
          coletarInstancias("roleEligibilityScheduleInstances", escopos),
          coletarInstancias("roleAssignmentScheduleInstances", escopos),
        ]);
      } else {
        log(
          "Nenhuma assinatura visível. Rode pimDebug() após clicar em 'Atualizar' na tela do PIM e me envie as URLs listadas."
        );
      }
    }

    const ativas = new Map();
    for (const a of active) {
      const p = a.properties || {};
      if (p.assignmentType === "Activated") {
        ativas.set(
          `${(p.scope || "").toLowerCase()}|${(p.roleDefinitionId || "").toLowerCase()}`,
          p.endDateTime || null
        );
      }
    }

    roles = eligible.map((e) => {
      const p = e.properties || {};
      const xp = p.expandedProperties || {};
      const key = `${(p.scope || "").toLowerCase()}|${(p.roleDefinitionId || "").toLowerCase()}`;
      return {
        roleName: (xp.roleDefinition && xp.roleDefinition.displayName) || "?",
        scopeName: (xp.scope && xp.scope.displayName) || p.scope || "?",
        scope: p.scope,
        roleDefinitionId: p.roleDefinitionId,
        principalId: p.principalId,
        roleEligibilityScheduleId: p.roleEligibilityScheduleId,
        activeUntil: ativas.get(key) || null,
      };
    });
    return roles;
  }

  function listar(filtro = FILTRO) {
    console.table(
      roles.map((r, i) => ({
        "#": i,
        Função: r.roleName,
        Recurso: r.scopeName,
        Filtro: combinaFiltro(r, filtro) ? "✔" : "",
        Status: r.activeUntil
          ? "ativa até " + new Date(r.activeUntil).toLocaleTimeString("pt-BR")
          : "elegível",
      }))
    );
  }

  async function ativarUma(role) {
    const guid = crypto.randomUUID();
    await armFetch(
      `${role.scope}/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/${guid}?api-version=${API}`,
      {
        method: "PUT",
        body: JSON.stringify({
          properties: {
            principalId: role.principalId,
            roleDefinitionId: role.roleDefinitionId,
            requestType: "SelfActivate",
            linkedRoleEligibilityScheduleId: role.roleEligibilityScheduleId,
            justification: JUSTIFICATIVA,
            scheduleInfo: {
              startDateTime: new Date().toISOString(),
              expiration: { type: "AfterDuration", duration: `PT${HORAS}H` },
            },
          },
        }),
      }
    );
  }

  window.pimListar = () => listar();

  // Diagnóstico: mostra as URLs de PIM/ARM que o portal chamou (clique em
  // "Atualizar" na tela do PIM antes, para forçar as chamadas).
  window.pimDebug = () => {
    const relevantes = urlsVistas.filter((u) =>
      /roleEligibility|roleAssignment|azrbac|mspim|privilegedaccess/i.test(u)
    );
    console.log("[PIM] URLs capturadas:");
    (relevantes.length ? relevantes : urlsVistas).forEach((u) => console.log("  " + u));
    if (!urlsVistas.length) console.log("  (nenhuma ainda — clique em 'Atualizar' na tela do PIM)");
  };

  window.pimAtivar = async (filtro = FILTRO) => {
    const alvo = roles.filter((r) => combinaFiltro(r, filtro) && !r.activeUntil);
    if (!alvo.length) {
      log("Nada para ativar (nenhuma elegível combina com o filtro, ou todas já estão ativas).");
      return;
    }
    log(`Ativando ${alvo.length} função(ões) por ${HORAS}h…`);
    let ok = 0,
      erro = 0;
    for (const r of alvo) {
      try {
        await ativarUma(r);
        ok++;
        log(`✔ ${r.roleName} @ ${r.scopeName}`);
      } catch (e) {
        const msg = String(e.message || e);
        if (/RoleAssignmentExists|already exists/i.test(msg)) {
          ok++;
          log(`✔ ${r.roleName} @ ${r.scopeName} (já estava ativa)`);
        } else {
          erro++;
          console.error(`[PIM] ✖ ${r.roleName} @ ${r.scopeName}: ${msg}`);
          if (/MfaRule|MFA/i.test(msg))
            log("   ↳ essa função exige MFA na ativação — ative-a manualmente no portal.");
          if (/ExpirationRule|duration/i.test(msg))
            log("   ↳ a política dessa função permite menos horas — diminua HORAS no topo do script.");
        }
      }
    }
    log(`Concluído: ${ok} ativada(s), ${erro} com erro.`);
    if (ok) log("Atualize a tela do PIM para ver as funções ativas.");
  };

  // ---- Início ----
  log(`v${VERSAO} carregado.`);
  carregar()
    .then(() => {
      log(`${roles.length} função(ões) elegível(is) encontradas:`);
      if (!roles.length) {
        log(
          "Lista vazia. Clique em 'Atualizar' na tela do PIM, digite pimDebug() e me envie as URLs que aparecerem."
        );
        return;
      }
      listar();
      const n = roles.filter((r) => combinaFiltro(r, FILTRO) && !r.activeUntil).length;
      log(
        n
          ? `Digite pimAtivar() e Enter para ativar as ${n} marcadas com ✔ (${HORAS}h cada).`
          : "Todas as funções do filtro já estão ativas. (pimListar() mostra a lista de novo)"
      );
    })
    .catch((e) => console.error("[PIM] Erro:", e.message || e));
})();
