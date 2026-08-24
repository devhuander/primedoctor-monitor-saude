# Handoff — continuar no Claude Code

Documento de passagem. Apague quando a lista de tarefas estiver zerada.

**Contexto e regras invioláveis: leia `CLAUDE.md` primeiro.** O `README.md`
explica o porquê de cada decisão de projeto.

---

## Situação em 21/08/2026

### Já concluído e publicado

| O quê | Onde | Estado |
|---|---|---|
| Sondas, página de status, testes, documentação | `devhuander/primedoctor-monitor-saude`, `main` até `186e5fe` | publicado |
| `_shared/monitorPing.ts` + ping em 7 edge functions | `devhuander/primedoctor`, `feature/claude`, commit `acb74c563` | publicado e **deployado pelo Lovable** |
| Secrets do repositório | `PD_MONITOR_EMAIL`, `PD_MONITOR_PASSWORD`, `PD_MONITOR_PING_TOKEN`, `HEARTBEAT_URL` | criados pelo usuário |
| Secret do Supabase | `MONITOR_PING_TOKEN` | criado pelo usuário |
| PAT com escopo `workflow` | fine-grained, `Read and write` em code and workflows | liberado |

### Pendente — não commitado, apenas no disco

A VM Linux da sessão anterior caiu antes do último push. Estes arquivos estão
alterados no diretório de trabalho e **ainda não foram commitados**:

- `.github/workflows/monitor.yml` — **nunca foi enviado ao GitHub** (o PAT
  anterior não tinha escopo `workflow`). É o arquivo mais importante: sem ele
  nada roda automaticamente.
- `README.md` — seção de alerta reescrita em torno do healthchecks.io.
- `HANDOFF.md` — este arquivo.

---

## Tarefas, em ordem

### 1. Commitar e enviar o que ficou pendente

```bash
cd D:\GitHub\primedoctor-monitor-saude
git status                      # confirmar os 3 arquivos acima
npm test                        # 14 casos de lógica + 15 verificações e2e
npm run test:page               # render em jsdom + XSS  (precisa de: npm i --no-save jsdom)
git add -A
git commit
git push origin main
```

Mensagem de commit sugerida:

```
feat(alerta): healthchecks.io vira o canal principal, sem exigir Slack ou Discord

Quem não usa Slack nem Discord ficava sem canal de alerta — e sem canal, isto é
um painel de status, não um monitor: ninguém é acordado às 3h.

O HEARTBEAT_URL já estava configurado como dead-man's switch. O mesmo endpoint
aceita <URL>/fail, que marca a checagem como down e dispara os canais de
notificação já cadastrados lá. Passa a servir para as duas coisas:

- pulso de sucesso só quando NÃO há alarme (antes era enviado sempre, o que
  mascararia uma falha confirmada);
- POST em /fail quando há alarme, com o resumo e o link da execução.

MONITOR_WEBHOOK_URL continua existindo, agora explicitamente opcional.

Inclui o workflow, que não pôde ser enviado antes por falta do escopo `workflow`
no token.
```

O push já dispara a primeira execução: o gatilho `push` cobre
`.github/workflows/monitor.yml`.

### 2. Ligar o GitHub Pages

`Settings` → `Pages` → **Source: GitHub Actions**.

Se ainda não estiver ligado, o job `publicar` falha e o `alertar` dispara — é o
comportamento correto, não um bug.

### 3. Validar a primeira execução de verdade

Nenhuma sessão anterior conseguiu rodar as sondas contra a produção: o sandbox
só alcançava `github.com` e o registry do npm. **Esta é a primeira validação
real.** Confira, em `Actions` → última execução:

- [ ] `verificar` terminou. O *step summary* traz a tabela por área.
- [ ] `persistir` commitou `data/status.json` e `data/history.jsonl` na `main`.
- [ ] `publicar` deployou; a página abre em
      https://devhuander.github.io/primedoctor-monitor-saude/
- [ ] O check no healthchecks.io recebeu o pulso.

Depois abra `data/status.json` e verifique item por item:

| O que olhar | Esperado | Se vier diferente |
|---|---|---|
| `sections[].items` do `edge`, item `__canary__` | `ok` | Se vier `unknown`, a técnica de detecção quebrou e **nenhuma função foi verificada**. Investigue antes de qualquer outra coisa. |
| Demais funções de `edge` | `ok`, detalhe com `pronta (secrets presentes)` | `não verificável` significa que o gateway recusou antes de rotear — reveja o `Authorization: Bearer <anonKey>` em `probe/checks/edge.mjs`. |
| `backend` → `database` → `meta.probes` | `profiles`, `clinic_members` e `clinics` com `rows >= 1` | `ZERO linhas` provavelmente é permissão do usuário-monitor, não RLS quebrada. Confira antes de sair caçando bug. |
| `experience` → `authed.components` | `ok` | `sonda desatualizada` = os seletores `#signin-email` / `#signin-password` mudaram no app. |
| `overall.status` | `ok` | `skipped`/`unknown` indica verificação que não rodou — veja qual seção. |
| `monitorFault` | `false` | `true` = credencial do monitor recusada. É configuração, não falha do produto. |

**Cuidado com o falso alarme na estreia:** o `alertar` só dispara com duas
execuções ruins consecutivas, então a primeira execução nunca alarma, mesmo com
algo vermelho. Isso é intencional.

### 4. Rodar `security-review` antes de considerar pronto

O repositório é público e o workflow autentica em produção. Vale a passada extra.

### 5. Domínio `status.primedoctor.app` — nesta ordem

1. DNS de `primedoctor.app`: CNAME `status` → `devhuander.github.io`
2. Esperar propagar: `nslookup status.primedoctor.app`
3. **Só então** criar a variável (aba *Variables*, não *Secrets*)
   `PD_CUSTOM_DOMAIN` = `status.primedoctor.app`
4. Rodar o workflow de novo

Inverter a ordem faz o GitHub redirecionar o endereço `.github.io` para um
domínio que ainda não resolve — a página fica inacessível pelos dois caminhos.

---

## Pontos de atenção herdados

- **`data/` nunca é commitado à mão.** Quem escreve ali é o workflow. Os testes
  limpam sozinhos ao terminar.
- **Mudou o formato do relatório?** Incremente `schemaVersion` em
  `probe/run.mjs` **e** `SCHEMA_SUPORTADO` em `site/app.js`, e atualize
  `tools/gerar-dados-demo.mjs`. A página detecta divergência e avisa em vez de
  renderizar lixo.
- **Nunca adicione gatilho `pull_request`** ao workflow: daria a PRs de
  terceiros um caminho para as credenciais de produção.
- **O repositório `D:\GitHub\primedoctor` tem outras sessões trabalhando.**
  Na sessão anterior havia um `.git/index.lock` órfão e alterações não
  commitadas de outra tarefa. Antes de commitar ali, confira `git status` e
  commite apenas os seus arquivos.

## Limitação conhecida que continua aberta

O ping confere se os secrets estão **presentes**, não se são **válidos**: um
token Z-API presente porém expirado passa como pronto. Cobrir isso exigiria uma
chamada real ao provedor, com custo e efeito colateral — decisão consciente de
não fazer.
