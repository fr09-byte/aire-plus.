# AIRE+ · Ciudad de México · 3.1

Panel educativo de calidad del aire con mapa de las 16 alcaldías, pronóstico, recomendaciones por perfil, calendario ordinario de Hoy No Circula y alertas personales por Telegram, SMS, WhatsApp o correo.

Esta versión conecta el registro, la confirmación de contactos y el envío programado mediante un único servicio y una única conexión Redis. Cada visitante puede registrar su propio contacto; ya no se envían los avisos al destinatario fijo del propietario del sitio.

Guía paso a paso de Telegram, diagnóstico de Twilio y correo: [Configurar los canales](docs/CONFIGURAR_CANALES.md).

## Desplegar en Vercel

1. Integra los cambios del repositorio y conserva todas las carpetas, no solo index.html.
2. Selecciona Framework Preset **Other**, Node.js **22.x**, sin Build Command ni Output Directory personalizado.
3. Agrega las variables de [.env.example](.env.example) en Settings → Environment Variables. Son valores privados del servidor.
4. Vuelve a desplegar después de cambiar variables.
5. Abre Mis alertas, autoriza los mensajes, confirma un contacto y utiliza Probar alerta. Revisa el historial para distinguir la aceptación del proveedor de la entrega.

### Configuración común obligatoria

| Variable | Uso |
| --- | --- |
| UPSTASH_REDIS_REST_URL | URL HTTPS de la API REST de Redis. No uses aquí una dirección redis://. |
| UPSTASH_REDIS_REST_TOKEN | Token REST del mismo Redis. |
| SESSION_SECRET | Valor aleatorio estable de al menos 32 caracteres para firmar las sesiones. |
| CRON_SECRET | Otro valor aleatorio de al menos 32 caracteres para autorizar el programador. |
| AIRE_NAMESPACE | Separación de datos entre despliegues; por defecto cdmx. |

Genera SESSION_SECRET y CRON_SECRET por separado, ejecutando dos veces en tu consola:

    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

El proyecto utiliza exclusivamente Redis por REST. No necesita REDIS_URL, un cliente Redis por TCP ni conexiones persistentes.

### Variables de los canales

Configura solo los canales que vayas a ofrecer:

| Canal | Variables |
| --- | --- |
| Telegram | TELEGRAM_BOT_TOKEN |
| SMS | TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM |
| WhatsApp | TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM |
| Correo | SENDGRID_API_KEY, EMAIL_FROM |

Los destinatarios se registran desde la página. TELEGRAM_CHAT_ID, TWILIO_SMS_TO y TWILIO_WHATSAPP_TO dejan de utilizarse.

**Telegram:** la ayuda «¿Cómo consigo mi ID de Telegram?» explica cómo consultar el ID con un bot externo y muestra el enlace al bot de AIRE+, obtenido automáticamente mediante getMe. Cada persona debe iniciar la conversación con el bot enviando /start e introducir su chat ID numérico. El nombre de usuario no reemplaza ese ID. El código recibido confirma que puede leer ese chat.

**SMS:** usa números E.164, por ejemplo +525512345678. Las cuentas de prueba de Twilio pueden requerir verificar antes los destinatarios y habilitar el país. Los mensajes se resumen y se limitan a 160 septetos GSM-7 para evitar dividirlos por longitud.

**WhatsApp:** el remitente debe llevar el prefijo whatsapp:. En Sandbox, cada receptor debe unirse con el código join que muestre la consola de Twilio. Fuera de la ventana de atención hace falta una plantilla aprobada.

- TWILIO_WHATSAPP_CONTENT_SID: plantilla de aviso, cuya variable 1 recibe el texto del aviso.
- TWILIO_WHATSAPP_VERIFY_CONTENT_SID: plantilla opcional de confirmación, cuya variable 1 recibe solo los seis dígitos del código.
- Si no hay plantilla de confirmación, se utiliza la de aviso o un mensaje de texto, según las variables disponibles. La plantilla configurada debe admitir ese uso; revisa las normas y la aprobación en tu cuenta.

**Correo:** EMAIL_FROM debe ser un remitente verificado en SendGrid. Las credenciales de Twilio Messaging no activan SendGrid automáticamente. La respuesta 202 significa que SendGrid aceptó el mensaje; la entrega al buzón no se confirma en esta versión.

## Recorrido del visitante

1. Selecciona sus canales y escribe sus contactos.
2. Autoriza recibir códigos y avisos.
3. Pulsa Enviar código y confirma los seis dígitos de cada canal.
4. Selecciona alcaldía, umbral US AQI e intervalo mínimo entre avisos.
5. Elige índice, contaminantes, recomendaciones y/o Hoy No Circula.
6. Activa los avisos o solicita una prueba.

Los códigos caducan en diez minutos y se invalidan tras cinco intentos incorrectos o al usarse. Se guardan firmas de los códigos, no los códigos en texto. La prueba queda ligada al contacto y al navegador que la solicitó. Cambiar un contacto exige confirmarlo otra vez.

El mismo contacto solo puede tener una suscripción activa por canal. Volver a guardar desde el mismo navegador actualiza su registro; no añade filas duplicadas. Para cambiar de navegador, desactiva primero la suscripción en el anterior.

La configuración se conserva hasta 30 días desde la última activación. Las confirmaciones duran hasta 30 días desde la verificación. El historial muestra los últimos diez intentos y mantiene como máximo veinte referencias por navegador, con caducidad de 30 días. Los campos de contacto no se guardan en localStorage.

## Programación con la página cerrada

El cron de vercel.json comprueba diariamente a las 15:00 UTC, aproximadamente a las 09:00 de CDMX. Es compatible con Hobby, cuyo cron no admite una expresión de mayor frecuencia. Seleccionar «1 hora» en el formulario limita las repeticiones; no modifica el programador.

Para revisar **aproximadamente cada 15 minutos** con el sitio cerrado, se incluye [.github/workflows/alerts.yml](.github/workflows/alerts.yml):

1. En GitHub abre Settings → Secrets and variables → Actions.
2. En Variables agrega AIRE_BASE_URL con la URL HTTPS de producción, por ejemplo https://aire-plus.vercel.app.
3. En Secrets agrega AIRE_CRON_SECRET con el mismo valor de CRON_SECRET de Vercel.
4. En Variables agrega AIRE_SCHEDULER_ENABLED con el valor true.
5. En Vercel configura ALERT_CHECK_MINUTES=15 y vuelve a desplegar.
6. Desde Actions ejecuta manualmente «Comprobar alertas AIRE+» una vez y verifica su resultado.

El flujo programado debe estar en la rama predeterminada para ejecutarse. GitHub puede retrasar tareas o suspenderlas en repositorios sin actividad; no es un sistema de emergencias ni una garantía de tiempo real. El panel muestra la última ejecución registrada para comprobar que el programador está funcionando.

Puedes dejar el cron diario como respaldo: el bloqueo del programador y los límites por contacto evitan envíos repetidos. Si hay muchas suscripciones, cada ejecución tiene un presupuesto de tiempo y continúa en las siguientes utilizando un cursor.

## Cuotas y protección del envío

| Variable | Predeterminado | Qué limita |
| --- | --- | --- |
| MAX_MESSAGES_PER_DAY | 6 | Intentos de avisos automáticos del conjunto del servicio. |
| MAX_TEST_MESSAGES_PER_DAY | 3 | Intentos de pruebas, en una cuota independiente. |
| MAX_VERIFICATIONS_PER_DAY | 12 | Intentos de envío de códigos, en otra cuota. |
| MAX_SUBSCRIPTIONS | 64 | Configuraciones activas. |

Las cuotas son compartidas entre instancias y se reservan de forma atómica en Redis. Los intentos fallidos cuentan para evitar reintentos ilimitados. Cada contacto puede solicitar hasta tres códigos al día; hay una pausa de 60 segundos y límites por navegador y dirección de origen.

Los límites son de intentos, no de pesos. Los proveedores pueden generar cargos por códigos, pruebas y avisos. Ajusta las cuotas al presupuesto del proyecto.

El sitio utiliza una cookie firmada, HttpOnly y SameSite para que cada navegador gestione sus propios registros. No pide claves privadas al visitante. Sin Redis o sin SESSION_SECRET estable, el servidor bloquea los envíos y explica qué falta. Los errores de configuración no se convierten en mensajes de éxito.

## Comprobar conexión

El panel distingue variables cargadas, credenciales comprobadas y conexión rechazada. El botón Comprobar conexión valida Telegram con getMe y Twilio consultando la cuenta. No envía mensajes ni devuelve datos privados de esa cuenta. Los resultados se almacenan brevemente en memoria y cambian al actualizar las credenciales. Para correo se utiliza el código de confirmación, porque una clave limitada a Mail Send no necesita permisos de lectura de la cuenta.

## Historial y entrega

El historial conserva canal, contacto enmascarado, finalidad, identificador del proveedor, fechas y estado del intento. No guarda el texto del código.

- Telegram informa de la aceptación del mensaje, no de su lectura.
- SMS y WhatsApp comienzan como aceptados o en cola. Consultar entrega consulta el recurso del mensaje en Twilio y actualiza entregado, leído o fallido cuando esté disponible.
- SendGrid informa de aceptación; esta versión no incluye su Event Webhook.

La consulta de entrega solo permite consultar mensajes del navegador actual. El programador devuelve contadores, sin listas de contactos.

## Estructura

| Archivo o carpeta | Responsabilidad |
| --- | --- |
| index.html | Estructura y contenido de la interfaz. |
| assets/styles.css | Estilos y adaptación de pantalla. |
| assets/app.js | Controles del panel, contactos e historial. |
| shared/air-core.js | Motor único de datos, categorías, calendario y recomendaciones, utilizado por navegador y servidor. |
| api/ | Entradas HTTP para aire, asistente, alertas, registro compatible y programador. |
| server/ | Sesiones, validación HTTP, Redis REST, proveedores y suscripciones. |
| tests/ | Pruebas de datos, HTML completo, endpoints y recorrido hasta el envío programado. |

La ruta /api/subscribe comparte exactamente el mismo servicio que /api/alerts; no mantiene una lista de contactos separada. Los registros antiguos sin contactos confirmados deben actualizarse desde la página antes de enviar avisos personales.

## Desarrollo y pruebas

    npm ci
    npm test
    npm run dev

Con variables locales privadas:

    node --env-file=.env scripts/dev.mjs

El servidor local sirve los archivos compartidos y todas las rutas, incluida /api/subscribe. No expone .env ni los módulos privados del servidor.

Las pruebas ejecutan los scripts Lua del servicio en un emulador Redis y usan respuestas controladas de Open-Meteo, Telegram, Twilio y SendGrid. No envían mensajes reales ni usan credenciales personales. Las pruebas de CI también se ejecutan en Node.js 22.

## Datos ambientales y alcance

Open-Meteo Air Quality proporciona estimaciones y pronósticos de CAMS Global. Los puntos del mapa son ubicaciones de consulta, no sensores físicos de cada alcaldía. Por la resolución aproximada de 45 km, varias zonas pueden compartir valores.

Se utiliza US AQI y concentraciones de PM2.5, PM10, O3 y NO2 en µg/m³. US AQI no equivale al Índice Aire y Salud oficial de CDMX. No se sustituyen datos faltantes por números de ejemplo; los datos conservados muestran su fecha y se descartan al superar su vigencia.

El asistente es un sistema de reglas interpretables con recomendaciones por perfil, no un modelo generativo. Hoy No Circula consulta el calendario ordinario y no detecta contingencias en vivo. Los reportes ciudadanos se guardan en el navegador y se pueden descargar; no se envían a autoridades.

## Documentación de los proveedores

- [Open-Meteo Air Quality](https://open-meteo.com/en/docs/air-quality-api)
- [Límites de cron de Vercel](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [Tareas programadas de GitHub Actions](https://docs.github.com/en/actions/reference/workflow-syntax-for-github-actions#onschedule)
- [Estados de entrega en Twilio](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status)
- [SendGrid Mail Send](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send)
