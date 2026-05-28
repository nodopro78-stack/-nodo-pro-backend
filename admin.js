// admin.js - Funciones Administrativas
// Contrato Auxiliares - Cláusula 1, Contrato Clientes - Cláusula 5

import { createClient } from '@supabase/supabase-js';
import { verificarVencimientos } from './notificaciones.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Registrar auxiliar (SOLO ADMIN)
// Contrato Auxiliares - Cláusula 1: "EL AUXILIAR" decide libremente cuándo conectarse
export async function registrarAuxiliar(adminId, datosAuxiliar) {
  try {
    // Verificar que quien registra es admin
    const { data: admin } = await supabase
      .from('users')
      .select('role')
      .eq('id', adminId)
      .single();

    if (admin?.role !== 'admin') {
      return { error: 'Solo admin puede registrar auxiliares', code: 403 };
    }

    const {
      nombre,
      cedula,
      email,
      telefono,
      fotoBase64,
      pilaBase64,
      pilaVencimiento,
      examenMedicoBase64,
      examenVencimiento
    } = datosAuxiliar;

    // Validaciones obligatorias
    if (!nombre || !cedula || !email || !telefono || !fotoBase64 || !pilaBase64 || !examenMedicoBase64) {
      return {
        error: 'Campos obligatorios: nombre, cédula, email, teléfono, foto, PILA, examen médico',
        code: 400
      };
    }

    // Crear usuario
    const { data: usuario, error: userError } = await supabase
      .from('users')
      .insert([{
        role: 'auxiliar',
        name: nombre,
        email,
        phone: telefono,
        cedula,
        photo_url: fotoBase64,
        pila_url: pilaBase64,
        pila_expires_at: new Date(pilaVencimiento).toISOString(),
        pila_status: 'vigente',
        examen_medico_url: examenMedicoBase64,
        examen_medico_expires_at: new Date(examenVencimiento).toISOString(),
        status: 'activo',
        consent_ley1581: true,
        consent_ip: 'admin-registration'
      }])
      .select()
      .single();

    if (userError) return { error: userError.message, code: 500 };

    // Crear billetera
    await supabase.from('billetera_auxiliares').insert([{
      auxiliar_id: usuario.id,
      saldo_ganado: 0
    }]);

    return { usuario, code: 201 };
  } catch (error) {
    console.error('Error registrando auxiliar:', error);
    return { error: error.message, code: 500 };
  }
}

// Registrar cliente (SOLO ADMIN)
export async function registrarCliente(adminId, datosCliente) {
  try {
    const { data: admin } = await supabase
      .from('users')
      .select('role')
      .eq('id', adminId)
      .single();

    if (admin?.role !== 'admin') {
      return { error: 'Solo admin puede registrar clientes', code: 403 };
    }

    const { razonSocial, nit, email, telefono, nombreContacto } = datosCliente;

    if (!razonSocial || !nit || !email || !telefono) {
      return { error: 'Campos obligatorios: razón social, NIT, email, teléfono', code: 400 };
    }

    const { data: usuario, error } = await supabase
      .from('users')
      .insert([{
        role: 'cliente',
        name: razonSocial,
        business_name: razonSocial,
        nit,
        email,
        phone: telefono,
        status: 'activo',
        balance: 0,
        consent_ley1581: true,
        consent_ip: 'admin-registration'
      }])
      .select()
      .single();

    if (error) return { error: error.message, code: 500 };

    return { usuario, code: 201 };
  } catch (error) {
    console.error('Error registrando cliente:', error);
    return { error: error.message, code: 500 };
  }
}

// Obtener radar en tiempo real (admin ve todo)
// Contrato Clientes - Cláusula 2: "Auxiliar es persona natural independiente"
export async function obtenerRadar(adminId) {
  try {
    const { data: admin } = await supabase
      .from('users')
      .select('role')
      .eq('id', adminId)
      .single();

    if (admin?.role !== 'admin') {
      return { error: 'Solo admin puede acceder', code: 403 };
    }

    await verificarVencimientos();

    // Obtener todos los auxiliares con estado
    const { data: auxiliares, error } = await supabase
      .from('users')
      .select('id, name, email, phone, pila_status, pila_expires_at, status')
      .eq('role', 'auxiliar')
      .order('name');

    if (error) return { error: error.message, code: 500 };

    // Obtener pedidos activos
    const { data: pedidosActivos } = await supabase
      .from('pedidos')
      .select('id, auxiliar_id, status')
      .in('status', ['aceptado', 'iniciado']);

    const radar = (auxiliares || []).map(aux => {
      const pedido = pedidosActivos?.find(p => p.auxiliar_id === aux.id);
      return {
        ...aux,
        estado_operativo: pedido ? 'ocupado' : 'disponible',
        estado_pila: aux.pila_status,
        dias_para_vencer: aux.pila_expires_at ? Math.ceil((new Date(aux.pila_expires_at) - new Date()) / (1000 * 60 * 60 * 24)) : null
      };
    });

    return { radar, code: 200 };
  } catch (error) {
    console.error('Error obteniendo radar:', error);
    return { error: error.message, code: 500 };
  }
}

// Ver todos los pedidos (admin audita)
export async function obtenerTodosPedidos(adminId, filtros = {}) {
  try {
    const { data: admin } = await supabase
      .from('users')
      .select('role')
      .eq('id', adminId)
      .single();

    if (!['admin', 'auditor'].includes(admin?.role)) {
      return { error: 'Acceso denegado', code: 403 };
    }

    let query = supabase
      .from('pedidos')
      .select('*, cliente:cliente_id(name), auxiliar:auxiliar_id(name)');

    if (filtros.status) {
      query = query.eq('status', filtros.status);
    }
    if (filtros.auxiliarId) {
      query = query.eq('auxiliar_id', filtros.auxiliarId);
    }
    if (filtros.clienteId) {
      query = query.eq('cliente_id', filtros.clienteId);
    }

    const { data: pedidos, error } = await query.order('created_at', { ascending: false });

    if (error) return { error: error.message, code: 500 };

    return { pedidos: pedidos || [], code: 200 };
  } catch (error) {
    console.error('Error obteniendo pedidos:', error);
    return { error: error.message, code: 500 };
  }
}

// Bloquear auxiliar por incumplimiento
// Contrato Auxiliares - Cláusula 12: Terminación inmediata por fraude
export async function bloquearAuxiliar(adminId, auxiliarId, razon) {
  try {
    const { data: admin } = await supabase
      .from('users')
      .select('role')
      .eq('id', adminId)
      .single();

    if (admin?.role !== 'admin') {
      return { error: 'Solo admin puede bloquear usuarios', code: 403 };
    }

    const { error } = await supabase
      .from('users')
      .update({ status: 'bloqueado' })
      .eq('id', auxiliarId);

    if (error) return { error: error.message, code: 500 };

    // Crear notificación
    await supabase.from('notificaciones').insert([{
      user_id: auxiliarId,
      tipo: 'sistema',
      titulo: 'Tu cuenta ha sido bloqueada',
      data: { razon }
    }]);

    return { mensaje: `Auxiliar bloqueado por: ${razon}`, code: 200 };
  } catch (error) {
    console.error('Error bloqueando auxiliar:', error);
    return { error: error.message, code: 500 };
  }
}

// Panel administrativo - resumen
export async function obtenerResumenAdmin(adminId) {
  try {
    const { data: admin } = await supabase
      .from('users')
      .select('role')
      .eq('id', adminId)
      .single();

    if (admin?.role !== 'admin') {
      return { error: 'Solo admin', code: 403 };
    }

    const { data: auxiliares } = await supabase
      .from('users')
      .select('id')
      .eq('role', 'auxiliar')
      .eq('status', 'activo');

    const { data: clientes } = await supabase
      .from('users')
      .select('id')
      .eq('role', 'cliente')
      .eq('status', 'activo');

    const { data: pedidosHoy } = await supabase
      .from('pedidos')
      .select('id')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    const { data: recargas } = await supabase
      .from('recargas')
      .select('*')
      .eq('estado', 'pendiente');

    const resumen = {
      auxiliares_activos: auxiliares?.length || 0,
      clientes_activos: clientes?.length || 0,
      pedidos_hoy: pedidosHoy?.length || 0,
      recargas_pendientes: recargas?.length || 0,
      monto_total_recargas: recargas?.reduce((sum, r) => sum + r.monto_solicitado, 0) || 0
    };

    return { resumen, code: 200 };
  } catch (error) {
    console.error('Error obteniendo resumen:', error);
    return { error: error.message, code: 500 };
  }
}

export default {
  registrarAuxiliar,
  registrarCliente,
  obtenerRadar,
  obtenerTodosPedidos,
  bloquearAuxiliar,
  obtenerResumenAdmin
};
