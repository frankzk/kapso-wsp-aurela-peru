// send-payment: entrega el texto de pago (Yape) para Shalom/Olva con el numero
// HARDCODEADO. Blindaje anti-ingenieria social: el LLM NUNCA compone ni teclea el
// numero — lo envia esta funcion. El texto replica exactamente el tono del prompt.
// Los datos oficiales de Aurela (razon social + Yape) son dato fijo del sistema.
const YAPE_NAME = "Grupo GF SAC";
const YAPE_NUMBER = "930 555 309";

const SCRIPTS = {
  shalom:
`Listo, lo enviamos a esa agencia Shalom 🙌
Para separarlo, realiza el adelanto de S/30 al Yape:
${YAPE_NAME}
${YAPE_NUMBER}
El saldo lo pagas al recoger.
También necesito el DNI del titular que recogerá.
Envíame el voucher o captura para pasarlo a validación logística ✅`,
  olva:
`Perfecto 😊
Por Olva Courier el pago es anticipado completo.
Puedes realizarlo al Yape:
${YAPE_NAME}
📱 ${YAPE_NUMBER}
Cuando lo realices, envíame el voucher o captura para continuar con la confirmación ✅`,
};

async function handler(request, env = globalThis) {
  return handleRequest(request, env);
}

if (typeof addEventListener === "function") {
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request, globalThis));
  });
}

async function handleRequest(request) {
  const input = await readInput(request);
  const courier = String(input.courier || "").trim().toLowerCase();
  const text = SCRIPTS[courier];
  if (!text) {
    // Courier no reconocido: aun asi devolvemos el numero OFICIAL (nunca uno inventado),
    // con ok:false para que el agente use este texto exacto.
    return json({
      ok: false,
      error: "courier_invalido",
      text: `Puedes realizar el pago al Yape:\n${YAPE_NAME}\n📱 ${YAPE_NUMBER}\nEnvíame el voucher o captura para continuar ✅`,
    });
  }
  return json({ ok: true, courier, text });
}

async function readInput(request) {
  try {
    if (request.method === "GET") {
      const u = new URL(request.url);
      return Object.fromEntries(u.searchParams.entries());
    }
    const raw = await request.text();
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && parsed.input && typeof parsed.input === "object" ? parsed.input : parsed;
  } catch {
    return {};
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

globalThis.__aurelaSendPayment = { handleRequest, handler, SCRIPTS, YAPE_NAME, YAPE_NUMBER };
