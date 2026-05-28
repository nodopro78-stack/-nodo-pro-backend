// notificaciones.js - Sistema de Notificaciones y Alertas
// Incluye notificación de vencimiento PILA y examen médico

import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';
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

// Crear notificación
export async function crearNotificacion(userId, tipo, titulo, data = {}) {
  try {
    const { error } = await supabase.from('notificaciones').insert([{
      user_id: userId,
      tipo,
      titulo,
      data
    }]);

    if (error) {
      console.error('Error creando notificación:', error);
      return { error: error.message, code: 500 };
    }

    return { code: 201 };
  } catch (error) {
    console.error('Error en crearNotificacion:', error);
    return { error: error.message, code: 500 };
  }
}

// Alias para compatibilidad con index.js
export async function enviarNotificacion(userId, tipo, titulo, data = {}) {
  return crearNotificacion(userId, tipo, titulo, data);
}

// Obtener notificaciones de usuario
export async function obtenerNotificaciones(userId, limite = 50) {
  try {
    const { data: notificaciones, error } = await supabase
      .from('notificaciones')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limite);

    if (error) return { error: error.message, code: 500 };

    return { notificaciones: notificaciones || [], code: 200 };
  } catch (error) {
    console.error('Error obteniendo notificaciones:', error);
    return { error: error.message, code: 500 };
  }
}

// Marcar notificación como leída
export async function marcarComoLeida(notificacionId) {
  try {
    const { error } = await supabase
      .from('notificaciones')
      .update({ leida: true })
      .eq('id', notificacionId);

    if (error) return { error: error.message, code: 500 };

    return { code: 200 };
  } catch (error) {
    console.error('Error marcando como leída:', error);
    return { error: error.message, code: 500 };
  }
}

// CRON JOB: Verificar vencimientos de PILA y examen (5 días antes)
export function iniciarVerificadorVencimientos() {
  cron.schedule('0 6 * * *', async () => {
    console.log('[CRON] Verificando vencimientos de PILA y examen médico...');
    await verificarVencimientosPILA();
    await verificarVencimientosExamen();
  });

  verificarVencimientosPILA();
  verificarVencimientosExamen();
}

export async function verificarVencimientos() {
  await verificarVencimientosPILA();
  await verificarVencimientosExamen();
}

async function verificarVencimientosPILA() {
  try {
    const hoy = new Date();
    const en5Dias = new Date(hoy.getTime() + 5 * 24 * 60 * 60 * 1000);

    const { data: auxiliares, error } = await supabase
      .from('users')
      .select('id, name, email, pila_expires_at')
      .eq('role', 'auxiliar')
      .eq('status', 'activo')
      .gte('pila_expires_at', hoy.toISOString())
      .lte('pila_expires_at', en5Dias.toISOString());

    if (error) {
      console.error('Error verificando PILA:', error);
      return;
    }

    for (const aux of auxiliares || []) {
      await crearNotificacion(aux.id, 'pila_vence', 'Tu PILA vence en 5 días', {
        fecha_vencimiento: aux.pila_expires_at
      });

      const { data: admin } = await supabase
        .from('users')
        .select('id')
        .eq('role', 'admin')
        .limit(1)
        .single();

      if (admin) {
        await crearNotificacion(
          admin.id,
          'pila_vence',
          `PILA de ${aux.name} vence en 5 días`,
          { auxiliar_id: aux.id, auxiliar_email: aux.email }
        );
      }

      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: aux.email,
        subject: 'Alerta: Tu PILA vence en 5 días',
        html: `<p>Hola ${aux.name},</p><p>Tu planilla de afiliación (PILA) vence el ${new Date(aux.pila_expires_at).toLocaleDateString()}. Carga un nuevo soporte en la app antes de esa fecha para continuar trabajando.</p>`
      });
    }

    console.log(`[CRON] ${auxiliares?.length || 0} PILA en vencimiento notificadas`);
  } catch (error) {
    console.error('[CRON] Error en verificarVencimientosPILA:', error);
  }
}

async function verificarVencimientosExamen() {
  try {
    const hoy = new Date();
    const en5Dias = new Date(hoy.getTime() + 5 * 24 * 60 * 60 * 1000);

    const { data: auxiliares, error } = await supabase
      .from('users')
      .select('id, name, email, examen_medico_expires_at')
      .eq('role', 'auxiliar')
      .eq('status', 'activo')
      .gte('examen_medico_expires_at', hoy.toISOString())
      .lte('examen_medico_expires_at', en5Dias.toISOString());

    if (error) {
      console.error('Error verificando examen médico:', error);
      return;
    }

    for (const aux of auxiliares || []) {
      await crearNotificacion(aux.id, 'examen_vence', 'Tu examen médico vence en 5 días', {
        fecha_vencimiento: aux.examen_medico_expires_at
      });

      const { data: admin } = await supabase
        .from('users')
        .select('id')
        .eq('role', 'admin')
        .limit(1)
        .single();

      if (admin) {
        await crearNotificacion(
          admin.id,
          'examen_vence',
          `Examen médico de ${aux.name} vence en 5 días`,
          { auxiliar_id: aux.id, auxiliar_email: aux.email }
        );
      }

      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: aux.email,
        subject: 'Alerta: Tu examen médico vence en 5 días',
        html: `<p>Hola ${aux.name},</p><p>Tu examen médico vence el ${new Date(aux.examen_medico_expires_at).toLocaleDateString()}. Carga un nuevo soporte en la app antes de esa fecha para continuar trabajando.</p>`
      });
    }

    console.log(`[CRON] ${auxiliares?.length || 0} exámenes en vencimiento notificadas`);
  } catch (error) {
    console.error('[CRON] Error en verificarVencimientosExamen:', error);
  }
}

// CRON JOB: Liberar pagos automáticamente 24h después
export function iniciarLiberadorPagosAuto() {
  cron.schedule('0 * * * *', async () => {
    console.log('[CRON] Verificando pagos para liberación automática...');
    await liberarPagosAutomaticos();
  });
}

async function liberarPagosAutomaticos() {
  try {
    const hace24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: packs, error } = await supabase
      .from('packs')
      .select('*')
      .eq('status', 'completado')
      .lte('completed_at', hace24h);

    if (error) {
      console.error('Error obteniendo packs:', error);
      return;
    }

    for (const pack of packs || []) {
      await supabase
        .from('packs')
        .update({ status: 'pagado' })
        .eq('id', pack.id);

      console.log(`[CRON] Pack ${pack.id} liberado automáticamente`);
    }

    console.log(`[CRON] ${packs?.length || 0} pagos liberados automáticamente`);
  } catch (error) {
    console.error('[CRON] Error en liberarPagosAutomaticos:', error);
  }
}

export async function enviarPushNotificacion(userId, titulo, contenido) {
  try {
    console.log(`[PUSH] ${titulo} → ${userId}`);
    await crearNotificacion(userId, 'push', titulo, { contenido });
  } catch (error) {
    console.error('Error enviando push:', error);
  }
}

export default {
  crearNotificacion,
  enviarNotificacion,
  obtenerNotificaciones,
  marcarComoLeida,
  iniciarVerificadorVencimientos,
  iniciarLiberadorPagosAuto,
  verificarVencimientos,
  enviarPushNotificacion
};
