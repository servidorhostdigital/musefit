// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const state = {
    config: { allow_guest: true },
    session: { access_token: 'token-1' },
    setUser: vi.fn(),
    adoptProfile: vi.fn(async () => ({})),
    setGuest: vi.fn(),
    exchange: vi.fn(async () => ({ id: 'u1', name: 'Ana' })),
    signInWithPassword: vi.fn(async () => ({ data: { session: state.session }, error: null })),
    signUp: vi.fn(async () => ({ data: { session: state.session }, error: null })),
    signInWithOAuth: vi.fn(async () => ({ error: null })),
    resetPasswordForEmail: vi.fn(async () => ({ error: null })),
    updateUser: vi.fn(async () => ({ error: null })),
    getSession: vi.fn(async () => ({ data: { session: state.session } })),
  }
  state.supabase = { auth: {
    signInWithPassword: (...args) => state.signInWithPassword(...args),
    signUp: (...args) => state.signUp(...args),
    signInWithOAuth: (...args) => state.signInWithOAuth(...args),
    resetPasswordForEmail: (...args) => state.resetPasswordForEmail(...args),
    updateUser: (...args) => state.updateUser(...args),
    getSession: (...args) => state.getSession(...args),
  } }
  state.snapshot = () => ({ config: state.config, setUser: state.setUser, adoptProfile: state.adoptProfile, setGuest: state.setGuest })
  return state
})

vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore }
})
vi.mock('../store/useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn() }) } }))
vi.mock('../lib/supabase.js', () => ({
  supabaseConfigured: true,
  supabase: mocks.supabase,
  exchangeSupabaseSession: (...args) => mocks.exchange(...args),
  signOutSupabase: vi.fn(async () => {}),
}))
vi.mock('../lib/demo.js', () => ({ DEMO: false, REPO: 'https://example.invalid' }))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn() }))

const { default: Login } = await import('./Login.jsx')

const mounted = []
function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(<Login />))
  return host
}
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const fill = (host, placeholder, value) => {
  const el = host.querySelector(`input[placeholder="${placeholder}"]`)
  act(() => {
    Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const submit = async host => act(async () => { host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve() })

beforeEach(() => {
  mocks.config = { allow_guest: true }
  mocks.exchange.mockClear(); mocks.setUser.mockClear(); mocks.adoptProfile.mockClear(); mocks.setGuest.mockClear()
  mocks.signInWithPassword.mockClear(); mocks.signUp.mockClear(); mocks.signInWithOAuth.mockClear(); mocks.resetPasswordForEmail.mockClear()
})
afterEach(() => act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }))

describe('MuseFit authentication', () => {
  it('shows e-mail/password and Google without passkeys', () => {
    const page = mount()
    expect(page.textContent).toContain('MuseFit')
    expect(page.querySelector('img.mf-brand-logo[alt="MuseFit"]')).toBeTruthy()
    expect(page.textContent).toContain('Entrar com Google')
    expect(page.querySelector('input[autocomplete="email"]')).toBeTruthy()
    expect(page.querySelector('input[autocomplete="current-password"]')).toBeTruthy()
    expect(page.textContent).toContain('Esqueci minha senha')
    expect(page.textContent).not.toContain('chave de acesso')
    expect(page.textContent).not.toContain('openGym')
  })

  it('switches to a separate registration screen', () => {
    const page = mount()
    act(() => button(page, 'Criar conta').click())
    expect(page.textContent).toContain('Crie sua conta')
    expect(page.querySelector('input[autocomplete="name"]')).toBeTruthy()
    expect(page.querySelector('input[autocomplete="new-password"]')).toBeTruthy()
    expect(page.textContent).toContain('Cadastrar com Google')
  })

  it('opens password recovery', () => {
    const page = mount()
    act(() => button(page, 'Esqueci minha senha').click())
    expect(page.textContent).toContain('Recupere seu acesso')
    expect(button(page, 'Enviar link de recuperação')).toBeTruthy()
    expect(page.querySelector('input[autocomplete="email"]')).toBeTruthy()
  })

  it('exchanges a Supabase e-mail session for a MuseFit session', async () => {
    const page = mount()
    fill(page, 'voce@exemplo.com', 'ana@example.com')
    fill(page, 'Mínimo de 8 caracteres', 'correct horse battery')
    await submit(page)
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({ email: 'ana@example.com', password: 'correct horse battery' })
    expect(mocks.exchange).toHaveBeenCalledWith(mocks.session)
    expect(mocks.setUser).toHaveBeenCalledWith({ id: 'u1', name: 'Ana' }, { adopt: true })
    expect(mocks.adoptProfile).toHaveBeenCalled()
  })

  it('starts Google OAuth directly from the primary button', async () => {
    const page = mount()
    await act(async () => { button(page, 'Entrar com Google').click(); await Promise.resolve() })
    expect(mocks.signInWithOAuth).toHaveBeenCalledWith({ provider: 'google', options: { redirectTo: window.location.origin } })
  })
})

