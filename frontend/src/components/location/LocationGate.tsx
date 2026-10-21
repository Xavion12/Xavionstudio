import { LocateFixed, LogOut, MapPin, MapPinOff, RefreshCw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { LogoMark } from '@/components/brand/Logo'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useAuth } from '@/contexts/AuthContext'
import { useConfig, useConfigActions } from '@/contexts/ConfigContext'
import { useToast } from '@/contexts/ToastContext'
import { onLocationRequired } from '@/services/api'
import { authApi, settingsApi } from '@/services/endpoints'

/**
 * Location is compulsory (Settings → Device location): nothing in the app opens until this device
 * has shared its GPS location, and it keeps sharing while the app is open (when it moves 100 m,
 * and at least every 5 minutes). If the permission is turned off, the app locks again.
 */
type State = 'checking' | 'consent' | 'locating' | 'ok' | 'denied' | 'unavailable' | 'unsupported'

const MOVE_METRES = 100
const RESEND_MS = 5 * 60_000
const CONSENT_KEY = 'xavion.location-consent'

// Kept across screens (and layouts) for the signed-in user: the gate only asks once per sign-in.
let sharedFor: number | null = null

function metres(a: GeolocationCoordinates, b: GeolocationCoordinates): number {
  const rad = Math.PI / 180
  const dLat = (b.latitude - a.latitude) * rad
  const dLng = (b.longitude - a.longitude) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2
  return 6_371_000 * 2 * Math.asin(Math.sqrt(h))
}

function consented(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1'
  } catch {
    return false
  }
}

export function LocationGate({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  const { location_required } = useConfig()
  const required = location_required !== false
  const userId = user?.id ?? null
  const [state, setState] = useState<State>(() => (sharedFor !== null && sharedFor === userId ? 'ok' : 'checking'))
  const last = useRef<{ coords: GeolocationCoordinates; at: number } | null>(null)
  const watch = useRef<number | null>(null)

  const send = useCallback(async (position: GeolocationPosition) => {
    const { coords } = position
    const previous = last.current
    if (previous && metres(previous.coords, coords) < MOVE_METRES && Date.now() - previous.at < RESEND_MS) return
    last.current = { coords, at: Date.now() }
    await authApi.shareLocation({ lat: coords.latitude, lng: coords.longitude, accuracy: Number.isFinite(coords.accuracy) ? coords.accuracy : null })
  }, [])

  const startWatching = useCallback(() => {
    if (watch.current !== null || !('geolocation' in navigator)) return
    watch.current = navigator.geolocation.watchPosition(
      (position) => void send(position).catch(() => undefined),
      (error) => {
        if (error.code === error.PERMISSION_DENIED && required) setState('denied')
      },
      { enableHighAccuracy: true, maximumAge: 60_000 },
    )
  }, [send, required])

  const locate = useCallback(() => {
    if (!('geolocation' in navigator)) return setState('unsupported')
    setState('locating')
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          last.current = null
          await send(position)
          try {
            localStorage.setItem(CONSENT_KEY, '1')
          } catch {
            // private mode: the browser permission still remembers the choice
          }
          sharedFor = userId
          setState('ok')
          startWatching()
        } catch {
          setState('unavailable')
        }
      },
      (error) => setState(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 30_000 },
    )
  }, [send, startWatching, userId])

  // First check: is the permission already granted / refused?
  useEffect(() => {
    if (!required || !userId) return
    if (sharedFor === userId) {
      startWatching()
      return
    }
    if (!('geolocation' in navigator)) return setState('unsupported')
    let cancelled = false
    const permissions = navigator.permissions?.query?.({ name: 'geolocation' as PermissionName })
    if (!permissions) {
      if (consented()) locate()
      else setState('consent')
      return
    }
    permissions
      .then((status) => {
        if (cancelled) return
        if (status.state === 'granted') locate()
        else if (status.state === 'denied') setState('denied')
        else setState('consent')
        // Turned off later in the browser / phone settings: lock the app again.
        status.onchange = () => {
          if (status.state === 'denied') {
            sharedFor = null
            setState('denied')
          } else if (status.state === 'granted') locate()
        }
      })
      .catch(() => setState('consent'))
    return () => {
      cancelled = true
    }
  }, [required, userId, locate, startWatching])

  // The server says this device hasn't shared yet (e.g. after signing in again elsewhere).
  useEffect(() => {
    if (!required) return
    onLocationRequired(() => {
      sharedFor = null
      locate()
    })
    return () => onLocationRequired(null)
  }, [required, locate])

  useEffect(
    () => () => {
      if (watch.current !== null) navigator.geolocation.clearWatch(watch.current)
      watch.current = null
    },
    [],
  )

  if (!required || state === 'ok') return <>{children}</>
  return <LocationScreen state={state} onAllow={locate} onSignOut={logout} isAdmin={user?.role === 'ADMIN'} />
}

function LocationScreen({ state, onAllow, onSignOut, isAdmin }: { state: State; onAllow: () => void; onSignOut: () => void; isAdmin: boolean }) {
  const { gym_name } = useConfig()
  const { applyConfig } = useConfigActions()
  const toast = useToast()
  const [turningOff, setTurningOff] = useState(false)
  const gym = gym_name || 'The gym'

  const turnOff = async () => {
    if (!window.confirm('Turn off the location requirement for everyone? You can turn it back on in Settings → Gym.')) return
    setTurningOff(true)
    try {
      await settingsApi.update({ location_required: false })
      applyConfig({ location_required: false })
      toast.success('Location is no longer required')
    } catch (error) {
      toast.fromError(error)
    } finally {
      setTurningOff(false)
    }
  }

  if (state === 'checking' || state === 'locating') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-canvas px-4 text-sm text-muted" role="status">
        <LogoMark className="size-12 animate-pulse" />
        {state === 'locating' ? 'Getting this device’s location…' : 'Checking location access…'}
      </div>
    )
  }

  const blocked = state === 'denied' || state === 'unavailable' || state === 'unsupported'
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <Card className="w-full max-w-md space-y-5 p-6">
        <div className="text-center">
          <span
            className={
              blocked
                ? 'mx-auto flex size-14 items-center justify-center rounded-2xl bg-danger-50 text-danger-600 dark:bg-danger-500/15 dark:text-danger-300'
                : 'mx-auto flex size-14 items-center justify-center rounded-2xl bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300'
            }
          >
            {blocked ? <MapPinOff className="size-6" aria-hidden /> : <MapPin className="size-6" aria-hidden />}
          </span>
          <h1 className="mt-4 text-xl font-bold text-ink">
            {state === 'denied' ? 'Location is turned off' : state === 'unsupported' ? 'Location isn’t available here' : state === 'unavailable' ? 'Couldn’t find your location' : 'Share your location to continue'}
          </h1>
          <p className="mt-2 text-sm text-muted">
            {gym} requires every phone and computer using this app to share its location. It protects your account: the gym can see where
            the app is being used and spot sign-ins from unexpected places.
          </p>
        </div>

        <ul className="space-y-2 rounded-2xl border border-line bg-subtle p-4 text-[13px] text-ink-2">
          <li className="flex gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            Only the gym’s admin can see it, on the Security page.
          </li>
          <li className="flex gap-2">
            <LocateFixed className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            Shared while the app is open (not in the background), and kept up to 90 days after you sign out.
          </li>
        </ul>

        {state === 'denied' ? (
          <div className="space-y-2 text-[13px] text-ink-2">
            <p className="font-semibold text-ink">Turn location back on, then tap Try again:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Browser: tap the lock / settings icon next to the address → Location → Allow.</li>
              <li>Android: Settings → Location → On, and allow it for your browser.</li>
              <li>iPhone: Settings → Privacy &amp; Security → Location Services → Safari Websites → While Using.</li>
            </ul>
          </div>
        ) : state === 'unavailable' ? (
          <p className="text-[13px] text-ink-2">Make sure location (GPS) is on, or move near a window, then try again.</p>
        ) : state === 'unsupported' ? (
          <p className="text-[13px] text-ink-2">This browser can’t share a location. Open the app in Chrome, Safari or Edge.</p>
        ) : null}

        <div className="grid gap-2">
          {state !== 'unsupported' && (
            <Button size="lg" icon={state === 'consent' ? MapPin : RefreshCw} onClick={onAllow}>
              {state === 'consent' ? 'Allow location' : 'Try again'}
            </Button>
          )}
          <Button size="lg" variant="secondary" icon={LogOut} onClick={onSignOut}>
            Sign out
          </Button>
          {isAdmin && (
            <button type="button" onClick={turnOff} disabled={turningOff} className="mt-1 text-[13px] font-medium text-muted underline-offset-2 hover:underline">
              Admin: turn off the location requirement
            </button>
          )}
        </div>
        <p className="text-center text-[12px] text-muted">By allowing, you agree to share this device’s location with {gym} for account security.</p>
      </Card>
    </main>
  )
}
