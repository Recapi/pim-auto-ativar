# PIM Auto Ativar

Extensão do Chrome que ativa de uma vez todas as suas funções elegíveis do
**Azure PIM (Privileged Identity Management → Azure resources / RBAC)** —
aquelas que você ativa manualmente toda manhã, uma por uma, com duração de 8h.

## Como funciona

- Ela **não pede senha nem faz login**: apenas observa o token que o próprio
  portal do Azure já usa na sua sessão e chama a mesma API pública do ARM que a
  tela do PIM chama (`roleEligibilityScheduleInstances` /
  `roleAssignmentScheduleRequests`).
- No popup você tem: filtro por nome (o mesmo padrão que você usa no portal),
  duração (1/2/4/8h), justificativa, e o botão **Ativar selecionadas**.
- Funções que já estão ativas aparecem marcadas como "ativa até HH:MM" e não
  são pré-selecionadas.
- O filtro aceita vários termos separados por vírgula (ex.: `prod, contoso`).
- As preferências (filtro, duração, justificativa) ficam salvas.

## Instalação (modo desenvolvedor)

1. Abra `chrome://extensions` no Chrome.
2. Ligue o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e escolha esta pasta
   (`~/Desktop/Extensao`).

## Uso diário

1. Abra o portal do Azure logado (qualquer página serve; se o popup disser
   "sem sessão", dê F5 numa aba do portal — ele renova o token sozinho).
2. Clique no ícone da extensão.
3. Confira a lista filtrada e clique em **Ativar selecionadas**.
   Pode fechar o popup: a ativação continua em segundo plano e o resultado
   fica salvo ao reabrir.

## Limitações conhecidas

- Funções cuja política de PIM **exige MFA no momento da ativação** ou
  **aprovação de outra pessoa** não podem ser ativadas por API — a extensão
  mostra o erro nessas linhas e você ativa essas poucas manualmente.
- Se a política de uma função permitir menos de 8h, escolha uma duração menor
  (o erro exibido indica isso).
- O token da sessão expira em ~1h; basta ter/atualizar uma aba do portal
  aberta antes de usar.

## Estrutura

- `manifest.json` — Manifest V3; permissões mínimas (`webRequest`, `storage`,
  host `management.azure.com`).
- `background.js` — captura do token, listagem e ativação via API.
- `popup.html` / `popup.js` — interface.
