# PrimeDoctor — Monitor de Saúde

Monitoramento **externo e independente** do sistema [PrimeDoctor](https://primedoctor.app).

Roda inteiramente no GitHub — fora da Lovable, fora do Supabase, fora do DNS do
`primedoctor.app`. Se a hospedagem do sistema cair, esta página continua no ar
justamente para mostrar que caiu.

- **Página de status:** https://devhuander.github.io/primedoctor-monitor-saude/
  (e `https://status.primedoctor.app` depois que o DNS for configurado — veja abaixo)
- **Frequência:** de hora em hora, mais execução manual sob demanda
- **Custo:** zero (Actions ilimitado em repositório público)

---

## O que é verificado

| Área | O que a sonda faz |
|---|---|
| **Hospedagem e front-end** | Resolve o DNS, inspeciona o certificado TLS (e quantos dias faltam para expirar), baixa o HTML e confere o ponto de montagem do app, baixa cada bundle JS/CSS gerado pelo build, checa `manifest.json` / `favicon.ico` / `robots.txt` e testa se uma rota profunda devolve o app (fallback de SPA). |
| **Banco de dados e backend** | GoTrue (`/auth/v1/health`), PostgREST, o healthcheck próprio do PrimeDoctor (`system-health`, que faz consulta real no Postgres), leitura de 6 tabelas via RLS, conexão WebSocket no Realtime e o serviço de Storage. |
| **Funções de borda** | 14 edge functions críticas, via `OPTIONS` (preflight CORS). Detecta a regressão silenciosa mais perigosa: uma função sumir do deploy e o webhook parar sem ninguém perceber. |
| **Experiência de carregamento** | Chromium real abre o app, autentica com o usuário-monitor e mede: TTFB, DOMContentLoaded, load, FCP, LCP, CLS, tempo até o app montar, erros de JavaScript no console e requisições que falharam. |
| **Plataformas de terceiros** | Status oficial de Supabase, Lovable, Cloudflare e GitHub. Responde "o problema é meu ou do fornecedor?". Informativo — nunca derruba o status geral. |

### Por que `OPTIONS` nas edge functions

`OPTIONS` acorda a função e devolve os headers de CORS **sem executar a lógica de
negócio**. A checagem não dispara mensagem de WhatsApp, não grava lead, não
consome crédito de IA. É seguro rodar de hora em hora, para sempre.

---

## Privacidade e segurança

- Nenhum dado de paciente, clínica ou usuário é lido, gravado ou exibido.
  As sondas registram apenas **latência, código HTTP e sucesso/erro**.
- Toda mensagem de erro passa por um filtro que remove e-mails, UUIDs e tokens JWT
  antes de ir para o JSON público (`sanitize()` em `probe/checks/backend.mjs`).
- URLs registradas têm a query string removida — é onde tokens costumam viajar.
- **Nenhuma captura de tela da área autenticada** é gravada.
- A `anon key` do Supabase está no código porque é pública por design: ela vai no
  bundle do front-end e é protegida por RLS. A senha do usuário-monitor **nunca**
  aparece no repositório — vive só em GitHub Secrets.

---

## Configuração

### 1. Ligar o GitHub Pages

`Settings` → `Pages` → **Source: GitHub Actions**.

### 2. Criar o usuário-monitor

Crie no PrimeDoctor um usuário dedicado, com a **menor permissão possível** que ainda
enxergue a tela inicial. Não use uma conta de pessoa real.

`Settings` → `Secrets and variables` → `Actions` → `New repository secret`:

| Secret | Valor |
|---|---|
| `PD_MONITOR_EMAIL` | e-mail do usuário-monitor |
| `PD_MONITOR_PASSWORD` | senha do usuário-monitor |

Sem esses secrets o monitor continua funcionando: as checagens autenticadas ficam
marcadas como *Não verificado*, em vez de falharem.

### 3. Domínio customizado (opcional, faça nesta ordem)

1. No DNS de `primedoctor.app`, crie um **CNAME**: `status` → `devhuander.github.io`
2. Espere propagar (confira com `nslookup status.primedoctor.app`)
3. Só então crie a variável `PD_CUSTOM_DOMAIN` = `status.primedoctor.app`
   em `Settings` → `Secrets and variables` → `Actions` → aba **Variables**
4. Rode o workflow de novo

> **Ordem importa.** Se o arquivo `CNAME` for publicado antes do DNS existir, o
> GitHub passa a redirecionar o endereço `.github.io` para um domínio que não
> resolve, e a página fica inacessível pelos dois caminhos. Por isso o domínio é
> aplicado por variável, e não por arquivo comitado.

### Variáveis opcionais

| Variável | Padrão | Para quê |
|---|---|---|
| `PD_APP_URL` | `https://primedoctor.app` | apontar para outro ambiente (staging) |
| `PD_SUPABASE_URL` | projeto de produção | apontar para outro projeto Supabase |
| `PD_CUSTOM_DOMAIN` | *(vazio)* | domínio customizado do Pages |

---

## Alertas

O job `alertar` **falha de propósito** quando o status geral é `fail`. Isso faz o
GitHub mandar o e-mail padrão de "workflow failed" para o dono do repositório —
alerta grátis, sem configurar nada.

Para desligar, remova o job `alertar` de `.github/workflows/monitor.yml`.
Para alertar por WhatsApp, o próprio PrimeDoctor já tem a edge function
`system-monitor`, que roda dentro do Supabase e usa as linhas Z-API da clínica.

---

## Rodar localmente

```bash
npm install
npx playwright install chromium

# Verificação completa (precisa de rede até primedoctor.app e Supabase)
npm run check

# Sem navegador — bem mais rápido, útil para depurar as sondas HTTP
npm run check:fast

# Ver a página com dados sintéticos, sem esperar histórico real
npm run demo
npm run preview          # http://localhost:4173

# Arquivo único autocontido, abre com file:// e sem servidor
node tools/gerar-preview-local.mjs
```

Para checar a área autenticada localmente, exporte as credenciais antes:

```bash
export PD_MONITOR_EMAIL='...'
export PD_MONITOR_PASSWORD='...'
```

---

## Estrutura

```
probe/
  run.mjs              orquestra tudo, monta status.json / history.json / incidents.json
  config.mjs           alvos, limiares, lista de edge functions e tabelas
  lib/http.mjs         fetch com timeout, DNS, TLS, identificação do host
  checks/
    frontend.mjs       hospedagem, TLS, HTML, bundles, assets, roteamento SPA
    backend.mjs        Auth, PostgREST, Postgres, Realtime, Storage, login
    edge.mjs           edge functions via preflight CORS
    browser.mjs        Chromium: performance, componentes montados, console
    upstream.mjs       páginas de status de terceiros
site/                  página estática (sem build): index.html, styles.css, app.js
data/                  relatórios gerados — comitados pelo próprio workflow
tools/                 preview local e geração de dados de demonstração
```

## Dados publicados

| Arquivo | Conteúdo |
|---|---|
| `data/status.json` | último relatório completo |
| `data/history.json` | série compacta, ~90 dias de execuções horárias |
| `data/incidents.json` | execuções não-OK consecutivas, agrupadas em incidentes |

---

## Limites honestos

- Verde significa que **o caminho verificado** respondeu — não que todos os fluxos
  do produto estejam corretos.
- A frequência é horária: uma queda curta entre dois ciclos pode não aparecer.
  O cron do GitHub Actions também atrasa em horários de pico.
- A verificação "ao vivo" da página usa a rede de quem está olhando e alcança
  apenas endpoints com CORS aberto. O teste do site em si é `no-cors`: prova
  DNS + TCP + TLS, mas não o código HTTP.
- Sem os secrets configurados, metade do valor do monitor não roda.
