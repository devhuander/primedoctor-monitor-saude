# Contexto para agentes trabalhando neste repositório

Monitor de saúde externo do PrimeDoctor. Leia o `README.md` primeiro — ele
explica o **porquê** de cada decisão, que é o que costuma se perder.

## Contexto operacional

- Repositório: `https://github.com/devhuander/primedoctor-monitor-saude` (branch `main`)
- Sistema monitorado: `https://primedoctor.app` e `https://primedoctor.primemedicalgo.com.br`
- Código do sistema monitorado: `D:\GitHub\primedoctor`, branch `feature/claude`
  (é onde o Lovable também trabalha)
- Supabase: projeto `iewdxiggqwyjdqbtmojm`
- Redeploy de edge function é feito **pelo Lovable**, via `send_message` — já autorizado.
  Não mandar outros tipos de comando para o Lovable.

## Regras que não podem ser quebradas

1. **Este repositório é público e o histórico do git é permanente.** Nada que
   saia daqui pode ser desfeito. Nunca publique texto bruto vindo do sistema
   monitorado: o app loga telefone de paciente e o Postgres embute valores de
   linha nas mensagens de erro. Use `probe/lib/sanitize.mjs` — a abordagem é
   allowlist (categoria + contagem + hash), não blocklist.

2. **Falso negativo é o pior defeito possível.** Um status que só sabe ficar
   verde é pior do que não ter monitor, porque dá falsa confiança. Antes de
   marcar qualquer coisa como `ok`, pergunte: "existe um cenário em que isso
   fica verde com o sistema quebrado?".

3. **Silêncio não é saúde.** `skipped` e `unknown` valem mais que `ok` no rank
   de severidade (`probe/config.mjs`). Uma verificação que não rodou não pode
   produzir "todos os sistemas operacionais".

4. **O monitor testa a si mesmo antes de julgar** (`probe/checks/selftest.mjs`).
   Runner sem rede ⇒ veredito "sem informação", nunca "o sistema caiu".

5. **O canário das edge functions é obrigatório.** Se o slug inexistente parar
   de devolver 404, a seção inteira se declara não confiável. Nunca remova.

6. **Nunca adicione gatilho `pull_request` ao workflow.** Daria a PRs de
   terceiros um caminho para as credenciais de produção.

## Antes de commitar

```bash
npm test          # lógica + ponta a ponta contra alvo simulado
npm run test:page # render da página em jsdom, inclui teste de XSS
```

Se você mudou o formato do relatório, incremente `schemaVersion` em
`probe/run.mjs` **e** `SCHEMA_SUPORTADO` em `site/app.js`, e atualize
`tools/gerar-dados-demo.mjs`.

Nunca commite `data/*.json` ou `data/history.jsonl` gerados localmente —
quem escreve ali é o workflow. Os testes limpam sozinhos.

## Pendências conhecidas

- **Dry-run nas edge functions.** O preflight prova que a função existe e sobe,
  não que ela funciona. Fechar isso exige um endpoint de ping sem efeito
  colateral dentro de cada function do PrimeDoctor (via Lovable).
- **Sem `MONITOR_WEBHOOK_URL` e `HEARTBEAT_URL` configurados**, isto é um painel
  de status, não um sistema de alerta.
