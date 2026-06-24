#!/usr/bin/env node
// Test de regresion del reconocimiento de distritos de check-coverage.
//
// Usa `district-corpus.json`: 1.094 formas reales en que los clientes han escrito
// su distrito por WhatsApp (con tildes, abreviaturas, prefijos basura, direcciones
// pegadas, "Lima/Lima/X", typos, etc.). El objetivo es que la red de seguridad de
// check-coverage reconozca como Lima Metropolitana / Callao (= contraentrega) la
// mayor parte posible de estas variantes sin producir falsos positivos.
//
// Correr:  node functions/check-coverage/test/coverage.test.cjs

const fs = require("fs");
const path = require("path");

require(path.join(__dirname, "..", "index.js"));
const { normalizePlace, isLimaMetroDistrict, isCallaoDistrict } =
  globalThis.__aurelaCheckCoverage;

const corpus = JSON.parse(
  fs.readFileSync(path.join(__dirname, "district-corpus.json"), "utf8"),
);

// Umbral minimo de cobertura sobre el corpus crudo (peor caso: sin que el LLM
// limpie el texto antes). Bajar este numero solo si se justifica con datos.
const MIN_COVERAGE = 0.92;

function recognize(raw) {
  const n = normalizePlace(raw);
  if (isLimaMetroDistrict(n)) return "lima";
  if (isCallaoDistrict(n)) return "callao";
  return null;
}

let failures = 0;
function check(name, cond) {
  if (cond) return;
  failures += 1;
  console.error(`  ✗ ${name}`);
}

// --- 1) Cobertura sobre el corpus real ---------------------------------------
let recognized = 0;
const misses = [];
for (const raw of corpus) {
  if (recognize(raw)) recognized += 1;
  else misses.push(normalizePlace(raw));
}
const coverage = recognized / corpus.length;
console.log(
  `Corpus: ${recognized}/${corpus.length} reconocidos (${(coverage * 100).toFixed(1)}%) | umbral ${(MIN_COVERAGE * 100).toFixed(0)}%`,
);
check(`cobertura >= ${(MIN_COVERAGE * 100).toFixed(0)}%`, coverage >= MIN_COVERAGE);

// --- 2) Casos puntuales que DEBEN reconocerse (representan cada tipo de error) -
const MUST_MATCH = [
  ["\n- la Molina", "lima"], // prefijo viñeta
  ["9 la victoria", "lima"], // prefijo numerico
  ["Jesús Maria", "lima"], // tilde
  ["'lima/lima/san Miguel'", "lima"], // formato Lima/Lima/X
  ["Av. Pezet 131 San Isidro", "lima"], // direccion + distrito
  ["ate salamanca", "lima"], // anexo de Ate
  ["Cercadodelima", "lima"], // sin espacios
  ["S J L", "lima"], // abreviatura deletreada
  ["s.j.l.", "lima"], // abreviatura con puntos
  ["SMP", "lima"],
  ["VMT", "lima"],
  ["santiago de surc", "lima"], // typo en nombre largo
  ["Magadelena del Mar", "lima"], // typo en nombre largo
  ["San Juan De Lurigancho", "lima"],
  ["barranco", "lima"],
  ["Ventanilla", "callao"],
  ["Bellavista", "callao"],
  ["carmen de la legua", "callao"],
  ["calllao", "callao"], // typo de callao
];
for (const [input, expected] of MUST_MATCH) {
  check(`reconoce ${JSON.stringify(input)} -> ${expected}`, recognize(input) === expected);
}

// --- 3) Falsos positivos: lugares de OTRAS regiones NO deben dar contraentrega -
const MUST_NOT_MATCH = [
  "trujillo", "arequipa", "cusco", "piura", "chiclayo", "cayma", "huancayo",
  "tacna", "iquitos", "juliaca", "el porvenir", "la esperanza", "huanchaco",
  "castilla", "jose leonardo ortiz", "cerro colorado", "ica", "chimbote",
  "puno", "ayacucho", "pucallpa", "canete", "huacho", "huaral", "barranca",
];
for (const place of MUST_NOT_MATCH) {
  check(`NO reconoce ${JSON.stringify(place)}`, recognize(place) === null);
}

// --- Resultado ---------------------------------------------------------------
if (failures > 0) {
  console.error(`\n✗ ${failures} chequeo(s) fallaron`);
  console.error(`\nResiduo del corpus sin reconocer (${misses.length}):`);
  for (const m of misses) console.error(`  ${JSON.stringify(m)}`);
  process.exit(1);
}
console.log("✓ Todos los chequeos pasaron");
