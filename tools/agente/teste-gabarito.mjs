#!/usr/bin/env node
/**
 * Mede a TAXA DE ACERTO do agente contra dado que já sabemos estar certo.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * POR QUE ESTE TESTE EXISTE, E POR QUE ELE VEM ANTES DE ESCALAR
 *
 * Um agente que coleta em escala e erra em escala é pior que nenhum agente —
 * a base é pública, o app a lê sem cache, e o chaveiro orça em cima do que
 * está escrito ali.
 *
 * Só há um jeito honesto de saber se ele acerta: rodar sobre veículos cujo
 * valor correto **já está na base**, fingir que não sabemos, e comparar.
 * Qualquer número dado sem isto é chute.
 *
 * A `renault` é a cobaia certa: 446 anos, 100% com preço, formato correto.
 * (Mitsubishi seria o pior caso — está justamente no formato quebrado, e
 * misturaria "o agente erra?" com "o arquivo está errado?".)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * USO
 *
 *   node tools/agente/teste-gabarito.mjs --marca renault --amostra 20
 *
 * Sem AUTOFILL_URL configurada, roda em modo SIMULADO: não chama a rede e
 * exercita só as regras de validação e derivação sobre o gabarito. Útil para
 * medir a derivação, que é metade do ganho de cota.
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CFG, avaliar, valorUtil, comoNumero, derivarPreco} from './validacao.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(AQUI, '..', '..', 'docs');

const arg = process.argv.slice(2);
const opt = (nome, padrao) => {
  const i = arg.indexOf('--' + nome);
  return i >= 0 && arg[i + 1] ? arg[i + 1] : padrao;
};

const MARCA = opt('marca', 'renault');
const AMOSTRA = parseInt(opt('amostra', '20'), 10);

/** Sorteia registros completos para servir de gabarito. */
function gabarito(marca, n) {
  const p = path.join(DOCS, marca + '.json');
  if (!fs.existsSync(p)) throw new Error('marca sem arquivo: ' + marca);
  const root = JSON.parse(fs.readFileSync(p, 'utf8')).items[0] || {};

  const todos = [];
  for (const [modelo, combs] of Object.entries(root)) {
    for (const [comb, anos] of Object.entries(combs || {})) {
      for (const [ano, campos] of Object.entries(anos || {})) {
        const preenchidos = CFG.escopo.campos_preco
          .filter((c) => valorUtil((campos || {})[c]));
        if (preenchidos.length >= 4) {
          todos.push({modelo, comb, ano, campos, vizinhos: anos});
        }
      }
    }
  }
  // Passo fixo em vez de aleatório: o teste tem que dar o mesmo resultado
  // quando rodado de novo, senão não dá para comparar execuções.
  const passo = Math.max(1, Math.floor(todos.length / n));
  return todos.filter((_, i) => i % passo === 0).slice(0, n);
}

/** Chama a function real, quando configurada. */
async function coletar(marca, modelo, ano, comb) {
  const url = process.env.AUTOFILL_URL;
  if (!url) return null;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.AUTOFILL_TOKEN
        ? {Authorization: 'Bearer ' + process.env.AUTOFILL_TOKEN} : {}),
    },
    body: JSON.stringify({data: {
      brandLabel: marca,
      modelLabel: String(modelo).replace(/_PDOT/g, '.'),
      yearLabel: String(ano),
      fuelLabel: comb,
    }}),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const j = await resp.json();
  return (j.result && j.result.fields) || {};
}

/** Erro relativo entre o que o agente disse e a verdade. */
function erro(estimado, real) {
  const e = comoNumero(estimado); const r = comoNumero(real);
  if (e === null || r === null || r === 0) return null;
  return Math.abs(e - r) / r;
}

function faixa(erros, limite) {
  const v = erros.filter((x) => x !== null);
  if (!v.length) return '—';
  return Math.round(v.filter((x) => x <= limite).length * 100 / v.length) + '%';
}

function mediana(erros) {
  const v = erros.filter((x) => x !== null).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.floor(v.length / 2)];
}

async function main() {
  const casos = gabarito(MARCA, AMOSTRA);
  const temRede = !!process.env.AUTOFILL_URL;

  console.log(`\n── Teste contra gabarito: ${MARCA} ──`);
  console.log(`   ${casos.length} veículos com preço conhecido`);
  console.log(`   modo: ${temRede ? 'COLETA REAL' : 'SIMULADO (sem AUTOFILL_URL)'}\n`);

  // ── Parte 1: a derivação entre anos ───────────────────────────────────────
  // Metade do ganho de cota vem daqui, então precisa ser medida à parte.
  const errosDeriv = {1: [], 2: []};
  for (const c of casos) {
    for (const [anoViz, camposViz] of Object.entries(c.vizinhos || {})) {
      const d = Math.abs(Number(anoViz) - Number(c.ano));
      if (d !== 1 && d !== 2) continue;
      for (const campo of CFG.escopo.campos_preco) {
        const base = c.campos[campo]; const real = (camposViz || {})[campo];
        if (!valorUtil(base) || !valorUtil(real)) continue;
        const est = derivarPreco(base, c.ano, anoViz);
        if (est) errosDeriv[d].push(erro(est, real));
      }
    }
  }

  console.log('▸ Derivação entre anos (o que economiza cota)');
  for (const d of [1, 2]) {
    const e = errosDeriv[d];
    const m = mediana(e);
    if (m === null) { console.log(`  ${d} ano: sem amostra`); continue; }
    console.log(`  ${d} ano(s): n=${e.length} | erro mediano ${(m * 100).toFixed(1)}%` +
      ` | ≤10%: ${faixa(e, 0.10)} | ≤15%: ${faixa(e, 0.15)} | ≤25%: ${faixa(e, 0.25)}`);
  }

  // ── Parte 2: a coleta ─────────────────────────────────────────────────────
  if (!temRede) {
    console.log('\n▸ Coleta: não medida (defina AUTOFILL_URL para medir)');
    console.log('\n⚠️  Sem a coleta real, este teste NÃO responde "o agente acerta?".');
    console.log('   Ele só valida a derivação e as regras. A taxa de acerto da');
    console.log('   busca (CSE+Gemini) exige a function configurada.');
    return;
  }

  const porCampo = {};
  let aprovados = 0; let revisao = 0; let descartados = 0; let falhas = 0;

  for (const c of casos) {
    process.stdout.write(`  ${c.modelo.slice(0, 34).padEnd(36)} ${c.ano} … `);
    try {
      const fields = await coletar(MARCA, c.modelo, c.ano, c.comb);
      const valores = {}; const fontes = {};
      for (const [k, h] of Object.entries(fields || {})) {
        if (!h || h.value === null || typeof h.value === 'object') continue;
        valores[k] = h.value; fontes[k] = h.sources || [];
      }
      const r = avaliar(valores, fontes);
      aprovados += Object.keys(r.aprovados).length;
      revisao += Object.keys(r.revisao).length;
      descartados += Object.keys(r.descartados).length;

      // O que importa: o que ele aprovaria bate com a verdade?
      const linha = [];
      for (const campo of CFG.escopo.campos_preco) {
        const real = c.campos[campo];
        const dito = r.aprovados[campo] ?? r.revisao[campo];
        if (!valorUtil(real) || dito === undefined) continue;
        const e = erro(dito, real);
        (porCampo[campo] = porCampo[campo] || []).push(e);
        if (e !== null) linha.push(`${campo.replace('value', '')}:${(e * 100).toFixed(0)}%`);
      }
      console.log(linha.length ? linha.join(' ') : '(sem preço coletado)');
    } catch (e) {
      falhas++;
      console.log('falhou — ' + e.message);
    }
  }

  console.log('\n▸ Coleta vs. gabarito, por campo');
  let todos = [];
  for (const [campo, e] of Object.entries(porCampo)) {
    const m = mediana(e);
    todos = todos.concat(e);
    console.log(`  ${campo.padEnd(22)} n=${String(e.length).padStart(3)}` +
      ` | mediano ${m === null ? '—' : (m * 100).toFixed(1) + '%'}` +
      ` | ≤15%: ${faixa(e, 0.15)} | ≤30%: ${faixa(e, 0.30)}`);
  }

  const mg = mediana(todos);
  console.log('\n▸ Veredito');
  console.log(`  campos aprovados automaticamente: ${aprovados}`);
  console.log(`  enviados para revisão humana:     ${revisao}`);
  console.log(`  descartados pela validação:       ${descartados}`);
  console.log(`  consultas que falharam:           ${falhas}`);
  if (mg !== null) {
    console.log(`  erro mediano geral:               ${(mg * 100).toFixed(1)}%`);
    console.log(`  dentro de ±15%:                   ${faixa(todos, 0.15)}`);
    console.log('\n  ' + (mg <= 0.15
      ? '✅ Precisão aceitável — dá para escalar.'
      : '⚠️  Erro alto. Escalar assim encheria a base de preço errado.'));
  }
}

main().catch((e) => { console.error('Falhou: ' + e.message); process.exit(1); });
