import { useCallback, useEffect, useState } from 'react';

const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';
const LOAD_TIMEOUT_MS = 10_000;
const SESSION_EVENTS = ['FINISH', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'];

let sdkPromise = null;

/**
 * Loads the Facebook JS SDK once per page. Rejects when the SDK is blocked
 * (content security policy, ad blocker, offline) so the wizard can fall
 * back to manual credentials.
 *
 * @param {{appId: string, graphVersion: string}} options - SDK options.
 * @returns {Promise<any>} window.FB.
 */
function loadSdk({ appId, graphVersion }) {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    if (window.FB) {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: graphVersion });
      resolve(window.FB);
      return;
    }
    const timer = setTimeout(() => reject(new Error('SDK_TIMEOUT')), LOAD_TIMEOUT_MS);
    window.fbAsyncInit = () => {
      clearTimeout(timer);
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: graphVersion });
      resolve(window.FB);
    };
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error('SDK_BLOCKED'));
    };
    document.body.appendChild(script);
  }).catch((error) => {
    sdkPromise = null;
    throw error;
  });
  return sdkPromise;
}

/**
 * Parses a postMessage from Meta's Embedded Signup popup.
 *
 * @param {MessageEvent} event - Window message.
 * @returns {null | {event: string, data: object}} Session info or null when unrelated.
 */
export function parseSignupMessage(event) {
  let origin;
  try {
    origin = new URL(event.origin).hostname;
  } catch {
    return null;
  }
  if (origin !== 'facebook.com' && !origin.endsWith('.facebook.com')) return null;
  let payload = event.data;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || payload.type !== 'WA_EMBEDDED_SIGNUP') return null;
  return { event: String(payload.event || ''), data: payload.data || {} };
}

/**
 * Meta Embedded Signup (Facebook Login for Business with a WhatsApp
 * configuration). The SDK loads when the hook mounts so `launch` runs inside
 * the click (popup blockers allow only user-initiated windows).
 *
 * The flow also offers the WhatsApp Business App path (Coexistence: the
 * owner scans a QR code with the app and keeps using it).
 *
 * @param {{appId: string | null, configId: string | null, graphVersion: string, enabled: boolean}} config - Public config.
 * @returns {{status: 'idle' | 'loading' | 'ready' | 'blocked', launch: () => Promise<{code: string, event: string, wabaId: string, phoneNumberId: string, businessId?: string}>}} API.
 * @see https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation
 * @see https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users
 */
export function useEmbeddedSignup(config) {
  const [status, setStatus] = useState(config?.enabled ? 'loading' : 'idle');
  const { appId, configId, graphVersion, enabled } = config || {};

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    loadSdk({ appId, graphVersion }).then(
      () => alive && setStatus('ready'),
      () => alive && setStatus('blocked')
    );
    return () => {
      alive = false;
    };
  }, [appId, graphVersion, enabled]);

  const launch = useCallback(
    () =>
      new Promise((resolve, reject) => {
        let code = null;
        let session = null;
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          window.removeEventListener('message', onMessage);
          fn(value);
        };
        const tryResolve = () => {
          if (code && session)
            finish(resolve, {
              code,
              event: session.event,
              wabaId: String(session.data.waba_id || ''),
              phoneNumberId: String(session.data.phone_number_id || ''),
              businessId: session.data.business_id ? String(session.data.business_id) : undefined,
            });
        };
        function onMessage(event) {
          const parsed = parseSignupMessage(event);
          if (!parsed) return;
          if (SESSION_EVENTS.includes(parsed.event)) {
            session = parsed;
            tryResolve();
          } else if (parsed.event === 'CANCEL')
            finish(reject, Object.assign(new Error('CANCELLED'), { step: parsed.data.current_step }));
          else if (parsed.event === 'ERROR')
            finish(reject, Object.assign(new Error('SIGNUP_ERROR'), { reason: parsed.data.error_message }));
          else if (parsed.event.startsWith('FINISH'))
            finish(reject, Object.assign(new Error('NO_NUMBER'), { event: parsed.event }));
        }
        window.addEventListener('message', onMessage);
        window.FB.login(
          (response) => {
            if (response?.authResponse?.code) {
              code = response.authResponse.code;
              // The session message can arrive just after the login callback.
              setTimeout(() => (session ? tryResolve() : finish(reject, new Error('NO_SESSION'))), 5000);
              tryResolve();
            } else finish(reject, new Error('CANCELLED'));
          },
          {
            config_id: configId,
            response_type: 'code',
            override_default_response_type: true,
            extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' },
          }
        );
      }),
    [configId]
  );

  return { status, launch };
}
