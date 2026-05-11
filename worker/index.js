/**
 * PixelVault — Cloudflare Worker
 * Actúa como backend seguro para:
 *   POST /crear-suscripcion  → crea preapproval en MP
 *   POST /crear-preferencia  → crea preferencia de pago (recarga)
 *   POST /webhook            → recibe notificaciones de MP y actualiza Supabase
 *
 * Variables de entorno requeridas (en wrangler.toml o dashboard):
 *   MP_ACCESS_TOKEN   — tu Access Token de MercadoPago
 *   SUPABASE_URL      — https://tu_project_id.supabase.co
 *   SUPABASE_SERVICE_KEY — service_role key (NUNCA la anon)
 *   APP_URL           — https://tu-dominio.pages.dev
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
    /* ── CORS preflight ─────────────────────────── */
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/crear-suscripcion' && request.method === 'POST') {
        return await crearSuscripcion(request, env);
      }
      if (url.pathname === '/crear-preferencia' && request.method === 'POST') {
        return await crearPreferencia(request, env);
      }
      if (url.pathname === '/webhook' && request.method === 'POST') {
        return await manejarWebhook(request, env);
      }

      return jsonResponse({ error: 'Ruta no encontrada' }, 404);
    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: 'Error interno del servidor' }, 500);
    }
  }
};

/* ══════════════════════════════════════════════════
   1. CREAR SUSCRIPCIÓN — preapproval sin plan
   ══════════════════════════════════════════════════ */
async function crearSuscripcion(request, env) {
  const { user_id, email } = await request.json();

  if (!user_id || !email) {
    return jsonResponse({ error: 'Faltan parámetros: user_id, email' }, 400);
  }

  const body = {
    reason:             'PixelVault — Plan Coleccionista Pro',
    external_reference: user_id,          // lo usamos en el webhook para vincular al usuario
    payer_email:        email,
    back_url:           `${env.APP_URL}?status=approved`,
    auto_recurring: {
      frequency:          1,
      frequency_type:     'months',
      transaction_amount: 1000,           // ARS $1.000
      currency_id:        'ARS',
    },
    status: 'pending',
  };

  const mp = await mpPost('preapproval', body, env.MP_ACCESS_TOKEN);

  if (mp.error) {
    return jsonResponse({ error: mp.message || 'Error en MercadoPago' }, 502);
  }

  return jsonResponse({ init_point: mp.init_point });
}

/* ══════════════════════════════════════════════════
   2. CREAR PREFERENCIA DE PAGO (recarga de créditos)
   ══════════════════════════════════════════════════ */
async function crearPreferencia(request, env) {
  const { user_id, amount, credits, type } = await request.json();

  const body = {
    items: [{
      title:      `PixelVault — ${credits} créditos`,
      quantity:   1,
      unit_price: amount,         // precio en ARS
      currency_id: 'ARS',
    }],
    external_reference: JSON.stringify({ user_id, credits, type }),
    back_urls: {
      success: `${env.APP_URL}?status=approved`,
      failure: `${env.APP_URL}?status=failure`,
      pending: `${env.APP_URL}?status=pending`,
    },
    auto_return:     'approved',
    notification_url: `${env.APP_URL_WORKER}/webhook`,  // Worker URL
  };

  const mp = await mpPost('checkout/preferences', body, env.MP_ACCESS_TOKEN);

  if (mp.error) {
    return jsonResponse({ error: mp.message }, 502);
  }

  // Usamos sandbox_init_point en testing, init_point en producción
  return jsonResponse({ init_point: mp.sandbox_init_point ?? mp.init_point });
}

/* ══════════════════════════════════════════════════
   3. WEBHOOK — notificaciones de MercadoPago
   ══════════════════════════════════════════════════
   MP envía POST con body: { type, data: { id } }
   Tipos relevantes: "subscription_preapproval" | "payment"
   ══════════════════════════════════════════════════ */
async function manejarWebhook(request, env) {
  const body = await request.json();
  console.log('Webhook recibido:', JSON.stringify(body));

  /* ── Suscripción aprobada ──────────────────────── */
  if (body.type === 'subscription_preapproval') {
    const preapproval = await mpGet(`preapproval/${body.data.id}`, env.MP_ACCESS_TOKEN);

    if (preapproval.status === 'authorized') {
      const userId = preapproval.external_reference;

      // Marcar como Pro + acreditar $500 de créditos bienvenida
      await supabaseUpdate(env, 'profiles', userId, {
        is_pro:          true,
        mp_preapproval_id: preapproval.id,
        credits:         500,   // créditos de bienvenida del plan
        updated_at:      new Date().toISOString(),
      });

      // Registrar en tabla de suscripciones
      await supabaseInsert(env, 'subscriptions', {
        user_id:       userId,
        preapproval_id: preapproval.id,
        status:        'authorized',
        amount:        1000,
        currency:      'ARS',
        created_at:    new Date().toISOString(),
      });
    }

    // Si la suscripción fue cancelada
    if (preapproval.status === 'cancelled' || preapproval.status === 'paused') {
      const userId = preapproval.external_reference;
      await supabaseUpdate(env, 'profiles', userId, {
        is_pro: false,
        updated_at: new Date().toISOString(),
      });
    }
  }

  /* ── Pago único aprobado (recarga) ────────────── */
  if (body.type === 'payment') {
    const payment = await mpGet(`v1/payments/${body.data.id}`, env.MP_ACCESS_TOKEN);

    if (payment.status === 'approved') {
      try {
        const ref = JSON.parse(payment.external_reference || '{}');
        if (ref.type === 'recharge' && ref.user_id) {
          // Acreditar créditos via RPC de Supabase
          await supabaseRPC(env, 'agregar_creditos', {
            p_user_id: ref.user_id,
            p_amount:  ref.credits,
          });

          // Log de transacción
          await supabaseInsert(env, 'transactions', {
            user_id:    ref.user_id,
            payment_id: String(payment.id),
            type:       'recharge',
            credits:    ref.credits,
            amount_ars: payment.transaction_amount,
            status:     'approved',
            created_at: new Date().toISOString(),
          });
        }
      } catch (e) {
        console.error('Error procesando recarga:', e);
      }
    }
  }

  // MP requiere 200 inmediato, sino reintenta hasta 4 días
  return new Response('OK', { status: 200, headers: CORS_HEADERS });
}

/* ══════════════════════════════════════════════════
   HELPERS — MercadoPago
   ══════════════════════════════════════════════════ */
async function mpPost(endpoint, body, token) {
  const res = await fetch(`https://api.mercadopago.com/${endpoint}`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function mpGet(endpoint, token) {
  const res = await fetch(`https://api.mercadopago.com/${endpoint}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return res.json();
}

/* ══════════════════════════════════════════════════
   HELPERS — Supabase (service role)
   ══════════════════════════════════════════════════ */
function sbHeaders(env) {
  return {
    'Content-Type':  'application/json',
    'apikey':        env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Prefer':        'return=minimal',
  };
}

async function supabaseUpdate(env, table, userId, data) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${userId}`, {
    method:  'PATCH',
    headers: sbHeaders(env),
    body:    JSON.stringify(data),
  });
}

async function supabaseInsert(env, table, data) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method:  'POST',
    headers: sbHeaders(env),
    body:    JSON.stringify(data),
  });
}

async function supabaseRPC(env, fn, params) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method:  'POST',
    headers: sbHeaders(env),
    body:    JSON.stringify(params),
  });
}

/* ══════════════════════════════════════════════════
   HELPERS — Respuesta JSON
   ══════════════════════════════════════════════════ */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
