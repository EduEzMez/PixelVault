# PixelVault 🎨

> Marketplace de arte digital con suscripción mensual y compras con créditos.
> App educativa / boilerplate para integrar **MercadoPago + Supabase + Cloudflare Pages**.

---

## ¿Qué hace esta app?

| Feature | Descripción |
|---|---|
| **Suscripción mensual** | $1.000 ARS/mes via MercadoPago Preapproval |
| **Créditos de bienvenida** | $500 créditos al suscribirse |
| **Compra con créditos** | Descuento atómico en Supabase (sin doble gasto) |
| **Recarga de créditos** | Pago único con preferencia de checkout |
| **Auth** | Supabase Auth (email/password) |
| **Backend sin servidor** | Cloudflare Worker (sin Node.js, sin hosting) |
| **Webhook seguro** | El Worker procesa notificaciones de MP y actualiza Supabase |

---

## Stack técnico

```
Frontend    → HTML + CSS + Vanilla JS (Cloudflare Pages)
Backend     → Cloudflare Worker (JS, sin framework)
Base de datos → Supabase (PostgreSQL + Auth + RLS)
Pagos       → MercadoPago (Preapproval + Checkout Preferences)
Repo        → GitHub
```

---

## Arquitectura

```
Browser
  │
  ├──► Supabase Auth (registro/login)
  ├──► Supabase DB (leer perfil, RPC comprar_obra)
  │
  └──► Cloudflare Worker
          ├── POST /crear-suscripcion  → MercadoPago /preapproval
          ├── POST /crear-preferencia  → MercadoPago /checkout/preferences
          └── POST /webhook ◄── MercadoPago notifica
                  │
                  └──► Supabase (actualiza is_pro, credits, transactions)
```

**¿Por qué el Worker?**
Las credenciales de MP (`ACCESS_TOKEN`) nunca se exponen al browser. El Worker es el único que las conoce, recibe los webhooks de MP y actualiza Supabase con la `service_role` key (también secreta).

---

## Paso a paso completo

---

### PASO 1 — Clonar repo y estructura

```bash
git clone https://github.com/TU_USUARIO/pixelvault.git
cd pixelvault
```

Estructura del proyecto:
```
pixelvault/
├── index.html              ← Frontend completo (1 archivo)
├── supabase/
│   └── schema.sql          ← Tablas + funciones + RLS
└── worker/
    ├── index.js            ← Cloudflare Worker (backend)
    └── wrangler.toml       ← Config del Worker
```

---

### PASO 2 — Crear proyecto en Supabase

1. Ir a [app.supabase.com](https://app.supabase.com) → **New project**
2. Elegí organización, nombre `pixelvault`, contraseña segura, región **South America (São Paulo)**
3. Esperá ~2 minutos a que se inicialice

#### Ejecutar el schema SQL

1. En el dashboard: **SQL Editor** → **New query**
2. Pegá el contenido completo de `supabase/schema.sql`
3. Click **Run** (F5)
4. Deberías ver: `Success. No rows returned`

#### Configurar Auth (email)

1. **Authentication** → **Providers** → **Email** → habilitado por defecto ✓
2. (Opcional) En **Email** → desactivar "Confirm email" para testing

#### Obtener credenciales

1. **Project Settings** → **API**
2. Copiar:
   - `URL` → `https://xxxx.supabase.co`
   - `anon public` key → para el frontend
   - `service_role` key → **SECRETO**, solo para el Worker

---

### PASO 3 — Crear cuenta de desarrollador en MercadoPago

1. Ir a [mercadopago.com.ar/developers](https://www.mercadopago.com.ar/developers/es)
2. Logeate con tu cuenta de MP
3. **Mis aplicaciones** → **Crear aplicación**
   - Nombre: `PixelVault`
   - ¿Usás Marketplace? No
   - Modelo de integración: **Checkout Pro** (para preferencias) + **Suscripciones**
4. En la app creada, ir a **Credenciales de prueba**:
   - Copiar `Access Token` de **TEST** (empieza con `TEST-`)

> ⚠️ Nunca commitees el Access Token. Siempre usá variables de entorno.

#### Crear usuarios de prueba

1. En el dashboard de MP: **Mis aplicaciones** → tu app → **Cuentas de prueba**
2. Crear 2 cuentas de prueba (una vendedor, una comprador)
3. Usá las credenciales del **comprador** para testear pagos

---

### PASO 4 — Cloudflare Worker (backend)

#### Instalar Wrangler

```bash
npm install -g wrangler
wrangler login
```

#### Configurar el Worker

Editá `worker/wrangler.toml` y reemplazá `TU_USUARIO` con tu nombre de usuario de Cloudflare.

#### Cargar secretos (NUNCA van en código)

```bash
cd worker

# Access Token de MercadoPago
wrangler secret put MP_ACCESS_TOKEN
# → pega tu TEST-... token y Enter

# Supabase service_role key
wrangler secret put SUPABASE_SERVICE_KEY
# → pega el service_role key

# URL de tu proyecto Supabase
wrangler secret put SUPABASE_URL
# → pega https://xxxx.supabase.co
```

#### Deployar el Worker

```bash
wrangler deploy
```

Vas a ver algo como:
```
✅ https://pixelvault-worker.TU_USUARIO.workers.dev
```

Anotá esa URL.

#### Registrar el Webhook en MercadoPago

1. [mercadopago.com.ar/developers](https://www.mercadopago.com.ar/developers/es) → tu app → **Webhooks**
2. **Agregar URL de producción** → `https://pixelvault-worker.TU_USUARIO.workers.dev/webhook`
3. Eventos a escuchar:
   - ✅ `subscription_preapproval`
   - ✅ `payment`
4. Guardar

---

### PASO 5 — Configurar el frontend

Abrí `index.html` y reemplazá las 3 constantes al inicio del script:

```javascript
const SUPABASE_URL  = 'https://TU_PROJECT_ID.supabase.co';
const SUPABASE_ANON = 'TU_ANON_KEY';
const WORKER_URL    = 'https://pixelvault-worker.TU_USUARIO.workers.dev';
```

---

### PASO 6 — Subir a GitHub y deployar en Cloudflare Pages

#### Subir a GitHub

```bash
git add .
git commit -m "feat: pixelvault inicial"
git push origin main
```

#### Crear proyecto en Cloudflare Pages

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Pages** → **Create a project**
2. **Connect to Git** → seleccionar el repo `pixelvault`
3. Configuración de build:
   - Framework preset: **None**
   - Build command: (vacío)
   - Build output directory: `/` (raíz)
4. Click **Save and Deploy**

En ~30 segundos: `https://pixelvault.pages.dev` ✅

#### Actualizar URL en Worker

```bash
cd worker
wrangler secret put APP_URL
# → pega https://pixelvault.pages.dev
```

---

### PASO 7 — Probar el flujo completo

#### Flujo de suscripción

1. Registrate en la app con un email de prueba
2. Click **Suscribirme con MercadoPago**
3. En el checkout de MP, usá los datos de la cuenta de prueba **compradora**:
   - Tarjeta de prueba: `5031 7557 3453 0604`
   - Vencimiento: cualquier fecha futura
   - CVV: `123`
   - Nombre: `APRO` (para que el pago sea aprobado)
4. MP te redirige de vuelta con `?status=approved`
5. En unos segundos el webhook llega y tu cuenta queda como **PRO** con **$500 créditos**

> ℹ️ El webhook puede tardar algunos segundos. Si el badge no aparece de inmediato, recargá la página.

#### Flujo de compra con créditos

1. Con tu cuenta PRO, hacé click en **Comprar con créditos** en cualquier obra
2. Confirmá la compra en el modal
3. Los créditos se descuentan en tiempo real (transacción atómica en Supabase)
4. La obra aparece en tu colección con el badge ✓

#### Verificar en Supabase

En el dashboard → **Table Editor** → `profiles`:
```
is_pro: true
credits: 500 (o lo que quede luego de compras)
purchased_ids: {1} (IDs de obras compradas)
```

---

### PASO 8 — Pasar a producción

Cuando todo funcione en testing:

1. En MP dashboard → **Credenciales de producción** → copiar el `Access Token` de producción
2. Actualizar el secreto del Worker:
   ```bash
   wrangler secret put MP_ACCESS_TOKEN
   # → pega el token de producción (empieza con APP_USR-)
   ```
3. En `index.html` asegurate de que `WORKER_URL` apunte al worker correcto
4. Cambiar en `worker/index.js`:
   - `sandbox_init_point` → `init_point` (para preferencias de pago reales)

---

## Conceptos clave aprendidos

### ¿Por qué Preapproval y no Checkout Pro para suscripciones?

| | Checkout Pro (preferencia) | Preapproval (suscripción) |
|---|---|---|
| **Uso** | Cobro único | Cobro recurrente |
| **Endpoint** | `/checkout/preferences` | `/preapproval` |
| **Renovación** | Manual | Automática por MP |
| **Webhook** | `payment` | `subscription_preapproval` |

### Seguridad: ¿por qué el Worker?

```
❌ MAL: Frontend llama directamente a MP con el Access Token
         → cualquiera puede verlo en DevTools y hacer pagos falsos

✅ BIEN: Frontend → Worker (token oculto) → MP
         → el token solo existe en las variables de entorno de CF
```

### Transacción atómica en Supabase

La función `comprar_obra` usa `FOR UPDATE` para hacer lock de la fila antes de modificar. Esto evita que dos requests simultáneos descuenten créditos dos veces ("double spend").

### RLS (Row Level Security)

Cada usuario solo puede leer/modificar sus propios datos, incluso si alguien intenta hacer queries directos a la API de Supabase con la anon key. Las funciones que requieren service_role (como `agregar_creditos`) solo las puede llamar el Worker.

---

## Variables de entorno resumen

| Variable | Dónde va | Descripción |
|---|---|---|
| `SUPABASE_URL` | Worker secret | URL del proyecto |
| `SUPABASE_SERVICE_KEY` | Worker secret | Service role key (nunca al frontend) |
| `MP_ACCESS_TOKEN` | Worker secret | Token de MP (TEST- o APP_USR-) |
| `APP_URL` | Worker secret | URL del frontend |
| `SUPABASE_URL` (anon) | `index.html` | URL pública |
| `SUPABASE_ANON` | `index.html` | Anon key (pública, con RLS) |
| `WORKER_URL` | `index.html` | URL del Worker |

---

## Próximos pasos para un proyecto real

- [ ] **Email de confirmación** tras suscripción (Resend + Supabase Edge Function)
- [ ] **Panel de admin** para ver usuarios y suscripciones
- [ ] **Cancelación de suscripción** via MP API
- [ ] **Renovación de créditos mensual** via cron job (Supabase Edge Function programada)
- [ ] **Storage de imágenes reales** en Supabase Storage
- [ ] **Dominio propio** en Cloudflare Pages

---

## Links de referencia

- [MercadoPago — Suscripciones (Preapproval)](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/landing)
- [MercadoPago — Checkout Pro](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro/landing)
- [MercadoPago — Webhooks](https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks)
- [Supabase — Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase — Row Level Security](https://supabase.com/docs/guides/auth/row-level-security)
- [Cloudflare Workers — Getting Started](https://developers.cloudflare.com/workers/get-started/guide/)
- [Cloudflare Pages — Deploy](https://developers.cloudflare.com/pages/get-started/)
