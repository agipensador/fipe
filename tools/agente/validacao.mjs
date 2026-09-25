/**
 * As regras que separam dado bom de dado inventado.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * POR QUE ESTE ARQUIVO É O MAIS IMPORTANTE DO AGENTE
 *
 * Um agente que coleta em escala e erra em escala é pior que nenhum agente.
 * A base é pública, o app a lê direto do GitHub **sem cache**, e o chaveiro
 * usa esses números para orçar um serviço. Preço errado vira prejuízo real
 * para quem confiou.
 *
 * Por isso a regra é: **campo ausente é melhor que campo errado**. O app
 * trata ausência (não exibe a linha); valor errado ele exibe como verdade.
 *
 * Todos os limiares aqui foram MEDIDOS sobre 3163 registros completos das
 * marcas com cobertura 100% (audi, bmw, renault, jac, kia, agrale,
 * asiamotors) em 10/09/2026. Nenhum é chute.
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const CFG = JSON.parse(
  fs.readFileSync(path.join(AQUI, 'config.json'), 'utf8'),
);

/** Converte "1.234,50" / "1234.50" / "R$ 700" em número. Null se não der. */
export function comoNumero(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().replace(/^R\$\s*/i, '');
  if (!s) return null;
  // "1.234,50" → "1234.50"  |  "1234,50" → "1234.50"
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Um valor só entra se disser alguma coisa.
 *
 * ⚠️ `"0"` é descartado: é indistinguível de "não temos" para quem olha a
 * tela, e foi o defeito medido na FIAT — 498 registros zerados que o app
 * exibia como preço.
 */
export function valorUtil(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  if (!s || s === 'null' || s === 'undefined' || s === '-') return false;
  if (/^0+([.,]0+)?$/.test(s)) return false;
  return true;
}

/**
 * O preço é um número plausível para uma chave?
 *
 * ⚠️ A FAIXA É LARGA DE PROPÓSITO, e isso custou uma recalibração.
 *
 * A primeira versão usava a mediana de cada campo com fator 5×. Testada
 * contra a própria base, **reprovou 28,6% de dado legítimo** — 862 registros
 * só em `valueKeyCopy`. O motivo: a amostra de onde tirei as medianas era
 * enviesada (só registros com os 5 campos), e a base real vai de R$20 (Audi
 * A6 1995) a R$125.000 (Rolls-Royce Cullinan).
 *
 * A lição: numa base que cobre do Gol ao Rolls, valor absoluto quase não
 * discrimina. Quem discrimina é a RAZÃO entre campos — ver `razaoCoerente`.
 */
export function precoNaFaixa(campo, valor) {
  const n = comoNumero(valor);
  if (n === null) return {ok: false, motivo: `"${valor}" não é número`};
  const {min, max} = CFG.precos.faixa_absoluta;
  if (n < min || n > max) {
    return {ok: false, motivo: `${campo}=${n} fora de ${min}–${max}`};
  }
  return {ok: true};
}

/**
 * A proporção entre confeccionada e cópia — o filtro que realmente pega erro.
 *
 * ⚠️ MEDIDO sobre 5023 registros: mediana 2,27, e 98% entre 2,0 e 5,0.
 *
 * É estável onde o valor absoluto não é: a chave de um Rolls e a de um Gol
 * custam 100× diferente, mas a proporção entre os dois serviços é a mesma.
 * Por isso esta regra pega o erro clássico da coleta — o agente capturar o
 * preço do CARRO no lugar do preço da chave — sem reprovar carro caro.
 */
export function razaoCoerente(campos) {
  const cp = comoNumero(campos.valueKeyCopy);
  const cf = comoNumero(campos.valueKeyConfect);
  if (cp === null || cf === null || cp <= 0) return {ok: true};

  const r = cf / cp;
  const {min, max} = CFG.precos.razao_confec_copy;
  if (r < min || r > max) {
    return {
      ok: false,
      motivo: `confec/copy=${r.toFixed(2)} fora de ${min}–${max}` +
        ` (copy=${cp}, confec=${cf}) — provável preço do veículo, não da chave`,
    };
  }
  return {ok: true};
}

/**
 * A ordem entre os preços — o filtro mais forte que existe aqui.
 *
 * ⚠️ MEDIDO: 3148 de 3163 registros completos (100%, arredondado) respeitam
 * cópia ≤ alarme ≤ confeccionada+alarme. Uma violação é quase certamente
 * troca de campo na extração.
 *
 * `valueCopyStore` fica FORA da comparação de propósito: é o que a
 * CONCESSIONÁRIA cobra (mediana 2880), não o chaveiro. Compará-lo com os
 * outros reprovaria registro correto.
 */
export function ordemCoerente(campos) {
  const seq = CFG.precos.ordem_obrigatoria
    .map((k) => ({k, n: comoNumero(campos[k])}))
    .filter((x) => x.n !== null);

  for (let i = 1; i < seq.length; i++) {
    if (seq[i].n < seq[i - 1].n) {
      return {
        ok: false,
        motivo: `${seq[i].k}=${seq[i].n} < ${seq[i - 1].k}=${seq[i - 1].n}` +
          ' — ordem esperada: cópia ≤ alarme ≤ confec+alarme',
      };
    }
  }
  return {ok: true};
}

/**
 * Deriva o preço de um ano vizinho a partir de um ano já conhecido.
 *
 * ⚠️ MEDIDO sobre 1997 pares de anos consecutivos: o preço sobe em mediana
 * +7,7% ao ano, e 79% dos pares ficam entre 0% e +15%. É o que torna o agente
 * viável — sem derivação seriam 117 mil consultas (~8 anos de execução).
 *
 * ⚠️ MAS DERIVADO NÃO É MEDIDO, e a distinção tem que sobreviver no arquivo.
 * Por isso:
 *   • só deriva até `max_anos_derivados` de distância — o erro composto
 *     cresce rápido (6 anos a ±7,7% já é ±50% de incerteza);
 *   • o registro recebe `_derivadoDe`, dizendo de qual ano veio;
 *   • nunca sobrescreve valor coletado nem existente.
 *
 * Quem for revisar o PR consegue ver o que é medição e o que é estimativa.
 */
export function derivarPreco(valorBase, anoBase, anoAlvo, campo) {
  // ⚠️ SÓ PREÇO. Ver `_derivar_so_preco` no config.
  //
  // Dado técnico varia em DEGRAU, não em rampa: a lâmina do Palio é
  // `Silca GT15` até 2002 e `GT15ouSIP22` de 2003 em diante. Não existe
  // "lâmina 7,7% maior" — derivar aqui inventaria uma peça que não existe.
  if (campo !== undefined && !CFG.precos.campos_derivaveis.includes(campo)) {
    return null;
  }

  const n = comoNumero(valorBase);
  if (n === null) return null;

  const distancia = Number(anoAlvo) - Number(anoBase);
  if (!Number.isFinite(distancia) || distancia === 0) return null;
  if (Math.abs(distancia) > CFG.precos.max_anos_derivados) return null;

  const fator = Math.pow(CFG.precos.progressao_anual, distancia);
  const derivado = Math.round(n * fator);

  const {min, max} = CFG.precos.faixa_absoluta;
  if (derivado < min || derivado > max) return null;

  return String(derivado);
}

/**
 * Link de vídeo: só de plataforma conhecida, e sempre https.
 *
 * ⚠️ Sem allowlist, este campo vira vetor de link malicioso num app com 10
 * mil usuários — o agente escreve o que a busca devolveu, e a busca não
 * distingue vídeo de armadilha.
 */
const HOSTS_VIDEO = [
  'youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com',
  'tiktok.com', 'www.tiktok.com', 'vm.tiktok.com',
  'instagram.com', 'www.instagram.com',
  'kwai.com', 'www.kwai.com', 'k.kwai.com',
];

export function linkVideoValido(url) {
  try {
    const u = new URL(String(url).trim());
    if (u.protocol !== 'https:') {
      return {ok: false, motivo: 'link de vídeo precisa ser https'};
    }
    const host = u.hostname.toLowerCase();
    if (!HOSTS_VIDEO.includes(host)) {
      return {ok: false, motivo: `host "${host}" fora da allowlist de vídeo`};
    }
    return {ok: true};
  } catch {
    return {ok: false, motivo: 'URL inválida'};
  }
}

/**
 * Decide o destino de um conjunto de campos coletados para UM veículo.
 *
 * Devolve `{aprovados, revisao, descartados}` — nunca lança, porque um erro
 * num veículo não pode derrubar o lote inteiro.
 */
export function avaliar(coletado, fontesPorCampo = {}) {
  const aprovados = {};
  const revisao = {};
  const descartados = {};

  const ordem = ordemCoerente(coletado);
  const razao = razaoCoerente(coletado);

  for (const [campo, valor] of Object.entries(coletado || {})) {
    if (!valorUtil(valor)) {
      descartados[campo] = 'vazio ou zerado';
      continue;
    }

    const ehPreco = CFG.escopo.campos_preco.includes(campo);

    if (ehPreco) {
      if (!ordem.ok) { descartados[campo] = ordem.motivo; continue; }
      if (!razao.ok) { descartados[campo] = razao.motivo; continue; }
      const faixa = precoNaFaixa(campo, valor);
      if (!faixa.ok) { descartados[campo] = faixa.motivo; continue; }
    }

    if (campo === 'videoLink') {
      const v = linkVideoValido(valor);
      if (!v.ok) { descartados[campo] = v.motivo; continue; }
    }

    // Consenso: quantas fontes independentes disseram a mesma coisa?
    const fontes = fontesPorCampo[campo] || [];
    if (fontes.length >= CFG.confianca.min_fontes_para_auto) {
      aprovados[campo] = String(valor).trim();
    } else {
      revisao[campo] = String(valor).trim();
    }
  }

  return {aprovados, revisao, descartados};
}
