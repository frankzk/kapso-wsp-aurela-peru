# Paso del bot de Shopify a WooCommerce (aurela.pe, 27-10-2026)

Shopify cierra la tienda de Aurela el 28-10-2026 a las 00:00 UTC (martes 27 a las 19:00 de Lima). Ese día aurela.pe
pasa a la tienda WooCommerce. Este documento dice qué cambia en el bot y cómo se pasa.

## Qué cambia

| Función | Cambio |
|---|---|
| `shopify-product-lookup` | **Nada.** Lee `https://aurela.pe/products.json` y `/products/<handle>.js`, y la tienda nueva responde esas direcciones con el mismo formato y los mismos IDs de Shopify (plugin `cod-core`). La búsqueda en la API de administración de Shopify es solo un respaldo: si falla, se ignora |
| `product-media-lookup` | **Nada** para las fotos (mismo catálogo público). Los videos (metacampo `custom.video` de la API de administración de Shopify) dejan de salir |
| `create-shopify-order` | Con `STORE_BACKEND=woocommerce` crea el pedido en WooCommerce por su API REST (ver abajo). Sin esa variable sigue en Shopify |
| `campaign-report` | Con `STORE_BACKEND=woocommerce` lee los pedidos de WooCommerce por la API REST (los del bot llevan `source=whatsapp-bot` y `ctwa_ad_id` como metadatos, igual que en Shopify) y, si sigue `SHOPIFY_ADMIN_ACCESS_TOKEN`, suma los de Shopify de antes de la apertura; si Shopify ya no responde, el reporte sale igual con un aviso. Sin esa variable sigue en Shopify |
| `quote-order`, `check-coverage`, `notify-team`, `send-buttons` | Nada |

## El pedido en WooCommerce

Sigue las reglas de Kapta (el sistema de operaciones lee los pedidos de la tienda):

- Método `cod` («Pago contra entrega»), estado `cod-pending` («Por confirmar»).
- `billing`: nombre, celular `+51…`, departamento con el **código de WooCommerce** (`LMA` Lima Metropolitana, `CAL`
  Callao, `LIM` resto de Lima, `ARE` Arequipa…; sale de `coverage.normalized` o de los datos del cliente), distrito
  en `city`, dirección y referencia. Sin dirección de envío.
- Líneas con el producto y la variación de WooCommerce (los ID salen del catálogo público: `woo_id`), con `subtotal`
  y `total`: las promos 3x2 y 5x3 se reparten entre las líneas y quedan como **cupón** `aurela-whatsapp-promo`
  (cod-core lo arma con el metadato `cod_core_cupon`).
- Envío como línea de envío: gratis con más de S/ 40, si no S/ 10 (igual que en Shopify).
- Metadatos: `kapta_channel` (`whatsapp_bot`, a confirmar con Kapta), `source=whatsapp-bot`, `kapso_conversation_id`,
  `kapso_phone_number_id`, `kapso_tags`, `ctwa_*` y, si llegó por un anuncio, `utm_id` (el anuncio), `utm_source` y
  `utm_medium`.
- La fecha u hora de entrega pedida va en la nota del cliente; el resumen interno del bot, como nota privada.
- Respuesta igual que antes: `order.name` = `#AUR9…` (el número del pedido), `order.id` el de WooCommerce.

## Configuración de `create-shopify-order` (en Kapso, nunca en git)

| Variable | Valor |
|---|---|
| `WOO_STORE_URL` | Hasta la apertura, para probar: `https://64-176-29-13.sslip.io`. Desde la apertura: `https://aurela.pe` |
| `WOO_CONSUMER_KEY` / `WOO_CONSUMER_SECRET` | La clave de la API del usuario `kapso` (WooCommerce → Ajustes → Avanzado → REST API, Lectura/Escritura) |
| `STORE_BACKEND` | `shopify` hasta la apertura; `woocommerce` desde la apertura |
| `KAPTA_CHANNEL` | Opcional: el valor que diga Kapta (por defecto `whatsapp_bot`) |
| `WOO_COUPON_CODE` | Opcional (por defecto `aurela-whatsapp-promo`) |

## Configuración de `campaign-report` (en Kapso, nunca en git)

Los mismos `WOO_STORE_URL`, `WOO_CONSUMER_KEY`, `WOO_CONSUMER_SECRET` y `STORE_BACKEND` de arriba, cargados también en
los secretos de esta función (cada función tiene los suyos). Con `STORE_BACKEND=woocommerce` desde la apertura. Dejar
`SHOPIFY_ADMIN_ACCESS_TOKEN` mientras Shopify responda: así los rangos que empiezan antes de la apertura cuentan los
dos lados. Los días del rango van en hora de Lima (la de la tienda). No cuenta los pedidos fallidos ni los
borradores del checkout.

## Pasos

1. Desplegar las funciones de esta rama en Kapso (como siempre, con la CLI de Kapso) y cargar las variables de
   arriba con `STORE_BACKEND=shopify`: el bot sigue igual.
2. **Prueba sin tocar el bot real:** invocar la función con `storeBackend: "woocommerce"` en el input (primero
   `dryRun: true`, después un pedido real de prueba) contra `https://64-176-29-13.sslip.io`. Revisar el pedido en
   WooCommerce, en su cuadro «Datos para Kapta». Los pedidos de prueba se borran antes de conectar Kapta.
3. **Día de la apertura**, cuando aurela.pe ya apunta a WooCommerce: `WOO_STORE_URL=https://aurela.pe` y
   `STORE_BACKEND=woocommerce` en `create-shopify-order` y en `campaign-report`. Probar `create-shopify-order` solo con
   `dryRun` (pestaña Test): con Kapta ya conectado, un pedido real de prueba le llegaría.
4. Volver atrás (si se vuelve a Shopify): `STORE_BACKEND=shopify`.

## Pruebas

`node functions/create-shopify-order/test/woocommerce.test.cjs` y `node functions/campaign-report/test/woocommerce.test.cjs`
(fetch mockeado). Probado también contra una tienda
WooCommerce local con el catálogo de Aurela (24-10-2026): búsqueda por enlace, nombre, categoría y handle con "™",
fotos, y pedidos con 3x2 como cupón, envío gratis, `LMA` y `ARE`. El reporte, el mismo día contra esa tienda: 2 pedidos del
bot (S/ 288 y S/ 59) en totales y en la conversión.
