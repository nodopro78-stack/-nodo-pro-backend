// pedidos.js - Sistema de Pedidos, Packs y Aceptación
// Contrato de Intermediación Tecnológica - Ley 2466, Artículos 4 y 34
// NO modifica code base index.js - únicamente importado

import { createClient } from '@supabase/supabase-js';
import { aplicarCreditoCortes } from './billetera.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const BUCKET_EVIDENCIAS = 'evidencias-legales';

const PRECIOS_PACKS = {
  '8h': {
    suelto: 130000,
    packs: { 3: 390000, 5: 650000, 13: 1690000 }
  },
  '12h': {
    suelto: 170000,
    packs: { 3: 510000, 5: 850000, 13: 2210000 }
  }
};

const PAGOS_AUXILIAR = {
  '8h': 100000,
  '12h': 130000
};

// Crear nuevo pack
export async function crearPack(clienteId, shiftType, numBloques) {
  try {
    const precioTotal = PRECIOS_PACKS[shiftType].packs[numBloques];
    if (!precioTotal) {
      return { error: 'Pack inválido', code: 400 };
    }

    const { data: cliente } = await supabase
      .from('users')
      .select('balance')
      .eq('id', clienteId)
      .single();

    if (!cliente || cliente.balance < precioTotal) {
      return { error: 'Saldo insuficiente', code: 402 };
    }

    // Descontar saldo
    await supabase
      .from('users')
      .update({ balance: cliente.balance - precioTotal })
      .eq('id', clienteId);

    const { data: pack, error } = await supabase
      .from('packs')
      .insert([{
        cliente_id: clienteId,
        shift_type: shiftType,
        num_bloques: numBloques,
        price_total: precioTotal,
        balance_used: precioTotal,
        balance_remaining: cliente.balance - precioTotal,
        status: 'activo'
      }])
      .select()
      .single();

    if (error) return { error: error.message, code: 500 };

    if ([5, 13].includes(numBloques)) {
      await aplicarCreditoCortes(clienteId, pack.id);
    }

    return { pack, code: 201 };
  } catch (error) {
    console.error('Error creando pack:', error);
    return { error: error.message, code: 500 };
  }
}

// Publicar pedido dentro de un pack
export async function publicarPedido(packId, clienteId, descripcion, latitud, longitud, direccion) {
  try {
    const { data: pack } = await supabase
      .from('packs')
      .select('*')
      .eq('id', packId)
      .eq('cliente_id', clienteId)
      .single();

    if (!pack || pack.bloques_completados >= pack.num_bloques) {
      return { error: 'Pack inválido o completado', code: 400 };
    }

    const { data: pedido, error } = await supabase
      .from('pedidos')
      .insert([{
        pack_id: packId,
        cliente_id: clienteId,
        status: 'publicado',
        shift_type: pack.shift_type,
        descripcion,
        latitud,
        longitud,
        direccion
      }])
      .select()
      .single();

    if (error) return { error: error.message, code: 500 };

    // Notificar auxiliares disponibles en rango
    await notificarAuxiliaresEnRango(latitud, longitud, pack.shift_type, pedido.id);

    return { pedido, code: 201 };
  } catch (error) {
    console.error('Error publicando pedido:', error);
    return { error: error.message, code: 500 };
  }
}

// Obtener pedidos disponibles para auxiliar (< 10 km, sin bloques activos)
export async function obtenerPedidosDisponibles(auxiliarId, latitud, longitud) {
  try {
    // Verificar si auxiliar tiene bloques activos
    const { data: bloqueos } = await supabase
      .from('bloques_auxiliar_activos')
      .select('*')
      .eq('auxiliar_id', auxiliarId)
      .gt('fin_bloqueado_at', new Date().toISOString());

    if (bloqueos && bloqueos.length > 0) {
      return { pedidos: [], bloqueado_hasta: bloqueos[0].fin_bloqueado_at, code: 200 };
    }

    // Traer pedidos publicados
    const { data: pedidos, error } = await supabase
      .from('pedidos')
      .select('*')
      .eq('status', 'publicado')
      .is('auxiliar_id', null);

    if (error) return { error: error.message, code: 500 };

    // Filtrar por distancia < 10km
    const filtrados = (pedidos || []).filter(p => {
      const distancia = calcularDistancia(latitud, longitud, p.latitud, p.longitud);
      return distancia < 10;
    }).map(p => ({
      ...p,
      distancia_calculada: calcularDistancia(latitud, longitud, p.latitud, p.longitud)
    }));

    return { pedidos: filtrados, code: 200 };
  } catch (error) {
    console.error('Error obteniendo pedidos:', error);
    return { error: error.message, code: 500 };
  }
}

// Aceptar pedido (Contrato Auxiliares - Cláusula 5)
export async function aceptarPedido(pedidoId, auxiliarId) {
  try {
    const { data: pedido } = await supabase
      .from('pedidos')
      .select('*')
      .eq('id', pedidoId)
      .single();

    if (!pedido || pedido.auxiliar_id || pedido.status !== 'publicado') {
      return { error: 'Pedido ya aceptado o inválido', code: 400 };
    }

    // Verificar que auxiliar no tenga bloqueos
    const { data: bloqueos } = await supabase
      .from('bloques_auxiliar_activos')
      .select('*')
      .eq('auxiliar_id', auxiliarId)
      .gt('fin_bloqueado_at', new Date().toISOString());

    if (bloqueos && bloqueos.length > 0) {
      return { error: 'Auxiliar tiene bloque activo', code: 409 };
    }

    // Aceptar pedido
    const ahora = new Date();
    const { data: actualizado, error } = await supabase
      .from('pedidos')
      .update({
        auxiliar_id: auxiliarId,
        status: 'aceptado',
        acceptado_at: ahora.toISOString()
      })
      .eq('id', pedidoId)
      .select()
      .single();

    if (error) return { error: error.message, code: 500 };

    // Crear bloqueo según shift_type
    const finBloqueadoAt = new Date(ahora);
    if (pedido.shift_type === '8h') {
      finBloqueadoAt.setHours(finBloqueadoAt.getHours() + 4);
      // Además, bloquear por el resto del día
      const finDelDia = new Date(ahora);
      finDelDia.setHours(23, 59, 59, 999);
      await supabase.from('bloques_auxiliar_activos').insert([{
        auxiliar_id: auxiliarId,
        shift_type: '8h',
        inicio_at: ahora.toISOString(),
        fin_bloqueado_at: finDelDia.toISOString(),
        pack_id: pedido.pack_id,
        estado: 'bloqueado'
      }]);
    } else if (pedido.shift_type === '12h') {
      finBloqueadoAt.setHours(finBloqueadoAt.getHours() + 7);
      await supabase.from('bloques_auxiliar_activos').insert([{
        auxiliar_id: auxiliarId,
        shift_type: '12h',
        inicio_at: ahora.toISOString(),
        fin_bloqueado_at: finBloqueadoAt.toISOString(),
        pack_id: pedido.pack_id,
        estado: 'bloqueado'
      }]);
    }

    // Notificar cliente
    await crearNotificacion(pedido.cliente_id, 'auxiliar_aceptado', 'Auxiliar asignado', {
      auxiliar_id: auxiliarId,
      pedido_id: pedidoId
    });

    return { pedido: actualizado, code: 200 };
  } catch (error) {
    console.error('Error aceptando pedido:', error);
    return { error: error.message, code: 500 };
  }
}

// Marcar llegada (Contrato Auxiliares - Cláusula 4)
export async function marcarLlegada(pedidoId, auxiliarId, fotoBase64, latitud, longitud) {
  try {
    const { data: pedido } = await supabase
      .from('pedidos')
      .select('*')
      .eq('id', pedidoId)
      .eq('auxiliar_id', auxiliarId)
      .single();

    if (!pedido || pedido.status !== 'aceptado') {
      return { error: 'Pedido no está aceptado', code: 400 };
    }

    // Validar geofence (3 metros)
    const distancia = calcularDistancia(latitud, longitud, pedido.latitud, pedido.longitud);
    if (distancia > 0.003) { // 3 metros ~0.003 km
      return { error: `Estás a ${(distancia * 1000).toFixed(0)} metros. Necesitas estar a <3 metros`, code: 400 };
    }

    const fotoUrl = await uploadFotoAStorage(fotoBase64, `pedido-${pedidoId}-llegada`);
    if (!fotoUrl) {
      return { error: 'No se pudo guardar la foto de llegada', code: 500 };
    }

    const iniciado = new Date();
    const { data: actualizado, error } = await supabase
      .from('pedidos')
      .update({
        status: 'iniciado',
        iniciado_at: iniciado.toISOString(),
        inicio_photo_url: fotoUrl
      })
      .eq('id', pedidoId)
      .select()
      .single();

    if (error) return { error: error.message, code: 500 };

    await crearNotificacion(pedido.cliente_id, 'llegada', 'Auxiliar llegó', { pedido_id: pedidoId });

    return { pedido: actualizado, code: 200 };
  } catch (error) {
    console.error('Error marcando llegada:', error);
    return { error: error.message, code: 500 };
  }
}

// Marcar fin (Contrato Auxiliares - Cláusula 4)
export async function marcarFin(pedidoId, auxiliarId, fotoBase64) {
  try {
    const { data: pedido } = await supabase
      .from('pedidos')
      .select('*')
      .eq('id', pedidoId)
      .eq('auxiliar_id', auxiliarId)
      .single();

    if (!pedido || pedido.status !== 'iniciado') {
      return { error: 'Pedido no está iniciado', code: 400 };
    }

    const ahora = new Date();
    const minutos = Math.floor((ahora - new Date(pedido.iniciado_at)) / 60000);

    // Calcular atraso y descuentos
    let descuento = 0;
    if (minutos > 30) {
      // >30min: pierde pago del bloque (reemplazo sin costo)
      descuento = PAGOS_AUXILIAR[pedido.shift_type];
    } else if (minutos > 0) {
      // 1-30min: descuento proporcional
      const duracionEsperada = pedido.shift_type === '8h' ? 480 : 720; // minutos
      descuento = (minutos / duracionEsperada) * PAGOS_AUXILIAR[pedido.shift_type];
    }

    const pagado = PAGOS_AUXILIAR[pedido.shift_type] - Math.ceil(descuento);

    const fotoUrl = await uploadFotoAStorage(fotoBase64, `pedido-${pedidoId}-fin`);
    if (!fotoUrl) {
      return { error: 'No se pudo guardar la foto de fin de servicio', code: 500 };
    }

    const { data: actualizado, error } = await supabase
      .from('pedidos')
      .update({
        status: 'completado',
        terminado_at: ahora.toISOString(),
        fin_photo_url: fotoUrl,
        minutos_atraso: minutos,
        descuento_aplicado: descuento,
        pagado_a_auxiliar: pagado
      })
      .eq('id', pedidoId)
      .select()
      .single();

    if (error) return { error: error.message, code: 500 };

    // Incrementar bloques completados del pack
    const { data: pack } = await supabase
      .from('packs')
      .select('*')
      .eq('id', pedido.pack_id)
      .single();

    const nuevosBloques = pack.bloques_completados + 1;
    await supabase
      .from('packs')
      .update({ bloques_completados: nuevosBloques })
      .eq('id', pedido.pack_id);

    // Si pack completado, liberar pago
    if (nuevosBloques === pack.num_bloques) {
      await liberarPagoPack(pedido.pack_id, auxiliarId, pack);
    }

    // Acreditar saldo a auxiliar
    await acreditarSaldoAuxiliar(auxiliarId, pagado);

    await crearNotificacion(pedido.cliente_id, 'pago_liberado', 'Servicio completado', { pedido_id: pedidoId });

    return { pedido: actualizado, code: 200 };
  } catch (error) {
    console.error('Error marcando fin:', error);
    return { error: error.message, code: 500 };
  }
}

// HELPER FUNCTIONS

function calcularDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function notificarAuxiliaresEnRango(latitud, longitud, shiftType, pedidoId) {
  try {
    const { data: auxiliares } = await supabase
      .from('users')
      .select('id, pila_status')
      .eq('role', 'auxiliar')
      .eq('status', 'activo')
      .eq('pila_status', 'vigente');

    for (const aux of auxiliares || []) {
      // En producción: verificar distancia real desde GPS del auxiliar
      await crearNotificacion(aux.id, 'pedido_nuevo', 'Nuevo pedido disponible', {
        pedido_id: pedidoId,
        shift_type: shiftType
      });
    }
  } catch (error) {
    console.error('Error notificando auxiliares:', error);
  }
}

async function liberarPagoPack(packId, auxiliarId, pack) {
  try {
    // Calcular total pagado al auxiliar en todo el pack
    const { data: pedidos } = await supabase
      .from('pedidos')
      .select('pagado_a_auxiliar')
      .eq('pack_id', packId)
      .eq('auxiliar_id', auxiliarId);

    const totalPagado = (pedidos || []).reduce((sum, p) => sum + (p.pagado_a_auxiliar || 0), 0);

    // Actualizar pack como completado
    await supabase
      .from('packs')
      .update({ status: 'completado' })
      .eq('id', packId);

    // El pago ya se acreditó en marcarFin, aquí solo confirmamos estado
    console.log(`Pack ${packId} liberado. Total pagado: ${totalPagado}`);
  } catch (error) {
    console.error('Error liberando pago del pack:', error);
  }
}

async function acreditarSaldoAuxiliar(auxiliarId, monto) {
  try {
    const { data: billetera } = await supabase
      .from('billetera_auxiliares')
      .select('saldo_ganado')
      .eq('auxiliar_id', auxiliarId)
      .single();

    if (!billetera) {
      await supabase.from('billetera_auxiliares').insert([{
        auxiliar_id: auxiliarId,
        saldo_ganado: monto
      }]);
    } else {
      await supabase
        .from('billetera_auxiliares')
        .update({ saldo_ganado: billetera.saldo_ganado + monto })
        .eq('auxiliar_id', auxiliarId);
    }
  } catch (error) {
    console.error('Error acreditando saldo:', error);
  }
}

async function crearNotificacion(userId, tipo, titulo, data) {
  try {
    await supabase.from('notificaciones').insert([{
      user_id: userId,
      tipo,
      titulo,
      data
    }]);
  } catch (error) {
    console.error('Error creando notificación:', error);
  }
}

async function uploadFotoAStorage(base64, key) {
  try {
    const buffer = Buffer.from(base64, 'base64');
    const fileName = `${key}-${Date.now()}.jpg`;
    const { data, error } = await supabase.storage
      .from(BUCKET_EVIDENCIAS)
      .upload(fileName, buffer, {
        contentType: 'image/jpeg',
        upsert: true
      });

    if (error) {
      console.error('Error subiendo foto al bucket:', error);
      return null;
    }

    return data?.path || fileName;
  } catch (error) {
    console.error('Error en uploadFotoAStorage:', error);
    return null;
  }
}

export async function obtenerUrlFotoPedido(pedidoId, userId) {
  const { data: pedido, error: pedidoError } = await supabase
    .from('pedidos')
    .select('cliente_id, inicio_photo_url, fin_photo_url')
    .eq('id', pedidoId)
    .single();

  if (pedidoError || !pedido) {
    return { error: 'Pedido no encontrado' };
  }

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .single();

  if (userError || !user) {
    return { error: 'Usuario no encontrado' };
  }

  if (user.role !== 'admin' && userId !== pedido.cliente_id) {
    return { error: 'Acceso denegado' };
  }

  const inicioUrl = pedido.inicio_photo_url
    ? await generarUrlFirmada(pedido.inicio_photo_url)
    : null;
  const finUrl = pedido.fin_photo_url
    ? await generarUrlFirmada(pedido.fin_photo_url)
    : null;

  return { inicioUrl, finUrl };
}

async function generarUrlFirmada(path) {
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET_EVIDENCIAS)
      .createSignedUrl(path, 60 * 60);

    if (error) {
      console.error('Error creando URL firmada:', error);
      return null;
    }

    return data?.signedUrl || null;
  } catch (error) {
    console.error('Error en generarUrlFirmada:', error);
    return null;
  }
}

export default { crearPack, publicarPedido, obtenerPedidosDisponibles, aceptarPedido, marcarLlegada, marcarFin, obtenerUrlFotoPedido };
