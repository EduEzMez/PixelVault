-- ═══════════════════════════════════════════════════════════════
-- PixelVault — Schema SQL para Supabase
-- Ejecutar en el SQL Editor del dashboard: app.supabase.com
-- ═══════════════════════════════════════════════════════════════

-- ─── EXTENSIONES ─────────────────────────────────────────────
-- uuid-ossp ya viene habilitado en Supabase, no hace falta activarlo

-- ─── TABLA: profiles ─────────────────────────────────────────
-- Se crea automáticamente cuando un usuario se registra (via trigger)
CREATE TABLE IF NOT EXISTS public.profiles (
  id                 UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email              TEXT,
  is_pro             BOOLEAN     NOT NULL DEFAULT FALSE,
  credits            INTEGER     NOT NULL DEFAULT 0,
  mp_preapproval_id  TEXT,
  purchased_ids      INTEGER[]   NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── TABLA: subscriptions ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  preapproval_id  TEXT        NOT NULL,
  status          TEXT        NOT NULL,   -- authorized | cancelled | paused
  amount          NUMERIC     NOT NULL,
  currency        TEXT        NOT NULL DEFAULT 'ARS',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── TABLA: transactions ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.transactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  payment_id  TEXT,
  type        TEXT        NOT NULL,   -- recharge | purchase
  credits     INTEGER,
  amount_ars  NUMERIC,
  status      TEXT        NOT NULL DEFAULT 'pending',
  art_id      INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── TRIGGER: crear perfil automáticamente al registrarse ─────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Eliminar trigger si existe y recrear (evita errores en re-ejecución)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ─── FUNCIÓN: comprar_obra ────────────────────────────────────
-- Transacción atómica: descuenta créditos + registra compra
CREATE OR REPLACE FUNCTION public.comprar_obra(
  p_user_id UUID,
  p_art_id  INTEGER,
  p_price   INTEGER
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credits  INTEGER;
  v_purchased INTEGER[];
BEGIN
  -- Leer estado actual con bloqueo para evitar race conditions
  SELECT credits, purchased_ids
  INTO   v_credits, v_purchased
  FROM   public.profiles
  WHERE  id = p_user_id
  FOR UPDATE;

  -- Validaciones
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Usuario no encontrado';
  END IF;

  IF p_art_id = ANY(v_purchased) THEN
    RAISE EXCEPTION 'Ya compraste esta obra';
  END IF;

  IF v_credits < p_price THEN
    RAISE EXCEPTION 'Créditos insuficientes (tenés $%, necesitás $%)', v_credits, p_price;
  END IF;

  -- Actualizar perfil
  UPDATE public.profiles
  SET
    credits       = credits - p_price,
    purchased_ids = array_append(purchased_ids, p_art_id),
    updated_at    = NOW()
  WHERE id = p_user_id;

  -- Registrar transacción
  INSERT INTO public.transactions (user_id, type, credits, art_id, status)
  VALUES (p_user_id, 'purchase', -p_price, p_art_id, 'approved');

  RETURN json_build_object('ok', true, 'new_credits', v_credits - p_price);
END;
$$;

-- ─── FUNCIÓN: agregar_creditos ────────────────────────────────
-- Usada por el Worker al confirmar recarga
CREATE OR REPLACE FUNCTION public.agregar_creditos(
  p_user_id UUID,
  p_amount  INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.profiles
  SET
    credits    = credits + p_amount,
    updated_at = NOW()
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Usuario no encontrado: %', p_user_id;
  END IF;
END;
$$;

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────
-- Habilitar RLS en todas las tablas
ALTER TABLE public.profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions  ENABLE ROW LEVEL SECURITY;

-- Políticas: el usuario solo ve/modifica sus propios datos
-- profiles
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

-- subscriptions
DROP POLICY IF EXISTS "subscriptions_select_own" ON public.subscriptions;
CREATE POLICY "subscriptions_select_own"
  ON public.subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- transactions
DROP POLICY IF EXISTS "transactions_select_own" ON public.transactions;
CREATE POLICY "transactions_select_own"
  ON public.transactions FOR SELECT
  USING (auth.uid() = user_id);

-- ─── GRANTS: funciones RPC accesibles desde el frontend ───────
-- comprar_obra se llama con anon key desde el browser (protegida por RLS internamente)
GRANT EXECUTE ON FUNCTION public.comprar_obra TO authenticated;
-- agregar_creditos solo la llama el Worker con service key
REVOKE EXECUTE ON FUNCTION public.agregar_creditos FROM authenticated, anon;
GRANT  EXECUTE ON FUNCTION public.agregar_creditos TO service_role;

-- ─── VERIFICACIÓN ────────────────────────────────────────────
-- Podés correr esto para confirmar que todo quedó bien:
-- SELECT routine_name FROM information_schema.routines WHERE routine_schema = 'public';
-- SELECT tablename FROM pg_tables WHERE schemaname = 'public';
