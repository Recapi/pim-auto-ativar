// Service worker da extensão "PIM Auto Ativar".
//
// Como funciona:
// 1. Observa (somente leitura) as requisições que o portal do Azure faz para
//    management.azure.com e guarda o token Bearer da sua própria sessão.
//    Nenhuma senha é lida — é o mesmo token que o portal já usa.
// 2. Quando o popup pede, lista suas funções elegíveis do PIM (Azure RBAC) e
//    as já ativas, usando a API pública do ARM.
// 3. Ao clicar em "Ativar", cria um roleAssignmentScheduleRequest
//    (SelfActivate) para cada função selecionada.

const ARM = "https://management.azure.com";
const API_VERSION = "2020-10-01";

// ---------------------------------------------------------------------------
// Captura do token (mesma sessão do portal, só observando os headers)
// ---------------------------------------------------------------------------
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const auth = (details.requestHeaders || []).find(
      (h) => h.name.toLowerCase() === "authorization"
    );
    if (auth && auth.value && auth.value.startsWith("Bearer ")) {
      chrome.storage.session.set({
        armToken: auth.value,
        tokenAt: Date.now(),
      });
    }
  },
  { urls: [ARM + "/*"] },
  ["requestHeaders", "extraHeaders"]
);

async function getToken() {
  const { armToken, tokenAt } = await chrome.storage.session.get([
    "armToken",
    "tokenAt",
  ]);
  if (!armToken) return null;
  // Tokens do ARM duram ~1h; consideramos velho depois de 50 min.
  if (Date.now() - tokenAt > 50 * 60 * 1000) return null;
  return armToken;
}

async function armFetch(path, options = {}) {
  const token = await getToken();
  if (!token) {
    throw new Error(
      "SEM_TOKEN: abra (ou atualize com F5) uma aba do portal.azure.com e tente de novo."
    );
  }
  const url = path.startsWith("https://") ? path : ARM + path;
  const resp = await fetch(url, {
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
  } catch {
    body = null;
  }
  if (!resp.ok) {
    const msg =
      (body && body.error && (body.error.message || body.error.code)) ||
      `HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }
  return body;
}

// Segue nextLink para juntar todas as páginas de resultado.
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

// ---------------------------------------------------------------------------
// Listagem: funções elegíveis + já ativas
// ---------------------------------------------------------------------------
async function listRoles() {
  const [eligible, active] = await Promise.all([
    armFetchAll(
      `/providers/Microsoft.Authorization/roleEligibilityScheduleInstances?api-version=${API_VERSION}&$filter=asTarget()`
    ),
    armFetchAll(
      `/providers/Microsoft.Authorization/roleAssignmentScheduleInstances?api-version=${API_VERSION}&$filter=asTarget()`
    ),
  ]);

  // Conjunto de pares (scope + roleDefinitionId) já ativados, para marcar na lista.
  const activeKeys = new Map();
  for (const a of active) {
    const p = a.properties || {};
    if (p.assignmentType === "Activated") {
      activeKeys.set(
        `${(p.scope || "").toLowerCase()}|${(p.roleDefinitionId || "").toLowerCase()}`,
        p.endDateTime || null
      );
    }
  }

  return eligible.map((e) => {
    const p = e.properties || {};
    const xp = p.expandedProperties || {};
    const key = `${(p.scope || "").toLowerCase()}|${(p.roleDefinitionId || "").toLowerCase()}`;
    return {
      key,
      roleName: (xp.roleDefinition && xp.roleDefinition.displayName) || "?",
      scopeName: (xp.scope && xp.scope.displayName) || p.scope || "?",
      scopeType: (xp.scope && xp.scope.type) || "",
      scope: p.scope,
      roleDefinitionId: p.roleDefinitionId,
      principalId: p.principalId,
      roleEligibilityScheduleId: p.roleEligibilityScheduleId,
      activeUntil: activeKeys.get(key) || null,
    };
  });
}

// ---------------------------------------------------------------------------
// Ativação (SelfActivate)
// ---------------------------------------------------------------------------
async function activateOne(role, durationHours, justification) {
  const guid = crypto.randomUUID();
  const body = {
    properties: {
      principalId: role.principalId,
      roleDefinitionId: role.roleDefinitionId,
      requestType: "SelfActivate",
      linkedRoleEligibilityScheduleId: role.roleEligibilityScheduleId,
      justification: justification || "Ativação diária de rotina",
      scheduleInfo: {
        startDateTime: new Date().toISOString(),
        expiration: {
          type: "AfterDuration",
          duration: `PT${durationHours}H`,
        },
      },
    },
  };
  await armFetch(
    `${role.scope}/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/${guid}?api-version=${API_VERSION}`,
    { method: "PUT", body: JSON.stringify(body) }
  );
}

async function setProgress(progress) {
  await chrome.storage.session.set({ progress });
}

async function runActivation(roles, durationHours, justification) {
  const items = roles.map((r) => ({
    key: r.key,
    roleName: r.roleName,
    scopeName: r.scopeName,
    status: "pendente",
    message: "",
  }));
  await setProgress({ running: true, items });

  for (let i = 0; i < roles.length; i++) {
    items[i].status = "ativando";
    await setProgress({ running: true, items });
    try {
      await activateOne(roles[i], durationHours, justification);
      items[i].status = "ok";
    } catch (err) {
      items[i].status = "erro";
      items[i].message = String(err.message || err);
      // Mensagens comuns, traduzidas para ficar claro:
      if (/RoleAssignmentExists|already exists/i.test(items[i].message)) {
        items[i].status = "ok";
        items[i].message = "Já estava ativa";
      } else if (/ExpirationRule|duration/i.test(items[i].message)) {
        items[i].message +=
          " (a política dessa função permite menos horas — tente uma duração menor)";
      } else if (/MfaRule|MFA/i.test(items[i].message)) {
        items[i].message +=
          " (essa função exige MFA na ativação — ative essa manualmente no portal)";
      }
    }
    await setProgress({ running: true, items });
  }

  await setProgress({ running: false, items, finishedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Mensagens do popup
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "tokenStatus") {
        const token = await getToken();
        const { tokenAt } = await chrome.storage.session.get("tokenAt");
        sendResponse({ ok: true, hasToken: !!token, tokenAt: tokenAt || null });
      } else if (msg.type === "listRoles") {
        const roles = await listRoles();
        sendResponse({ ok: true, roles });
      } else if (msg.type === "activate") {
        // Roda em segundo plano; o popup acompanha pelo storage.session.
        runActivation(msg.roles, msg.durationHours, msg.justification);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "mensagem desconhecida" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err.message || err) });
    }
  })();
  return true; // resposta assíncrona
});
