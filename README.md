# AIRE+ · Versión final 3.0

La interfaz está en un único **index.html**, con HTML, CSS/Tailwind compilado, JavaScript y logo SVG incorporados. El backend completo está en **api/**. No necesita paquetes npm para funcionar en Vercel.

## Actualizar tu despliegue

1. Sustituye `index.html` y la carpeta `api/` por los de este paquete. Copia también `package.json` y `vercel.json` a la raíz del proyecto.
2. En Vercel usa **Framework Preset: Other**, Node.js **22**, sin Build Command y sin Output Directory personalizado.
3. Configura las variables de `.env.example` en **Settings → Environment Variables**. Sus valores son privados; no subas un `.env` con credenciales al repositorio.
4. Vuelve a desplegar. Abre el sitio, selecciona tu zona/canales y pulsa **Verificar canales**, **Probar alerta** o **Activar alertas**. El panel no pide una contraseña, un token ni una clave de acceso.

## Archivos del backend

| Archivo            | Función                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `api/air.js`       | Consulta exclusivamente Open-Meteo Air Quality, valida datos, mantiene una caché y comparte utilidades.             |
| `api/alerts.js`    | Envía Telegram, SMS y WhatsApp con `fetch`, usando variables de entorno; activa, consulta y desactiva preferencias. |
| `api/assistant.js` | Evalúa contaminantes y pronóstico actuales, y genera recomendaciones según el perfil elegido.                       |
| `api/cron.js`      | Comprueba suscripciones guardadas cuando la página está cerrada.                                                    |

Los cuatro archivos son funciones válidas de Vercel y se importan entre sí. No existe una dependencia de una carpeta `lib/` externa a `api/`.

## Fuente única y alcance de los datos

Todos los índices, concentraciones y pronósticos provienen de **Open-Meteo Air Quality**. Se consulta US AQI, PM2.5, PM10, O₃ y NO₂, junto con los subíndices de cada contaminante. Los cuatro contaminantes se muestran en **µg/m³**. El índice US AQI y las concentraciones son magnitudes diferentes.

El panel consulta al abrir, cada 15 minutos mientras está visible y al pulsar **Actualizar**. El backend usa una caché breve del mismo proveedor; el HTML puede consultar directamente Open-Meteo si no encuentra el backend. No se rellenan datos ausentes con números de ejemplo. Ante un fallo, se conserva solo un dato guardado que siga vigente, con su hora y un aviso de actualización fallida.

Open-Meteo publica **estimaciones y pronósticos del modelo CAMS**, no lecturas de sensores en cada alcaldía. Su resolución global es de unos 45 km; por ello, puntos cercanos pueden compartir valores. Las ubicaciones del mapa son puntos de consulta por alcaldía. La cartografía incorporada es contexto geográfico local, con su atribución conservada; no constituye otra fuente de calidad del aire.

La API gratuita de Open-Meteo está destinada a uso no comercial y tiene límites de uso. Esta versión está orientada al proyecto educativo AIRE+. Fuente y atribución: https://open-meteo.com/en/docs/air-quality-api

## Logo y temas

El isotipo SVG combina flujos de aire con un degradado Emerald/Cyan. El selector de **Modo Claro / Modo Oscuro** cambia tarjetas, textos, controles, gráfico, mapa y asistente. La preferencia se recuerda en este navegador y se aplica antes de mostrar la página para evitar destellos.

## Asistente IA: sistema experto funcional

El módulo y el chat usan el mismo motor de reglas interpretables, tanto en el HTML como en `api/assistant.js`. Se evalúan los datos vigentes de la zona seleccionada y se generan:

- Un resumen en lenguaje natural del índice y su hora de validez.
- Lecturas de PM2.5, PM10, O₃ y NO₂ con sus subíndices.
- El mayor subíndice **entre los contaminantes consultados**.
- Recomendaciones para población general, personas sensibles, deportistas o infancia/embarazo.
- Un resumen de las próximas seis horas según el pronóstico recibido.

Es un **sistema experto de reglas**, no un modelo generativo ni un diagnóstico médico. Esto se indica en la interfaz. No requiere una clave de IA ni envía las preguntas a un proveedor de lenguaje externo. El servidor vuelve a consultar/validar los datos del aire y no acepta supuestas concentraciones proporcionadas por el navegador. Si el backend no está disponible, el módulo calcula la misma evaluación sobre los datos ya descargados y lo etiqueta como análisis local.

## Telegram

Configura `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`. Utiliza un token vigente y privado. Inicia la conversación con tu bot enviando `/start`. El destinatario es el definido en Vercel; el visitante no puede introducir otro chat ni modificar el texto enviado.

Para probar Telegram no es obligatorio Redis. Sin Redis, los límites de envío son por instancia y las preferencias se guardan en una cookie firmada: las alertas se comprueban mientras el sitio está abierto. Usa Redis para un despliegue público con límites compartidos y avisos con la página cerrada.

## SMS y WhatsApp

Configura `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` y los remitentes/destinatarios correspondientes. Los números SMS usan E.164, por ejemplo `+52...`; WhatsApp añade el prefijo `whatsapp:`.

Se conservaron `+17372508034` y `whatsapp:+17372508034` en el ejemplo, como los números indicados anteriormente, pero **debes comprobar que pertenecen a tu cuenta y están habilitados para cada canal**. Un remitente SMS no queda habilitado para WhatsApp automáticamente.

En WhatsApp Sandbox, el receptor debe enviar `join <código>` al número que muestre tu consola Twilio. Fuera de la ventana de atención se requiere una plantilla aprobada. Puedes configurar `TWILIO_WHATSAPP_CONTENT_SID`, con una variable `{{1}}` que reciba el texto del aviso.

SMS/WhatsApp requieren `UPSTASH_REDIS_REST_URL` y `UPSTASH_REDIS_REST_TOKEN` para aplicar un límite persistente de mensajes. Si falta ese limitador, el servidor no realiza envíos de pago. El botón mostrará el motivo concreto. Twilio puede generar cargos; el hosting gratuito no convierte estos mensajes en gratuitos.

## Activación y límites

No hay inicio de sesión ni contraseña en el panel. El navegador llama directamente a `/api/alerts` y las credenciales del proveedor permanecen en Vercel. Se utiliza una cookie de sesión firmada y HttpOnly para que cada navegador gestione sus propias preferencias, sin exponer una clave al visitante.

Como los controles son públicos, cualquier visitante de tu sitio puede solicitar pruebas a los **destinos fijos** del despliegue dentro de los límites configurados. Esta versión está preparada para tus destinos de prueba, no para un servicio de suscripción pública con números arbitrarios.

- Pruebas: pausa mínima de 60 segundos por canal.
- Avisos: intervalo mínimo elegido por el usuario, aplicado por canal y destinatario fijo.
- Límite diario total: `MAX_MESSAGES_PER_DAY`, por defecto **6** intentos de envío para el conjunto de canales, hasta un máximo configurable de 100. Un intento fallido también consume cuota para evitar reintentos ilimitados.
- Con Redis, la reserva del intervalo y la cuota se realiza de forma atómica entre instancias. Sin Redis, Telegram usa un límite por instancia y no se habilitan canales de pago.
- No se aceptan mensajes libres, números de destino, chat_ids ni credenciales desde el navegador.

**Activar alertas** guarda tus preferencias y comprueba el umbral actual. Si no se supera, no manda un mensaje. **Probar alerta** solicita un mensaje marcado como prueba e informa el resultado por canal. «Aceptado por Twilio» significa que recibió la solicitud; consulta su registro para confirmar la entrega final al teléfono.

Las preferencias con Redis se conservan hasta 30 días y se renuevan al activar de nuevo. Si cambias los tokens, utiliza un `SESSION_SECRET` estable para conservar las cookies entre rotaciones.

## Comprobaciones con el sitio cerrado

Con Redis se guardan las suscripciones y el programador puede revisarlas sin una pestaña abierta. `vercel.json` incluye una comprobación diaria a las **15:00 UTC** (aproximadamente las 09:00 de CDMX). Configura `CRON_SECRET` con al menos 32 caracteres para que Vercel autorice esa tarea. Esta credencial es exclusiva del programador; el panel nunca la solicita ni la envía.

El cron del plan Hobby no ofrece comprobaciones frecuentes en tiempo real. Para una cadencia mayor, usa un programador o plan compatible que llame `GET /api/cron` con la credencial del programador. El intervalo elegido en el panel limita las repeticiones, no acelera el cron.

## Verificación y ejecución local

Con Node.js 22:

```bash
npm test
npm run dev
# O, con variables locales privadas:
node --env-file=.env scripts/dev.mjs
```

Las pruebas usan respuestas controladas para los proveedores de mensajes y no envían SMS/WhatsApp ni Telegram reales. La conexión Open-Meteo y la interfaz se verifican por separado con datos de la API pública. Los envíos reales deben comprobarse en tu despliegue después de introducir tus variables privadas.

Los reportes ciudadanos se conservan en el navegador y pueden descargarse. El calendario vehicular es una consulta ordinaria; no detecta disposiciones extraordinarias en vivo.
