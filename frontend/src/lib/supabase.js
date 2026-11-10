import { createClient } from '@supabase/supabase-js'
import { api } from './api.js'

// The browser only receives Supabase's publishable/anon key. The service role key stays in the
// API container and is used there to exchange a Supabase session for MuseFit's existing session.
const url = String(import.meta.env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '')
const anonKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim()

export const supabaseConfigured = !!(url && anonKey)
export const supabase = supabaseConfigured ? createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
}) : null

export async function exchangeSupabaseSession(session) {
  const token = session?.access_token
  if (!token) throw Object.assign(new Error('Sessão do Supabase ausente.'), { code: 'missing-session' })
  const result = await api('/api/auth/supabase', {
    method: 'POST',
    body: JSON.stringify({ access_token: token }),
  })
  return result.user
}

// Restores the MuseFit cookie after a browser refresh, an OAuth redirect, or cookie expiry. The
// app's existing API/session model remains the source of truth for workout data and permissions.
export async function exchangeStoredSupabaseSession() {
  if (!supabase) return null
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) return null
  return exchangeSupabaseSession(data.session)
}

export async function signOutSupabase() {
  if (!supabase) return
  await supabase.auth.signOut()
}

