import { createClient } from 'redis';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Método ${req.method} no permitido` });
  }

  const { canal, contacto, alcaldia } = req.body;

  if (!canal || !contacto) {
    return res.status(400).json({ error: 'Faltan parámetros obligatorios: canal o contacto' });
  }

  let client;

  try {
    client = createClient({ url: process.env.REDIS_URL });
    await client.connect();

    const key = `subscribers:${canal}`;
    const payload = JSON.stringify({
      contacto,
      alcaldia: alcaldia || 'Todas',
      registradoEn: new Date().toISOString()
    });

    await client.rPush(key, payload);

    return res.status(200).json({ 
      success: true, 
      message: 'Suscripción almacenada correctamente en Redis' 
    });

  } catch (error) {
    console.error('Error de Redis:', error);
    return res.status(500).json({ 
      error: 'Error interno en el servidor al procesar el registro', 
      details: error.message 
    });
  } finally {
    if (client && client.isOpen) {
      await client.disconnect();
    }
  }
}
