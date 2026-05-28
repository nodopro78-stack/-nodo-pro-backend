// billetera.js - Sistema de Recargas, Saldos y Retiros
// Contrato de Intermediación Tecnológica - Cláusula 4 (Packs y Precios)
// Contrato Auxiliares - Cláusula 3 (Pagos)

import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER || 'nodo-pro-notificaciones@gmail.com',
    pass: process.env.GMAIL_PASS
  }
});

const MINIMO_RECARGA_CLIENTE = 130000; // Contrato Clientes - Cláusula 4

// Solicitar recarga de cliente
export async function solicitarRecargaSaldo(clienteId, montoSolicitado, comprobanteBase64) {
  try {
    if (montoSolicitado < MINIMO_RECARGA_CLIENTE) {
      return { error: `Mínimo recarga: $${MINIMO_RECARGA_CLIENTE}`, code: 400 };
    }

    // Guardar comprobante (en producción a Supabase Storage bucket evidencias-legales)
    const { data: recarga, error } = await supabase
      .from('recargas')
      .insert([{
        cliente_id: clienteId,
        monto_solicitado: montoSolicitado,
        comprobante_url: comprobanteBase64,
        estado: 'pendiente'
      }])
      .select()
      .single();

    if (error) return { error: error.message, code: 500 };

    const { data: cliente } = await supabase
      .from('users')
      .select('name, email')
      .eq('id', clienteId)
      .single();

    const whatsappLink = generarLinkWhatsapp(recarga.id, cliente, montoSolicitado);

    await supabase.from('recargas_pendientes').insert([{
      recarga_id: recarga.id,
      cliente_id: clienteId,
      monto_solicitado: montoSolicitado,
      whatsapp_admin: process.env.ADMIN_PHONE || '3146368170',
      whatsapp_link: whatsappLink,
      estado: 'pendiente'
    }]);

    await enviarEmailAdmin(
      'Recarga Pendiente de Verificación',
      `Cliente: ${cliente.name} (${cliente.email})\nMonto: $${montoSolicitado}\nRecarga ID: ${recarga.id}\nWhatsApp: ${whatsappLink}`
    );

    return { recarga: { ...recarga, whatsapp_link: whatsappLink }, code: 201 };
  } catch (error) {
    console.error('Error solicitando recarga:', error);
    return { error: error.message, code: 500 };
  }
}

// Admin verifica y acredita recarga
export async function verificarRecarga(recargaId, adminId, montoVerificado, aprobado = true) {
  try {
    const { data: recarga } = await supabase
      .from('recargas')
      .select('*')
      .eq('id', recargaId)
      .single();

    if (!recarga || recarga.estado !== 'pendiente') {
      return { error: 'Recarga no está pendiente', code: 400 };
    }

    if (aprobado) {
      // Acreditar saldo
      const { data: cliente } = await supabase
        .from('users')
        .select('balance')
        .eq('id', recarga.cliente_id)
        .single();

      await supabase
        .from('users')
        .update({ balance: cliente.balance + montoVerificado })
        .eq('id', recarga.cliente_id);

      await supabase
        .from('recargas')
        .update({
          estado: 'verificado',
          monto_acreditado: montoVerificado,
          verificado_por: adminId,
          verificado_at: new Date().toISOString()
        })
        .eq('id', recargaId);

      // Notificar cliente
      await crearNotificacion(recarga.cliente_id, 'recarga_acreditada', 'Saldo acreditado', {
        monto: montoVerificado
      });

      return { recarga: { ...recarga, estado: 'verificado', monto_acreditado: montoVerificado }, code: 200 };
    } else {
      // Rechazar
      await supabase
        .from('recargas')
        .update({
          estado: 'rechazado',
          verificado_por: adminId,
          verificado_at: new Date().toISOString()
        })
        .eq('id', recargaId);

      await crearNotificacion(recarga.cliente_id, 'recarga_acreditada', 'Recarga rechazada', {
        motivo: 'Verificación fallida'
      });

      return { recarga: { ...recarga, estado: 'rechazado' }, code: 200 };
    }
  } catch (error) {
    console.error('Error verificando recarga:', error);
    return { error: error.message, code: 500 };
  }
}

// Obtener recargas pendientes (para panel admin)
export async function obtenerRecargasPendientes() {
  try {
    const { data: recargas, error } = await supabase
      .from('recargas')
      .select('*, cliente:cliente_id(name, email)')
      .eq('estado', 'pendiente')
      .order('created_at', { ascending: true });

    if (error) return { error: error.message, code: 500 };

    return { recargas: recargas || [], code: 200 };
  } catch (error) {
    console.error('Error obteniendo recargas:', error);
    return { error: error.message, code: 500 };
  }
}

// Obtener saldo cliente
export async function obtenerSaldoCliente(clienteId) {
  try {
    const { data: cliente, error } = await supabase
      .from('users')
      .select('balance')
      .eq('id', clienteId)
      .single();

    if (error) return { error: error.message, code: 500 };

    return { saldo: cliente?.balance || 0, code: 200 };
  } catch (error) {
    console.error('Error obteniendo saldo:', error);
    return { error: error.message, code: 500 };
  }
}

// Obtener saldo ganado auxiliar (Contrato Auxiliares - Cláusula 3)
export async function obtenerSaldoAuxiliar(auxiliarId) {
  try {
    const { data: billetera, error } = await supabase
      .from('billetera_auxiliares')
      .select('*')
      .eq('auxiliar_id', auxiliarId)
      .single();

    if (error && error.code === 'PGRST116') {
      // No existe billetera, crear
      const { data: nuevaBilletera } = await supabase
        .from('billetera_auxiliares')
        .insert([{ auxiliar_id: auxiliarId, saldo_ganado: 0 }])
        .select()
        .single();
      return { billetera: nuevaBilletera, code: 200 };
    }

    if (error) return { error: error.message, code: 500 };

    return { billetera: billetera || {}, code: 200 };
  } catch (error) {
    console.error('Error obteniendo saldo auxiliar:', error);
    return { error: error.message, code: 500 };
  }
}

// Retirar saldo auxiliar (24 horas después de terminar)
export async function retirarSaldoAuxiliar(auxiliarId, montoRetirar, metodoPago) {
  try {
    const { data: billetera } = await supabase
      .from('billetera_auxiliares')
      .select('*')
      .eq('auxiliar_id', auxiliarId)
      .single();

    if (!billetera || billetera.saldo_ganado < montoRetirar) {
      return { error: 'Saldo insuficiente para retirar', code: 402 };
    }

    // Verificar que no haya servicios en últimas 24h sin completar
    const hace24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: serviciosRecientes } = await supabase
      .from('pedidos')
      .select('*')
      .eq('auxiliar_id', auxiliarId)
      .gte('terminado_at', hace24h)
      .eq('status', 'completado');

    if (!serviciosRecientes || serviciosRecientes.length === 0) {
      return { error: 'No hay servicios completados en últimas 24 horas', code: 400 };
    }

    // Actualizar billetera
    await supabase
      .from('billetera_auxiliares')
      .update({
        saldo_ganado: billetera.saldo_ganado - montoRetirar,
        saldo_retirado: billetera.saldo_retirado + montoRetirar
      })
      .eq('auxiliar_id', auxiliarId);

    // Registrar retiro
    await crearNotificacion(auxiliarId, 'pago_liberado', 'Retiro procesado', {
      monto: montoRetirar,
      metodo: metodoPago
    });

    return { mensaje: `Retiro de $${montoRetirar} procesado`, code: 200 };
  } catch (error) {
    console.error('Error retirando saldo:', error);
    return { error: error.message, code: 500 };
  }
}

// Aplicar crédito de cortesía (Contrato Clientes - Cláusula 13)
export async function aplicarCreditoCortes(clienteId, packId) {
  try {
    const { data: pack } = await supabase
      .from('packs')
      .select('num_bloques, shift_type')
      .eq('id', packId)
      .eq('cliente_id', clienteId)
      .single();

    if (!pack || ![5, 13].includes(pack.num_bloques)) {
      return { error: 'Crédito no aplica para este pack', code: 400 };
    }

    const creditoValor = 32500; // 2 horas
    const { data: cliente } = await supabase
      .from('users')
      .select('balance')
      .eq('id', clienteId)
      .single();

    await supabase
      .from('users')
      .update({ balance: cliente.balance + creditoValor })
      .eq('id', clienteId);

    await crearNotificacion(clienteId, 'recarga_acreditada', 'Crédito de cortesía aplicado', {
      monto: creditoValor,
      razon: '2 horas gratis'
    });

    return { mensaje: `Crédito de $${creditoValor} aplicado`, code: 200 };
  } catch (error) {
    console.error('Error aplicando crédito:', error);
    return { error: error.message, code: 500 };
  }
}

// HELPER FUNCTIONS

async function enviarEmailAdmin(asunto, contenido) {
  try {
    const adminEmail = process.env.ADMIN_EMAIL || 'nodopro78@gmail.com';
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: adminEmail,
      subject: asunto,
      text: contenido,
      html: `<p>${contenido.replace(/\n/g, '<br>')}</p>`
    });
  } catch (error) {
    console.error('Error enviando email:', error);
  }
}

function generarLinkWhatsapp(recargaId, cliente, monto) {
  const texto = `Hola NODO PRO admin, recarga pendiente de ${monto} COP para cliente ${cliente.name} (${cliente.email}). Recarga ID: ${recargaId}`;
  return `https://wa.me/573146368170?text=${encodeURIComponent(texto)}`;
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

export default {
  solicitarRecargaSaldo,
  verificarRecarga,
  obtenerRecargasPendientes,
  obtenerSaldoCliente,
  obtenerSaldoAuxiliar,
  retirarSaldoAuxiliar,
  aplicarCreditoCortes
};
