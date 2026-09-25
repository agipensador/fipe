#!/usr/bin/env node
/**
 * Consulta um veículo como o app o veria.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PARA QUE SERVE
 *
 * Responder "o agente preencheu isso?" sem abrir o JSON na mão nem instalar o
 * app. Lê o mesmo arquivo que o aplicativo baixa e mostra campo a campo o que
 * o chaveiro veria na tela.
 *
 * Por padrão lê o arquivo LOCAL. Com --remoto, baixa do GitHub — que é o que
 * o app realmente consome, e a única forma de confirmar que o merge chegou ao
 * usuário.
 *
 * USO
 *   node tools/agente/consultar.mjs --marca renault --modelo duster
 *   node tools/agente/consultar.mjs --marca renault --modelo duster --ano 2015
 *   node tools/agente/consultar.mjs --marca jaecoo --modelo 7 --remoto
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CFG} from './validacao.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(AQUI, '..', '..', 'docs');
const RAW = 'https://raw.githubusercontent.com/agipensador/fipe/main/docs';

const arg = process.argv.slice(2);
const opt = (n, p) => {
  const i = arg.indexOf('--' + n);
  return i >= 0 && arg[i + 1] && !arg[i + 1].startsWith('--') ? arg[i + 1] : p;
};

const MARCA = opt('marca', '');
const MODELO = (opt('modelo', '') || '').toLowerCase();
const ANO = opt('ano', '');
const REMOTO = arg.includes('--remoto');

if (!MARCA) {
  console.log('Uso: consultar.mjs --marca <arquivo> [--modelo <texto>] [--ano <aaaa>] [--remoto]');
  process.exit(1);
}

async function carregar() {
  if (REMOTO) {
    const r = await fetch(`${RAW}/${MARCA}.json`);
    if (!r.ok) throw new Error(`GitHub devolveu HTTP ${r.status}`);
    return r.json();
  }
  const p = path.join(DOCS, MARCA + '.json');
  if (!fs.existsSync(p)) throw new Error('arquivo não existe: ' + p);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const TODOS = [...CFG.escopo.campos_preco, ...CFG.escopo.campos_tecnicos];

const j = await carregar();
const root = (j.items && j.items[0]) || {};
const fonte = REMOTO ? 'GitHub (o que o APP vê)' : 'arquivo local';

// `_PDOT` é o ponto escapado — o usuário digita "1.6", o arquivo guarda "1_PDOT6".
const achados = Object.keys(root).filter((m) =>
  !MODELO || m.toLowerCase().replace(/_pdot/g, '.').includes(MODELO));

console.log(`
── ${MARCA} — ${fonte} ──`);
console.log(`   ${achados.length} modelo(s) com "${MODELO || '(todos)'}"
`);

for (const m of achados.slice(0, 6)) {
  for (const [comb, anos] of Object.entries(root[m] || {})) {
    if (/lamina|transponder|telecomando|maquinas|value|video/i.test(comb)) continue;
    for (const [ano, v] of Object.entries(anos || {})) {
      if (ANO && ano !== ANO) continue;
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;

      const preenchidos = TODOS.filter((c) => v[c] !== undefined &&
        String(v[c]).trim() && String(v[c]).trim() !== '0');
      const pct = Math.round(preenchidos.length * 100 / TODOS.length);

      console.log(`${m.replace(/_PDOT/g, '.').slice(0, 44)}`);
      console.log(`   ${ano} · ${comb} · ${preenchidos.length}/${TODOS.length} campos (${pct}%)` +
        (v.precoAtualizadoEm ? `  · preço de ${v.precoAtualizadoEm}` : ''));

      for (const c of TODOS) {
        const x = v[c];
        const tem = x !== undefined && String(x).trim() && String(x).trim() !== '0';
        console.log(`     ${tem ? '✅' : '⬜'} ${c.padEnd(24)}${tem ? String(x).slice(0, 44) : ''}`);
      }
      console.log('');
    }
  }
}

if (!achados.length) {
  console.log('Nenhum modelo casou. Modelos disponíveis (10 primeiros):');
  Object.keys(root).slice(0, 10)
    .forEach((m) => console.log('   ' + m.replace(/_PDOT/g, '.')));
}
