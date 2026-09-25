#!/usr/bin/env node
/**
 * O agente de preenchimento da base FIPE.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * O QUE ELE FAZ, EM UMA FRASE
 *
 * Descobre o que falta, coleta, valida, e abre um Pull Request — todo dia,
 * sozinho, sem ninguém acompanhar.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * AS QUATRO REGRAS QUE GOVERNAM O DESENHO
 *
 * 1. NUNCA SOBRESCREVE. Só preenche o que está faltando. Decisão de
 *    15/09/2026 — o dado que já está lá foi conferido por alguém; o do
 *    agente, não.
 *
 * 2. NUNCA COMMITA DIRETO. Abre PR. A base é pública, o app a lê do GitHub
 *    **sem cache**, e 10 mil usuários recebem o erro em segundos, sem
 *    rollback por versão. O PR é o único ponto onde um erro em escala ainda
 *    é reversível.
 *
 * 3. CAMPO AUSENTE É MELHOR QUE CAMPO ERRADO. O app trata ausência (não
 *    exibe); valor errado ele exibe como verdade, e o chaveiro orça em cima.
 *
 * 4. RESPEITA A COTA. Google CSE dá 100 consultas/dia no plano gratuito.
 *    O agente para antes de estourar e retoma no dia seguinte — por isso o
 *    checkpoint é obrigatório, não opcional.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * USO
 *
 *   node tools/agente/agente.mjs --dry-run      # não grava nada
 *   node tools/agente/agente.mjs --executar     # grava e prepara o PR
 *   node tools/agente/agente.mjs --relatorio    # só mostra o que falta
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CFG, avaliar, valorUtil} from './validacao.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(AQUI, '..', '..', 'docs');
const ESTADO = path.join(AQUI, 'estado.json');

// ── checkpoint: onde paramos ontem ───────────────────────────────────────────

function lerEstado() {
  if (!fs.existsSync(ESTADO)) {
    return {ultimaExecucao: null, posicao: {}, totalPreenchido: 0, execucoes: 0};
  }
  return JSON.parse(fs.readFileSync(ESTADO, 'utf8'));
}

function gravarEstado(e) {
  fs.writeFileSync(ESTADO, JSON.stringify(e, null, 2) + '\n');
}

// ── o que falta ──────────────────────────────────────────────────────────────

/**
 * Varre um arquivo e lista as lacunas.
 *
 * ⚠️ Agrupa por MODELO, não por ano, e isso é economia de cota, não estética:
 * lâmina e transponder não mudam de um ano para o outro do mesmo modelo — só
 * o preço muda. Uma consulta serve a faixa inteira.
 */
function lacunas(arquivo) {
  const p = path.join(DOCS, arquivo + '.json');
  if (!fs.existsSync(p)) return [];
  const root = JSON.parse(fs.readFileSync(p, 'utf8')).items[0] || {};
  const saida = [];

  for (const [modelo, combustiveis] of Object.entries(root)) {
    const faltaPorAno = [];
    let temTecnico = false;

    for (const [comb, anos] of Object.entries(combustiveis || {})) {
      // ⚠️ Nó de combustível que na verdade é nome de campo. A base tem
      // registros assim (`laminaPalhetas` no lugar do combustível), e
      // tratá-los como veículo geraria consulta para algo que não existe.
      if (/lamina|transponder|telecomando|maquinas|value|video/i.test(comb)) {
        continue;
      }
      for (const [ano, campos] of Object.entries(anos || {})) {
        if (!campos || typeof campos !== 'object' || Array.isArray(campos)) {
          continue;
        }
        const faltando = [];

        // ⚠️ TODOS OS CAMPOS, não só preço.
        //
        // A versão anterior só listava `campos_preco` como lacuna e usava
        // `temTecnico` como um sim/não para o modelo inteiro: bastava UM
        // campo técnico em UM ano para o modelo contar como completo. Na
        // prática, um registro com só `videoLink` preenchido nunca teria
        // lâmina, transponder ou frequência buscados — e são 13 campos.
        //
        // Agora cada campo ausente é uma lacuna própria. O que já está
        // preenchido continua intocado: quem grava é o passo de merge, que
        // só escreve onde `valorUtil` é falso.
        for (const c of CFG.escopo.campos_preco) {
          if (!valorUtil(campos[c])) faltando.push(c);
        }
        for (const c of CFG.escopo.campos_tecnicos) {
          if (valorUtil(campos[c])) temTecnico = true;
          else faltando.push(c);
        }

        // ⚠️ SÓ LACUNA. O preço que já existe é o preço real e fica como
        // está — decisão de 23/09/2026. Uma versão anterior recoletava
        // preço "envelhecido" por idade do veículo; foi removida.
        //
        // A atualização virá dos CHAVEIROS numa versão futura do app: quem
        // está na bancada sabe o preço melhor que qualquer busca.
        if (faltando.length) {
          faltaPorAno.push({comb, ano, faltando});
        }
      }
    }

    if (faltaPorAno.length || !temTecnico) {
      saida.push({
        modelo,
        anos: faltaPorAno,
        precisaTecnico: !temTecnico,
        // Um "trabalho" = uma consulta de coleta. Técnico vale para o modelo
        // inteiro; preço, para cada ano.
        custoConsultas: (temTecnico ? 0 : 1) + (faltaPorAno.length ? 1 : 0),
      });
    }
  }
  return saida;
}

// ── relatório ────────────────────────────────────────────────────────────────

function relatorio() {
  console.log('\n── O que falta na base ──\n');
  console.log('marca'.padEnd(14) + 'modelos'.padStart(9) + 'c/ lacuna'.padStart(11) +
              'anos s/ preço'.padStart(15) + 's/ técnico'.padStart(12));

  let totalAnos = 0; let totalTec = 0;
  for (const marca of CFG.prioridade_marcas.ordem) {
    const p = path.join(DOCS, marca + '.json');
    if (!fs.existsSync(p)) continue;
    const root = JSON.parse(fs.readFileSync(p, 'utf8')).items[0] || {};
    const l = lacunas(marca);
    const anos = l.reduce((a, x) => a + x.anos.length, 0);
    const tec = l.filter((x) => x.precisaTecnico).length;
    totalAnos += anos; totalTec += tec;
    console.log(
      marca.padEnd(14) + String(Object.keys(root).length).padStart(9) +
      String(l.length).padStart(11) + String(anos).padStart(15) +
      String(tec).padStart(12),
    );
  }
  console.log('\nnas marcas prioritárias: ' + totalAnos + ' anos sem preço, ' +
              totalTec + ' modelos sem dado técnico');

  const porDia = CFG.execucao.veiculos_por_execucao;
  console.log('a ' + porDia + ' consultas/dia → ~' +
              Math.ceil((totalAnos + totalTec) / porDia) + ' dias de execução');
}

// ── a coleta ─────────────────────────────────────────────────────────────────

/**
 * Chama a Cloud Function `catalogAutoFillHints`, que já existe e já faz a
 * busca (Google CSE + YouTube + Gemini), devolvendo `confidence` e `sources`
 * por campo.
 *
 * ⚠️ NÃO reimplementar a coleta aqui. A function tem 1063 linhas de regras de
 * extração já ajustadas; duplicar isso criaria duas verdades que divergem com
 * o tempo.
 */
/**
 * Faz login como o usuário de serviço e devolve um ID token.
 *
 * ⚠️ O TOKEN É TROCADO A CADA EXECUÇÃO, E ISSO É DELIBERADO.
 *
 * ID token do Firebase expira em **1 hora**. Guardar um token pronto no
 * secret funcionaria hoje e falharia amanhã — em silêncio, que é o pior modo
 * de falhar para algo que roda sozinho às 6 da manhã. Trocando e-mail+senha
 * por token a cada execução, a credencial nunca vence.
 *
 * O token carrega a claim `catalogAgent` — ver tools/agente/CLAIM.md.
 */
let _tokenCache = null;
async function idToken() {
  if (_tokenCache) return _tokenCache;

  // Um token pronto, se alguém preferir injetar direto (útil para teste local).
  if (process.env.AUTOFILL_TOKEN) {
    _tokenCache = process.env.AUTOFILL_TOKEN;
    return _tokenCache;
  }

  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  const email = process.env.AGENTE_EMAIL;
  const senha = process.env.AGENTE_SENHA;
  if (!apiKey || !email || !senha) return null;

  const resp = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + apiKey,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({email, password: senha, returnSecureToken: true}),
    },
  );
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('login do agente falhou: ' + t.slice(0, 160));
  }
  const j = await resp.json();
  _tokenCache = j.idToken;
  return _tokenCache;
}

async function coletar(marca, modelo, ano, combustivel) {
  const url = process.env.AUTOFILL_URL;
  if (!url) {
    throw new Error(
      'AUTOFILL_URL não definida.\n' +
      'É a URL da callable `catalogAutoFillHints` ' +
      '(southamerica-east1-app-do-chaveiro.cloudfunctions.net/catalogAutoFillHints).',
    );
  }
  const token = await idToken();
  if (!token) {
    throw new Error(
      'Sem credencial do agente. Defina AGENTE_EMAIL + AGENTE_SENHA +\n' +
      'FIREBASE_WEB_API_KEY (ou AUTOFILL_TOKEN). Ver tools/agente/CLAIM.md.',
    );
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? {Authorization: 'Bearer ' + token} : {}),
    },
    body: JSON.stringify({
      data: {
        brandLabel: marca,
        modelLabel: String(modelo).replace(/_PDOT/g, '.'),
        yearLabel: String(ano),
        fuelLabel: combustivel,
      },
    }),
  });

  if (!resp.ok) throw new Error('autofill HTTP ' + resp.status);
  const j = await resp.json();
  return (j.result && j.result.fields) || {};
}

/** Separa valores e fontes do formato que a function devolve. */
function desdobrar(fields) {
  const valores = {}; const fontes = {};
  for (const [campo, hint] of Object.entries(fields || {})) {
    if (!hint || hint.value === null || hint.value === undefined) continue;
    if (typeof hint.value === 'object') continue;
    valores[campo] = hint.value;
    fontes[campo] = hint.sources || [];
  }
  return {valores, fontes};
}

// ── execução ─────────────────────────────────────────────────────────────────

async function executar({seco}) {
  const estado = lerEstado();
  const hoje = new Date().toISOString().slice(0, 10);

  if (estado.ultimaExecucao === hoje && !seco) {
    console.log('Já rodou hoje (' + hoje + '). A cota do CSE é diária.');
    return;
  }

  let orcamento = CFG.execucao.veiculos_por_execucao;
  const mudancas = [];
  const paraRevisao = [];
  let descartes = 0;

  for (const marca of CFG.prioridade_marcas.ordem) {
    if (orcamento <= 0) break;
    const l = lacunas(marca);
    if (!l.length) continue;

    const desde = (estado.posicao || {})[marca] || 0;
    const fila = l.slice(desde);
    if (!fila.length) continue;

    console.log(`\n▶ ${marca}: ${l.length} modelos com lacuna (retomando em #${desde})`);
    const p = path.join(DOCS, marca + '.json');
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    const root = doc.items[0];
    let mexeu = false; let i = desde;

    for (const alvo of fila) {
      if (orcamento <= 0) break;

      // ⚠️ TODOS OS ANOS DO MODELO, UM POR UM.
      //
      // A versão anterior consultava só `alvo.anos[0]` e passava ao modelo
      // seguinte — o que contradiz a regra medida: o Fiat Palio usa
      // `Silca GT15` até 2002 e `GT15ouSIP22` de 2003 em diante. Um ano só
      // não representa o modelo, e gravar o que veio dele nos demais anos
      // poria a lâmina errada na bancada do chaveiro.
      //
      // O orçamento é decrementado por ANO, não por modelo, porque é o ano
      // que custa uma consulta.
      for (const alvoAno of alvo.anos) {
        if (orcamento <= 0) break;

        try {
          const fields = await coletar(
            marca, alvo.modelo, alvoAno.ano, alvoAno.comb,
          );
          const {valores, fontes} = desdobrar(fields);
          const {aprovados, revisao, descartados} = avaliar(valores, fontes);
          descartes += Object.keys(descartados).length;

          if (Object.keys(revisao).length) {
            paraRevisao.push({
              marca, modelo: alvo.modelo, ano: alvoAno.ano, campos: revisao,
            });
          }

          // ⚠️ SÓ O QUE FALTA — nunca toca em valor existente.
          let n = 0;
          const destino = root[alvo.modelo]?.[alvoAno.comb]?.[alvoAno.ano];
          if (destino) {
            for (const [campo, valor] of Object.entries(aprovados)) {
              // ⚠️ NUNCA SOBRESCREVE. O que já está lá é o preço real.
              if (!valorUtil(destino[campo])) {
                destino[campo] = valor; n++; mexeu = true;
                // Data em que ESTE preço foi coletado.
                //
                // ⚠️ Não serve a nenhuma recoleta automática — essa política
                // foi removida em 23/09/2026: o preço que existe é o preço
                // real e fica. Serve para quem revisa o PR e, no futuro,
                // para a correção pelos chaveiros saber o que está olhando.
                //
                // Os 5.023 preços anteriores não têm data — o metadado só
                // passou a ser gravado agora. "Sem data" significa "veio
                // antes do agente".
                //
                // Só para PREÇO: dado técnico não tem essa leitura. A lâmina
                // de um carro 2015 é a mesma em 2030.
                if (CFG.escopo.campos_preco.includes(campo)) {
                  destino.precoAtualizadoEm = new Date()
                    .toISOString().slice(0, 10);
                }
              }
            }
          }
          if (n) {
            mudancas.push(
              `${marca} · ${alvo.modelo} · ${alvoAno.ano}: +${n} campo(s)`,
            );
            console.log(`  ✅ ${alvo.modelo} ${alvoAno.ano}: +${n}`);
          } else {
            console.log(`  ⚪ ${alvo.modelo} ${alvoAno.ano}: nada aprovado`);
          }
        } catch (e) {
          console.log(`  ⚠️  ${alvo.modelo} ${alvoAno.ano}: ${e.message}`);
        }
        orcamento--;
      }
      i++;
    }

    estado.posicao = estado.posicao || {};
    estado.posicao[marca] = i >= l.length ? 0 : i; // volta ao início ao terminar

    if (mexeu && !seco) {
      fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
    }
  }

  console.log('\n── Resumo ──');
  console.log('  campos gravados:  ' + mudancas.length);
  console.log('  para revisão:     ' + paraRevisao.length);
  console.log('  descartados:      ' + descartes);
  console.log('  consultas usadas: ' + (CFG.execucao.veiculos_por_execucao - orcamento));

  if (paraRevisao.length) {
    fs.writeFileSync(
      path.join(AQUI, 'revisao-pendente.json'),
      JSON.stringify(paraRevisao, null, 2) + '\n',
    );
    console.log('\n  ⚠️  revisao-pendente.json — campos de fonte única, precisam de olho humano');
  }

  if (seco) {
    console.log('\n⚠️  DRY-RUN: nada gravado.');
    return;
  }

  estado.ultimaExecucao = hoje;
  estado.totalPreenchido = (estado.totalPreenchido || 0) + mudancas.length;
  estado.execucoes = (estado.execucoes || 0) + 1;
  gravarEstado(estado);

  fs.writeFileSync(path.join(AQUI, 'ultimo-relatorio.md'),
    '# Execução de ' + hoje + '\n\n' +
    '- campos gravados: ' + mudancas.length + '\n' +
    '- para revisão: ' + paraRevisao.length + '\n' +
    '- descartados pela validação: ' + descartes + '\n\n' +
    (mudancas.length ? '## Mudanças\n\n' + mudancas.map((m) => '- ' + m).join('\n') + '\n' : ''),
  );
}

// ── entrada ──────────────────────────────────────────────────────────────────

const arg = process.argv.slice(2);
if (arg.includes('--relatorio')) {
  relatorio();
} else if (arg.includes('--executar') || arg.includes('--dry-run')) {
  executar({
    seco: !arg.includes('--executar'),
  })
    .catch((e) => { console.error('Falhou: ' + e.message); process.exit(1); });
} else {
  console.log('Uso: agente.mjs --relatorio | --dry-run | --executar');
  process.exit(1);
}
