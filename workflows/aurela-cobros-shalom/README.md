# Aurela Cobros Shalom

Línea de cobro del **saldo pendiente de los pedidos enviados por Shalom**.
Quien escribe ya compró y pagó el adelanto: no es un lead y no se le vende.

Replicado el 2026-09-28 del workflow "Kenku Cobros Shalom" (proyecto Kenku Perú).
En Aurela atiende el **+51 929 332 058** (`1398153106708478`).

| Pieza | ID |
|---|---|
| Workflow | `784bb035-5d11-46ba-878f-dbf8de33fdb5` |
| Disparador (929 332 058) | `0a1868f1-5e1b-40f0-9d9b-f80d67f25eee` |
| `shalom-router` | `7203c505-dfc5-475d-8602-efe70f4fda34` |
| `send-text` | `5fb54b2b-bbdc-47a4-af9a-ea3c57f82add` |
| `notify-team` (el de Aurela, compartido) | `fc7a67ec-dc65-420f-8cf5-79a0be4b032b` |
| Modelo del agente | `google/gemini-3.7-flash` |

`definition.json` es la definición tal como se cargó en Kapso (con `function_id`
reales, no slugs).

## Cómo decide

El silencio lo decide el código (`functions/shalom-router`); la respuesta, el agente.

| Entra | Arista | Qué pasa |
|---|---|---|
| Botón de la plantilla (`Pagar con Yape`, `Transferencia / Depósito`, `Link de pago`) | `boton` | El bot calla: contesta el dashboard. A las 6 h, un único recordatorio si nadie le escribió y la ventana de 24 h sigue abierta |
| Acuse trivial (`ok`, `gracias`, un emoji…) | `trivial` | El bot calla: contesta el dashboard |
| Cualquier dígito, o `no` / `nunca` / `cancelar` / `anular` / `devolver` | `texto` | Nunca es trivial: va al agente |
| Imagen o PDF | `voucher` | `notify-team` sin `reason` («Voucher recibido») y el agente agradece |
| Otro texto | `texto` | Contesta el agente o deriva |

## Lo que tiene que seguir coincidiendo con el dashboard

El dashboard es `frankzk/kapso-sales-dashboard`, `lib/wa-button-replies.ts`.

- **`TRIVIALES` (router) == `ACK_WORDS` (dashboard)**, palabra por palabra.
  Al replicar: 38/38 idénticas. Una palabra que esté solo en el router deja a la
  clienta sin respuesta; una que esté solo en el dashboard le manda dos.
- **Botones:** los rótulos de la plantilla `guias_shalom_imagen` tienen que estar
  en `BOTONES` del router. El dashboard acepta más variantes (`yape`,
  `transferencia o deposito`, `link pago`…); si una plantilla nueva usa una de
  esas, hay que agregarla al router o el agente contesta encima del dashboard.
- Webhooks que el flujo necesita (ya existen): `whatsapp.message.received` del
  929 al dashboard (sin él nadie contesta los botones) y el de proyecto con
  `workflow.execution.handoff`.

## Política de cobro

El saldo se paga **antes** de recoger: al despachar llega la guía por WhatsApp
con el monto y los datos de pago; la clave de recojo queda bloqueada en el
dashboard hasta validar el pago completo. El bot de ventas y `send-payment` se
alinearon con esto el mismo día (antes prometían "el saldo lo pagas al recoger").

Olva no pasa por esta línea: en Aurela Olva es pago total anticipado.

## Pendientes conocidos

- El nombre verificado del 929 en Meta es **«GTEC KONDOTTY»**. Para una línea que
  pide pagos por Yape conviene cambiarlo a Aurela.
- El guard de ejecuciones caídas de `check-coverage` (`WATCHDOG_WORKFLOW_ID`)
  mira solo el sales bot. Una caída de este workflow no avisa por esa vía; sí
  la ve el watchdog de clientes esperando, que ya incluye el 929.
- En Telegram, un voucher de esta línea y un adelanto del bot de ventas salen con
  el mismo título («Voucher recibido»).
