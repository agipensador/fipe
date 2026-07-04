#!/usr/bin/env python3
"""
Auditoria e regressão dos JSONs FIPE (docs/).
Simula a lógica de FipeJsonLookup do app Flutter.

Uso:
  python3 tools/fipe_audit.py
  python3 tools/fipe_audit.py --json-dir docs --report tools/audit_report.txt
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

BASE_URL = "https://raw.githubusercontent.com/agipensador/fipe/main/docs"

CONSTRUCTION_KEYS = {
    "valuecopystore", "valuekeycopy", "valuekeyalarm", "valuekeyconfect",
    "valuekeyconfectalarm", "valuedatakeychip", "keylaminatypegold",
    "laminatexdica", "laminaskeys", "laminapalhetas", "laminapincode",
    "transponderclone", "transpondercodigo", "transpondernomenclatura",
    "transponderimage", "telecomandobatery", "telecomandofrequency",
    "telecomandoprocedure", "telecomandoimage", "telecomandobrands",
    "maquinascodificadoras", "videolink",
}

MOJIBAKE = [
    ("Ã", "Á"), ("Ã¡", "á"), ("Ã£", "ã"), ("Ã©", "é"), ("Ãª", "ê"),
    ("Ã«", "ë"), ("Ã­", "í"), ("Ã³", "ó"), ("Ã´", "ô"), ("Ãµ", "õ"),
    ("Ã§", "ç"), ("HÃ­b", "Híb"),
]

FILE_BRAND = {
    "alfaromeo.json": "alfaromeo",
    "agrale.json": "agrale",
    "asiamotors.json": "asiamotors",
    "astonmartin.json": "astonmartin",
    "audi.json": "audi",
    "bmw.json": "bmw",
    "citroen.json": "citroen",
    "citroen2.json": "citroen",
    "dodge.json": "dodge",
    "fiat.json": "fiat",
    "fiat2.json": "fiat",
    "ford.json": "ford",
    "ford2.json": "ford",
    "honda.json": "honda",
    "hyundai.json": "hyundai",
    "jeep.json": "jeep",
    "kia.json": "kia",
    "mercedes.json": "mercedes-benz",
    "mitsubishi.json": "mitsubishi",
    "nissan.json": "nissan",
    "peugeot.json": "peugeot",
    "renault.json": "renault",
    "renault2.json": "renault",
    "suzuki.json": "suzuki",
    "toyota.json": "toyota",
    "volkswagen.json": "volkswagen",
    "chevrolet.json": "gm - chevrolet",
    "chev2.json": "gm - chevrolet",
    "fipe.json": "",
}


def repair_mojibake(value: str) -> str:
    for old, new in MOJIBAKE:
        value = value.replace(old, new)
    return value


def normalize_fuel(value: str) -> str:
    value = repair_mojibake(value)
    value = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", value).strip().lower()
    for src, dst in [
        ("á", "a"), ("à", "a"), ("â", "a"), ("ã", "a"),
        ("é", "e"), ("ê", "e"), ("ë", "e"),
        ("í", "i"), ("ó", "o"), ("ô", "o"), ("õ", "o"),
        ("ú", "u"), ("ç", "c"),
    ]:
        value = value.replace(src, dst)
    value = re.sub(r"\s+", " ", value)
    if value == "lcool" or value.startswith("lcool "):
        value = "a" + value
    return value


def normalize_model(value: str) -> str:
    value = repair_mojibake(value)
    value = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", value)
    value = normalize_fuel(value)
    value = value.replace("_pdot", " ")
    value = re.sub(r"[^a-z0-9 ]", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def is_construction_or_year(key: str) -> bool:
    if re.fullmatch(r"\d{4}", key.strip()):
        return True
    return normalize_fuel(key) in CONSTRUCTION_KEYS


def filter_fuel_keys(keys: list[str]) -> list[str]:
    return [k for k in keys if not is_construction_or_year(k)]


def resolve_json_url(brand: str, modelo: str) -> str:
    if not modelo:
        return f"{BASE_URL}/fipe.json"
    letter = modelo[0].lower()
    b = brand.lower().strip()
    if b in ("citroen", "citroën", "citroã«n"):
        f = "citroen.json" if letter < "d" else "citroen2.json"
    elif b == "fiat":
        f = "fiat.json" if letter < "e" else "fiat2.json"
    elif b == "ford":
        f = "ford.json" if letter < "m" else "ford2.json"
    elif b == "renault":
        f = "renault.json" if letter < "g" else "renault2.json"
    elif b in ("gm - chevrolet", "gm - chevrolet"):
        f = "chevrolet.json" if letter < "m" else "chev2.json"
    else:
        mapping = {
            "alfaromeo": "alfaromeo.json", "agrale": "agrale.json",
            "asiamotors": "asiamotors.json", "astonmartin": "astonmartin.json",
            "audi": "audi.json", "bmw": "bmw.json", "dodge": "dodge.json",
            "honda": "honda.json", "hyundai": "hyundai.json", "jeep": "jeep.json",
            "kia": "kia.json", "mercedes-benz": "mercedes.json",
            "mitsubishi": "mitsubishi.json", "nissan": "nissan.json",
            "peugeot": "peugeot.json", "suzuki": "suzuki.json",
            "toyota": "toyota.json", "volkswagen": "volkswagen.json",
        }
        f = mapping.get(b, "fipe.json")
    return f"{BASE_URL}/{f}"


def model_variants(model: str) -> list[str]:
    repaired = repair_mojibake(model)
    return list({
        model, repaired,
        repaired.replace(".", "_PDOT"),
        repaired.replace("_PDOT", "."),
    })


def resolve_model_key(keys: list[str], requested: str) -> str | None:
    if not keys or not requested.strip():
        return None
    for v in model_variants(requested):
        if v in keys:
            return v
    for v in model_variants(requested):
        nv = normalize_model(v)
        for k in keys:
            if normalize_model(k) == nv:
                return k
    return None


def ordered_fuel_candidates(requested: str) -> list[str]:
    n = normalize_fuel(requested)
    if "gasolina" in n and "alcool" in n:
        return ["gasolina/alcool", "gasolina álcool", "alcool", "álcool", "gasolina"]
    if n == "flex":
        return ["flex", "gasolina flex", "álcool flex", "gasolina", "álcool"]
    if n == "alcool":
        return ["alcool", "álcool", "lcool", "Ãlcool"]
    if n == "diesel":
        return ["diesel"]
    if "hibrido" in n:
        return ["hibrido", "Híbrido", "HÃ­brido"]
    if "eletrico" in n:
        return ["eletrico", "elétrico"]
    return [requested]


def resolve_fuel_key(keys: list[str], requested: str, model: str | None = None) -> str | None:
    fuel_keys = filter_fuel_keys(keys)
    if not fuel_keys or not requested.strip():
        return None
    if requested in fuel_keys:
        return requested
    nr = normalize_fuel(requested)
    for k in fuel_keys:
        if normalize_fuel(k) == nr:
            return k
    for c in ordered_fuel_candidates(requested):
        nc = normalize_fuel(c)
        for k in fuel_keys:
            if normalize_fuel(k) == nc:
                return k
    if model:
        mn = normalize_model(model)
        if nr == "diesel" and "diesel" in mn:
            for k in fuel_keys:
                if normalize_fuel(k) == "diesel":
                    return k
        if "hibrido" in mn:
            for k in fuel_keys:
                if normalize_fuel(k) == "hibrido":
                    return k
    return None


def validate_structure(root: dict) -> list[str]:
    issues = []
    for model, node in root.items():
        if not isinstance(node, dict):
            issues.append(f"  modelo '{model}': nó não é objeto")
            continue
        for fuel, years in node.items():
            if is_construction_or_year(fuel):
                issues.append(
                    f"  modelo '{model}': chave inválida no nível combustível '{fuel}'"
                )
                continue
            if not isinstance(years, dict):
                issues.append(f"  modelo '{model}'/'{fuel}': anos não é objeto")
                continue
            for year, data in years.items():
                if not re.fullmatch(r"\d{4}", str(year).strip()):
                    issues.append(
                        f"  modelo '{model}'/'{fuel}': ano inválido '{year}'"
                    )
                elif not isinstance(data, dict):
                    issues.append(
                        f"  modelo '{model}'/'{fuel}'/'{year}': dados não é objeto"
                    )
    return issues


def audit_file(path: Path) -> dict:
    name = path.name
    brand = FILE_BRAND.get(name, "")
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    root = data.get("items", [{}])[0]
    if not isinstance(root, dict):
        return {"file": name, "error": "items[0] inválido"}

    structure_issues = validate_structure(root)
    wrong_file = []
    lookup_ok = 0
    lookup_fail = []

    for model, node in root.items():
        if not isinstance(node, dict):
            continue
        expected_url = resolve_json_url(brand, model)
        if not expected_url.endswith(name):
            wrong_file.append(model)

        fuel_keys = list(node.keys())
        for fuel, years in node.items():
            if is_construction_or_year(fuel) or not isinstance(years, dict):
                continue
            resolved_model = resolve_model_key(list(root.keys()), model)
            resolved_fuel = resolve_fuel_key(fuel_keys, fuel, resolved_model)
            for year in years:
                if not re.fullmatch(r"\d{4}", str(year).strip()):
                    continue
                if resolved_model and resolved_fuel:
                    lookup_ok += 1
                else:
                    lookup_fail.append(
                        f"{model} | {fuel} | {year} | model={resolved_model} fuel={resolved_fuel}"
                    )

    return {
        "file": name,
        "brand": brand,
        "models": len(root),
        "structure_issues": structure_issues,
        "wrong_file_count": len(wrong_file),
        "wrong_file_sample": wrong_file[:5],
        "lookup_ok": lookup_ok,
        "lookup_fail": lookup_fail[:20],
        "lookup_fail_count": len(lookup_fail),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Auditoria JSON FIPE")
    parser.add_argument(
        "--json-dir",
        default="docs",
        help="Diretório dos JSONs (default: docs)",
    )
    parser.add_argument(
        "--report",
        default="",
        help="Arquivo de saída do relatório",
    )
    args = parser.parse_args()

    json_dir = Path(args.json_dir)
    if not json_dir.is_dir():
        print(f"Diretório não encontrado: {json_dir}", file=sys.stderr)
        return 1

    lines = ["# Relatório auditoria FIPE", ""]
    total_models = 0
    total_structure = 0
    total_wrong_file = 0
    total_lookup_fail = 0

    for path in sorted(json_dir.glob("*.json")):
        result = audit_file(path)
        total_models += result.get("models", 0)
        si = result.get("structure_issues", [])
        total_structure += len(si)
        total_wrong_file += result.get("wrong_file_count", 0)
        total_lookup_fail += result.get("lookup_fail_count", 0)

        lines.append(f"## {result['file']} ({result.get('models', 0)} modelos)")
        if result.get("error"):
            lines.append(f"- ERRO: {result['error']}")
            continue
        lines.append(f"- Marca simulada: `{result.get('brand', '')}`")
        lines.append(f"- Lookup OK (entradas ano): {result.get('lookup_ok', 0)}")
        lines.append(f"- Lookup falhou: {result.get('lookup_fail_count', 0)}")
        lines.append(f"- Modelos em arquivo errado (split): {result.get('wrong_file_count', 0)}")
        if result.get("wrong_file_sample"):
            lines.append(f"  - Ex.: {result['wrong_file_sample']}")
        if si:
            lines.append(f"- Problemas de estrutura: {len(si)}")
            for issue in si[:15]:
                lines.append(issue)
            if len(si) > 15:
                lines.append(f"  ... e mais {len(si) - 15}")
        if result.get("lookup_fail"):
            lines.append("- Amostra falhas lookup:")
            for f in result["lookup_fail"][:10]:
                lines.append(f"  - {f}")
        lines.append("")

    lines.extend([
        "## Resumo global",
        f"- Arquivos: {len(list(json_dir.glob('*.json')))}",
        f"- Modelos: {total_models}",
        f"- Problemas estrutura: {total_structure}",
        f"- Modelos em arquivo errado: {total_wrong_file}",
        f"- Falhas lookup: {total_lookup_fail}",
    ])

    report = "\n".join(lines)
    print(report)

    if args.report:
        Path(args.report).write_text(report, encoding="utf-8")
        print(f"\nRelatório salvo em: {args.report}")

    return 0 if total_lookup_fail == 0 and total_structure == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
