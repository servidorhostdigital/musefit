import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { DEMO, REPO } from '../lib/demo.js'
import { guestAllowed } from '../lib/guest.js'
import { askAddDeviceData } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import {
  exchangeSupabaseSession,
  signOutSupabase,
  supabase,
  supabaseConfigured,
} from '../lib/supabase.js'
import './Login.css'

function GoogleMark() {
  return (
    <svg className="mf-google-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M21.35 12.23c0-.7-.06-1.38-.18-2.03H12v3.84h5.24a4.48 4.48 0 0 1-1.94 2.94v2.45h3.14c1.84-1.7 2.91-4.2 2.91-7.2Z" />
      <path fill="#34A853" d="M12 21.6c2.63 0 4.84-.87 6.45-2.37l-3.14-2.45c-.87.58-1.98.92-3.31.92-2.54 0-4.69-1.72-5.46-4.03H3.3v2.53A9.74 9.74 0 0 0 12 21.6Z" />
      <path fill="#FBBC05" d="M6.54 13.67a5.85 5.85 0 0 1 0-3.34V7.8H3.3a9.72 9.72 0 0 0 0 8.4l3.24-2.53Z" />
      <path fill="#EA4335" d="M12 6.3c1.43 0 2.71.49 3.72 1.45l2.79-2.79C16.84 3.4 14.63 2.4 12 2.4A9.74 9.74 0 0 0 3.3 7.8l3.24 2.53C7.31 8.02 9.46 6.3 12 6.3Z" />
    </svg>
  )
}
function authMessage(error) {
  const msg = String(error?.message || '').toLowerCase()
  if (msg.includes('invalid login credentials')) return 'E-mail ou senha incorretos.'
  if (msg.includes('email not confirmed')) return 'Confirme seu e-mail antes de entrar.'
  if (msg.includes('user already registered')) return 'Este e-mail já está cadastrado.'
  if (msg.includes('password should be at least')) return 'Use uma senha mais forte, com pelo menos 8 caracteres.'
  if (msg.includes('provider is not enabled') || msg.includes('unsupported provider')) return 'O login com Google ainda não foi ativado no Supabase.'
  if (error?.status === 401) return 'Não foi possível validar sua sessão. Tente novamente.'
  return error?.message || 'Não foi possível concluir. Tente novamente.'
}

function AuthInput({ label, type = 'text', value, onChange, placeholder, autoComplete, required = true }) {
  return (
    <label className="mf-auth-field">
      <span>{label}</span>
      <input
        className="mf-auth-input"
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        minLength={type === 'password' ? 8 : undefined}
      />
    </label>
  )
}
function BrandMark({ compact = false }) {
  return (
    <div className={'mf-brand' + (compact ? ' compact' : '')}>
      <img className="mf-brand-logo" src="/musefit-logo.png" alt="MuseFit" />
    </div>
  )
}

function Feature({ icon, title, text }) {
  return (
    <div className="mf-auth-feature">
      <span className="mf-feature-icon"><Icon name={icon} /></span>
      <span><strong>{title}</strong><small>{text}</small></span>
    </div>
  )
}

export default function Login() {
  const { setUser, adoptProfile, setGuest } = useStore()
  const config = useStore(s => s.config)
  const canGuest = guestAllowed(config)
  const recovery = new URLSearchParams(window.location.search).get('reset') === '1'
  const [mode, setMode] = useState(recovery ? 'recover' : 'signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const resetMessages = () => { setError(''); setNotice('') }
  const goTo = next => { resetMessages(); setMode(next) }

  const completeSession = async session => {
    const user = await exchangeSupabaseSession(session)
    setUser(user, { adopt: true })
    await adoptProfile(askAddDeviceData)
    useUI.getState().toast(`Bem-vindo de volta, ${user.name}`)
  }

  const submit = async event => {
    event.preventDefault()
    if (busy) return
    resetMessages()
    if (!supabaseConfigured || !supabase) {
      setError('O login ainda não foi configurado no ambiente de produção.')
      return
    }
    if (mode === 'signup' && password !== repeat) {
      setError('As senhas não coincidem.')
      return
    }
    setBusy(true)
    try {
      if (mode === 'signin') {
        const { data, error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (signInError) throw signInError
        if (!data.session) throw new Error('Não foi possível criar a sessão.')
        await completeSession(data.session)
      } else if (mode === 'signup') {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { full_name: name.trim(), name: name.trim() },
            emailRedirectTo: window.location.origin,
          },
        })
        if (signUpError) throw signUpError
        if (!data.session) {
          setNotice('Cadastro criado. Confira seu e-mail para confirmar a conta e depois entre no MuseFit.')
          setMode('signin')
        } else await completeSession(data.session)
      } else if (mode === 'forgot') {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}/?reset=1`,
        })
        if (resetError) throw resetError
        setNotice('Enviamos um link de recuperação para o seu e-mail.')
      } else {
        if (password.length < 8) throw new Error('Use uma senha com pelo menos 8 caracteres.')
        if (password !== repeat) throw new Error('As senhas não coincidem.')
        const { error: updateError } = await supabase.auth.updateUser({ password })
        if (updateError) throw updateError
        const { data } = await supabase.auth.getSession()
        if (!data.session) throw new Error('O link de recuperação expirou. Solicite outro.')
        window.history.replaceState({}, '', window.location.pathname)
        await completeSession(data.session)
      }
    } catch (e) {
      setError(authMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const google = async () => {
    if (busy) return
    resetMessages()
    if (!supabaseConfigured || !supabase) {
      setError('O login com Google ainda não foi configurado no ambiente de produção.')
      return
    }
    setBusy(true)
    try {
      const { error: googleError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      })
      if (googleError) throw googleError
    } catch (e) {
      setBusy(false)
      setError(authMessage(e))
    }
  }

  const signOutGoogle = async () => {
    try { await signOutSupabase() } catch { /* no active Supabase session */ }
  }

  if (DEMO) return (
    <div className="mf-auth-screen mf-demo-auth">
      <div className="mf-auth-card mf-demo-card">
        <BrandMark compact />
        <h1>Seu treino, no seu ritmo.</h1>
        <p>Esta é a demonstração do MuseFit. Tudo fica salvo neste navegador.</p>
        <button className="mf-auth-btn primary" type="button" onClick={() => setGuest(true)}>Começar demonstração</button>
        <a href={REPO} target="_blank" rel="noopener" className="mf-auth-link">Conheça o projeto →</a>
      </div>
    </div>
  )

  const title = mode === 'signup' ? 'Crie sua conta' : mode === 'forgot' ? 'Recupere seu acesso' : mode === 'recover' ? 'Defina uma nova senha' : 'Bem-vindo de volta'
  const subtitle = mode === 'signup' ? 'Comece a acompanhar sua evolução de um jeito mais inteligente.' : mode === 'forgot' ? 'Informe seu e-mail e enviaremos um link seguro para você voltar.' : mode === 'recover' ? 'Escolha uma senha nova para continuar treinando.' : 'Seu treino organizado. Sua evolução visível.'

  return (
    <div className="mf-auth-screen">
      <div className="mf-auth-shell">
        <aside className="mf-auth-story">
          <BrandMark />
          <div className="mf-story-copy">
            <p className="mf-eyebrow">TREINE COM PROPÓSITO</p>
            <h1>Consistência transforma esforço em <em>resultado.</em></h1>
            <p className="mf-story-text">Planeje seus treinos, acompanhe cargas e enxergue sua evolução em um só lugar.</p>
          </div>
          <div className="mf-auth-features">
            <Feature icon="chartLine" title="Evolução clara" text="Veja o que está funcionando." />
            <Feature icon="target" title="Treino com foco" text="Organize sua rotina sem distração." />
            <Feature icon="shield" title="Seus dados protegidos" text="Acesso seguro em qualquer dispositivo." />
          </div>
          <div className="mf-story-orbit" aria-hidden="true"><span /><span /><span /></div>
        </aside>

        <main className="mf-auth-panel">
          <div className="mf-auth-card">
            <div className="mf-mobile-brand"><BrandMark compact /></div>
            <div className="mf-auth-heading">
              <p className="mf-auth-kicker">MUSEFIT</p>
              <h2>{title}</h2>
              <p>{subtitle}</p>
            </div>

            {mode !== 'forgot' && mode !== 'recover' && (
              <button className="mf-auth-btn google" type="button" onClick={google} disabled={busy}>
                <GoogleMark />
                {mode === 'signup' ? 'Cadastrar com Google' : 'Entrar com Google'}
              </button>
            )}

            {mode !== 'forgot' && mode !== 'recover' && <div className="mf-auth-divider"><span>ou continue com e-mail</span></div>}

            <form className="mf-auth-form" onSubmit={submit} noValidate>
              {mode === 'signup' && <AuthInput label="Seu nome" value={name} onChange={e => setName(e.target.value)} placeholder="Como devemos chamar você?" autoComplete="name" />}
              {mode !== 'recover' && <AuthInput label="E-mail" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="voce@exemplo.com" autoComplete="email" />}
              {mode !== 'forgot' && <AuthInput label={mode === 'recover' ? 'Nova senha' : 'Senha'} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Mínimo de 8 caracteres" autoComplete={mode === 'recover' || mode === 'signup' ? 'new-password' : 'current-password'} />}
              {(mode === 'signup' || mode === 'recover') && <AuthInput label="Confirme sua senha" type="password" value={repeat} onChange={e => setRepeat(e.target.value)} placeholder="Digite novamente sua senha" autoComplete="new-password" />}
              {error && <div className="mf-auth-feedback error" role="alert"><Icon name="warning" />{error}</div>}
              {notice && <div className="mf-auth-feedback success" role="status"><Icon name="checkCircle" />{notice}</div>}
              {mode === 'forgot' ? (
                <button className="mf-auth-btn primary" type="submit" disabled={busy}>{busy ? 'Enviando link…' : 'Enviar link de recuperação'}</button>
              ) : (
                <button className="mf-auth-btn primary" type="submit" disabled={busy}>{busy ? 'Aguarde…' : mode === 'signup' ? 'Criar minha conta' : mode === 'recover' ? 'Salvar nova senha' : 'Entrar'}</button>
              )}
            </form>

            <div className="mf-auth-actions">
              {mode === 'signin' && <button type="button" className="mf-auth-text-btn" onClick={() => goTo('forgot')}>Esqueci minha senha</button>}
              {mode === 'forgot' && <button type="button" className="mf-auth-text-btn" onClick={() => goTo('signin')}>Voltar para o login</button>}
              {mode === 'recover' && <button type="button" className="mf-auth-text-btn" onClick={() => { signOutGoogle(); window.history.replaceState({}, '', window.location.pathname); goTo('signin') }}>Cancelar</button>}
              {(mode === 'signin' || mode === 'signup') && <p>{mode === 'signin' ? 'Ainda não tem uma conta?' : 'Já tem uma conta?'} <button type="button" className="mf-auth-inline-btn" onClick={() => goTo(mode === 'signin' ? 'signup' : 'signin')}>{mode === 'signin' ? 'Criar conta' : 'Entrar'}</button></p>}
            </div>

            {canGuest && mode === 'signin' && <button type="button" className="mf-auth-guest" onClick={() => setGuest(true)}>Explorar sem conta</button>}
            <p className="mf-auth-legal">Ao continuar, você concorda com os termos de uso do MuseFit.</p>
          </div>
        </main>
      </div>
    </div>
  )
}
