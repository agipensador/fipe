# A claim `catalogAgent` — como ligar o agente

O agente precisa chamar `catalogAutoFillHints`, que é protegida. Este
documento é o passo a passo para dar a ele identidade própria.

## Por que claim, e não o e-mail do admin

A function verificava apenas `email === "gbrrizzardo@gmail.com"`. Isso
funciona para a tela do site, mas **amarra a automação a uma pessoa**: no dia
em que essa conta mudar, sair ou tiver o login revogado, o agente para — e
para em silêncio, porque ninguém acompanha um cron das 6 da manhã.

A claim pertence a uma identidade de serviço, que existe só para isso.

⚠️ **O e-mail continua aceito.** Removê-lo quebraria a tela do site, que é
como o catálogo é preenchido à mão hoje. São duas portas para o mesmo lugar.

## O que mudou no código

`repo_backend_app_chaveiro/functions/src/catalog_autofill_hints.ts`:

```ts
function assertCatalogAdmin(token) {
  if (token?.catalogAgent === true) return;   // ← porta do AGENTE
  const e = String(token?.email || "")…       // ← porta da PESSOA
  if (e !== CATALOG_ADMIN_EMAIL) throw new HttpsError("permission-denied", …);
}
```

Compilado com `tsc --noEmit`: **sem erros**.

⚠️ O `npm run lint` acusa ~2063 erros de `linebreak-style` (CRLF). **Já
falhava antes desta mudança** — medido: 2040 erros no `git stash`. É o
checkout com CRLF no Windows, não defeito do código. Não corrigi de propósito:
normalizar reescreveria o arquivo inteiro e produziria um diff irrevisável.

## Passo a passo

### 1. Criar o usuário de serviço

Firebase Console → **Authentication → Users → Add user**

- E-mail sugerido: `agente-catalogo@inforizz.com`
- Senha: forte, guardada em gerenciador — **nunca em arquivo do repositório**

### 2. Conceder a claim

```bash
cd repo_backend_app_chaveiro/functions
npm ci
node scripts/conceder-claim-agente.mjs --email agente-catalogo@inforizz.com
```

Requer credencial de admin:
`gcloud auth application-default login` ou `GOOGLE_APPLICATION_CREDENTIALS`.

Conferir depois:

```bash
node scripts/conceder-claim-agente.mjs --email agente-catalogo@inforizz.com --verificar
```

### 3. Publicar a function

```bash
cd repo_backend_app_chaveiro/functions
npm run build
npx firebase-tools deploy --only functions:catalogAutoFillHints --project app-do-chaveiro
```

⚠️ `--project` sempre explícito — mesma regra do repo do app.

#### ⚠️ Duas armadilhas medidas nesta máquina (15/09/2026)

**1. O predeploy quebra no Windows.** O `firebase.json` declara:

```json
"predeploy": ["npm --prefix \"$RESOURCE_DIR\" run lint", "…run build"]
```

`$RESOURCE_DIR` é sintaxe POSIX, mas o `firebase-tools` no Windows a expande
como `%RESOURCE_DIR%` e nenhum shell resolve:

    spawn npm --prefix "%RESOURCE_DIR%" run lint  → ENOENT

Falha no Git Bash **e** no PowerShell. Saída: rodar `npm run build` à mão e
publicar com o predeploy removido temporariamente do `firebase.json`
(lembrando de restaurá-lo depois).

**2. O lint do predeploy falharia de qualquer jeito.** São ~2040 erros de
`linebreak-style` (CRLF) **pré-existentes**, medidos com `git stash` antes de
qualquer alteração. É o checkout com CRLF no Windows, não defeito do código.
Normalizar reescreveria o arquivo inteiro e produziria um diff irrevisável.

### 4. Guardar as credenciais no GitHub

Repositório `fipe` → **Settings → Secrets and variables → Actions**:

| Secret | Valor |
|---|---|
| `AUTOFILL_URL` | `https://southamerica-east1-app-do-chaveiro.cloudfunctions.net/catalogAutoFillHints` |
| `AGENTE_EMAIL` | `agente-catalogo@inforizz.com` |
| `AGENTE_SENHA` | a senha do passo 1 |
| `FIREBASE_WEB_API_KEY` | Console → Configurações do projeto → Chave de API da Web |

⚠️ **Por que senha e não um token pronto:** ID token do Firebase expira em
**1 hora**. Um token fixo no secret funcionaria hoje e falharia amanhã — em
silêncio. O agente troca e-mail+senha por um token novo a cada execução.

### 5. Confirmar

Actions → *Agente FIPE (diário)* → **Run workflow** com `dry_run: true`.

## ⚠️ A claim só vale no próximo login

`setCustomUserClaims` não altera tokens já emitidos. Como o agente faz login a
cada execução, isso se resolve sozinho — mas se você testar com um token
obtido antes de conceder a claim, o 403 continua e parece que não funcionou.

## Revogar

```bash
node scripts/conceder-claim-agente.mjs --email agente-catalogo@inforizz.com --revogar
```

O agente volta a receber 403 na execução seguinte. É o botão de desligar.
