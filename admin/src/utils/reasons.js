/**
 * Plain-language explanation of a delivery reason code (provider or
 * MessageGate). Unknown codes return null; the raw code is always shown too.
 *
 * @param {(id: string, def: string) => string} t - Translator.
 * @param {string | null} code - Reason code such as META_131026.
 * @returns {string | null} Explanation.
 */
export function reasonText(t, code) {
  if (!code) return null;
  // Network failures while a send was in flight (undici/Node socket errors).
  if (/^(UND_ERR_|ECONNRESET$|ETIMEDOUT$|EPIPE$|ECONNABORTED$)/.test(code))
    return t('reason.AMBIGUOUS', 'The provider did not answer in time. The message may or may not have been sent.');
  switch (code) {
    case 'HTTP_401':
    case 'HTTP_403':
    case 'TWILIO_20003':
      return t('reason.HTTP_401', 'The provider rejected the credentials. Check them and test again.');
    case 'META_131026':
      return t('reason.META_131026', 'The number cannot receive WhatsApp messages (not on WhatsApp or an old app).');
    case 'META_131047':
      return t(
        'reason.META_131047',
        'More than 24 hours since the last message from the contact. Only templates can be sent.'
      );
    case 'META_131049':
      return t('reason.META_131049', 'Meta held back this marketing message to protect the user experience.');
    case 'META_131050':
      return t('reason.META_131050', 'The contact stopped marketing messages from this business.');
    case 'META_131056':
      return t('reason.META_131056', 'Too many messages to this contact in a short time.');
    case 'META_130429':
      return t('reason.META_130429', 'The WhatsApp throughput limit was reached. MessageGate retries later.');
    case 'META_132001':
      return t('reason.META_132001', 'The template does not exist in this language or is not approved.');
    case 'META_190':
      return t('reason.META_190', 'The Meta access token expired or was revoked. Reconnect the account.');
    case 'TG_403':
      return t('reason.TG_403', 'The contact blocked the bot or never started it.');
    case 'TG_429':
      return t('reason.TG_429', 'Telegram rate limit reached. MessageGate retries later.');
    case 'PUBLIC_URL_MISSING':
      return t(
        'reason.PUBLIC_URL_MISSING',
        'No public URL is configured (server.url), so seven.io has nowhere to send webhooks.'
      );
    case 'PUBLIC_URL_NOT_PUBLIC':
      return t(
        'reason.PUBLIC_URL_NOT_PUBLIC',
        'The public URL (server.url) is not a public https address, so seven.io cannot reach it.'
      );
    case 'WEBHOOK_BUSY':
      return t('reason.WEBHOOK_BUSY', 'Another webhook change for this account is running. Try again in a minute.');
    case 'SEVEN_HOOKS':
      return t('reason.SEVEN_HOOKS', 'seven.io did not accept the webhook request.');
    case 'SEVEN_AUTH':
    case 'SEVEN_900':
      return t('reason.SEVEN_AUTH', 'seven.io rejected the API key.');
    case 'TWILIO_21610':
      return t('reason.TWILIO_21610', 'The recipient replied STOP and unsubscribed.');
    case 'TWILIO_21211':
      return t('reason.TWILIO_21211', 'Twilio considers the number invalid.');
    case 'TWILIO_30003':
      return t('reason.TWILIO_30003', 'The phone is switched off or unreachable.');
    case 'TWILIO_30005':
      return t('reason.TWILIO_30005', 'The number is unknown or no longer exists.');
    case 'TWILIO_30007':
      return t('reason.TWILIO_30007', 'The carrier filtered the message as spam.');
    case 'TWILIO_63036':
      return t('reason.TWILIO_63036', 'The number cannot be reached over RCS (device not RCS capable or offline).');
    case 'TWILIO_63035':
      return t('reason.TWILIO_63035', 'The RCS sender is not approved for this carrier or country yet.');
    case 'TWILIO_30006':
      return t('reason.TWILIO_30006', 'The carrier could not deliver to this number (landline or unreachable).');
    // Provider codes, from the official error references (read 2026-11-20):
    // Meta https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes ,
    // Twilio https://www.twilio.com/docs/api/errors/twilio-error-codes.json ,
    // seven.io https://docs.seven.io/en/rest-api/endpoints/sms (return codes) and
    // https://docs.seven.io/en/rest-api/endpoints/status-reports (delivery reports).
    case 'META_131030':
      return t(
        'reason.META_131030',
        'The recipient is not on the allowed list of the Meta test number. Add it in the App Dashboard under WhatsApp > API Setup.'
      );
    case 'META_133010':
      return t('reason.META_133010', 'The phone number is not registered on the WhatsApp Business Platform yet.');
    case 'META_131031':
      return t(
        'reason.META_131031',
        'Meta restricted or disabled the WhatsApp Business Account for a policy violation.'
      );
    case 'META_131042':
      return t(
        'reason.META_131042',
        'Meta reports a problem with the payment method of the WhatsApp Business Account.'
      );
    case 'META_10':
    case 'META_200':
    case 'META_131005':
    case 'META_3':
      return t(
        'reason.META_PERMISSION',
        'The Meta access token lacks a required permission. Create a token with the WhatsApp permissions.'
      );
    case 'META_4':
    case 'META_80007':
    case 'META_131048':
    case 'META_133016':
      return t(
        'reason.META_RATE_LIMIT',
        'Meta rate limit reached (app, business account or phone number). MessageGate retries later.'
      );
    case 'META_132000':
      return t('reason.META_132000', 'The number of template variables does not match the approved template.');
    case 'META_HELD_FOR_QUALITY_ASSESSMENT':
      return t(
        'reason.META_HELD_FOR_QUALITY_ASSESSMENT',
        'Meta is holding this template message for a quality check (template pacing). Meta sends it or drops it, usually within an hour.'
      );
    case 'META_PAUSED':
      return t(
        'reason.META_PAUSED',
        'Meta paused the delivery of this template message (template pacing). Meta sends it later or drops it.'
      );
    case 'META_132015':
      return t('reason.META_132015', 'Meta paused the template because of low quality.');
    case 'META_132016':
      return t('reason.META_132016', 'Meta disabled the template permanently because of low quality.');
    case 'META_131053':
      return t('reason.META_131053', 'Meta could not download the attachment. Check that its link is public.');
    case 'META_100':
    case 'META_131008':
    case 'META_131009':
      return t(
        'reason.META_INVALID_PARAMETER',
        'Meta rejected a parameter of the request (for example the number format or a template value).'
      );
    case 'META_1':
    case 'META_2':
    case 'META_131000':
      return t(
        'reason.META_UNKNOWN',
        'Meta reported an unknown or temporary error. The message may or may not have been sent.'
      );
    case 'TWILIO_20429':
    case 'TWILIO_21611':
      return t(
        'reason.TWILIO_THROTTLED',
        'Twilio throttled the request (too many requests or a full sender queue). MessageGate retries later.'
      );
    case 'TWILIO_21212':
    case 'TWILIO_21606':
      return t(
        'reason.TWILIO_SENDER',
        'The sender number is not a valid message-capable Twilio number for this account or destination.'
      );
    case 'TWILIO_21408':
      return t('reason.TWILIO_21408', 'SMS to this country is not enabled in the Twilio geo permissions.');
    case 'TWILIO_21612':
      return t('reason.TWILIO_21612', 'Twilio cannot send to this number from this sender.');
    case 'TWILIO_21614':
      return t('reason.TWILIO_21614', 'The number is not a mobile number and cannot receive SMS.');
    case 'TWILIO_30004':
      return t('reason.TWILIO_30004', 'The message was blocked, for example because the recipient blocked the sender.');
    case 'TWILIO_30034':
      return t(
        'reason.TWILIO_30034',
        'The sender number is not registered for A2P 10DLC, which SMS to US numbers require.'
      );
    case 'TWILIO_30008':
      return t('reason.TWILIO_30008', 'The carrier reported an unknown delivery error.');
    case 'SEVEN_201':
      return t('reason.SEVEN_201', 'seven.io rejected the sender ID (at most 11 letters and digits or 16 digits).');
    case 'SEVEN_202':
      return t('reason.SEVEN_202', 'seven.io considers the number invalid.');
    case 'SEVEN_305':
    case 'SEVEN_401':
      return t('reason.SEVEN_TEXT', 'The text is too long or has more parts than the seven.io account allows.');
    case 'SEVEN_402':
      return t(
        'reason.SEVEN_402',
        'seven.io blocked a duplicate: the same SMS went to this number within the last 180 seconds.'
      );
    case 'SEVEN_403':
      return t(
        'reason.SEVEN_403',
        'The daily limit for this recipient at seven.io is reached. MessageGate retries later.'
      );
    case 'SEVEN_407001':
      return t('reason.SEVEN_407001', 'seven.io declined the message.');
    case 'SEVEN_407002':
      return t('reason.SEVEN_407002', 'seven.io blocks SMS to this destination country.');
    case 'SEVEN_407003':
      return t('reason.SEVEN_407003', 'The recipient number is blocked at seven.io.');
    case 'SEVEN_407004':
      return t('reason.SEVEN_407004', 'The recipient unsubscribed at seven.io. Consent for SMS was revoked.');
    case 'SEVEN_407005':
      return t('reason.SEVEN_407005', 'The price per part is above the maximum set in the seven.io account.');
    case 'SEVEN_500':
      return t('reason.SEVEN_500', 'The seven.io account has no credit left.');
    case 'SEVEN_501':
      return t('reason.SEVEN_501', 'The spending limit of the seven.io account is reached.');
    case 'SEVEN_600':
      return t(
        'reason.SEVEN_600',
        'seven.io reported an error while sending. The message may or may not have been sent.'
      );
    case 'SEVEN_901':
      return t('reason.SEVEN_901', 'seven.io could not verify the request signature.');
    case 'SEVEN_902':
      return t('reason.SEVEN_902', 'The seven.io API key has no access to this function.');
    case 'SEVEN_903':
      return t('reason.SEVEN_903', "The server's IP address is not on the seven.io allow list.");
    case 'SEVEN_NOTDELIVERED':
      return t('reason.SEVEN_NOTDELIVERED', 'The SMS could not be delivered. Check the number.');
    case 'SEVEN_EXPIRED':
      return t('reason.SEVEN_EXPIRED', 'The SMS was not delivered before its validity period ended.');
    case 'SEVEN_REJECTED':
      return t('reason.SEVEN_REJECTED', 'The mobile operator rejected the SMS.');
    case 'SEVEN_FAILED':
      return t('reason.SEVEN_FAILED', 'An error occurred while sending the SMS.');
    case 'TG_400':
      return t(
        'reason.TG_400',
        'Telegram refused the message, for example because the chat does not exist or the text is invalid.'
      );
    case 'TG_401':
    case 'TG_404':
      return t('reason.TG_TOKEN', 'Telegram rejected the bot token. Check it and test again.');
    case 'NUMBER_INACTIVE':
      return t('error.NUMBER_INACTIVE', 'The number is not assigned to a subscriber (number check).');
    case 'SANDBOX_REJECTED':
      return t('reason.SANDBOX_REJECTED', 'Sandbox: the test number simulates a provider rejection.');
    case 'TIMEOUT':
    case 'FETCH_ERROR':
    case 'AMBIGUOUS':
    case 'LEASE_EXPIRED_DURING_SEND':
      return t('reason.AMBIGUOUS', 'The provider did not answer in time. The message may or may not have been sent.');
    case 'RETRIES_EXHAUSTED':
      return t('reason.RETRIES_EXHAUSTED', 'Every retry failed.');
    case 'PAYLOAD_UNREADABLE':
      return t('reason.PAYLOAD_UNREADABLE', 'The stored content could not be decrypted (encryption key changed).');
    case 'NO_ACCOUNT':
      return t('error.NO_ACCOUNT', 'No active account can send on this channel.');
    case 'NO_CONSENT':
      return t('error.NO_CONSENT', 'The contact has not given consent for this channel.');
    case 'SUPPRESSED':
      return t('error.SUPPRESSED', 'The contact is blocked for this channel.');
    case 'NOT_LINKED':
      return t('error.NOT_LINKED', 'The contact has not linked Telegram yet.');
    case 'WINDOW_CLOSED':
      return t(
        'error.WINDOW_CLOSED',
        'Free text is only allowed within 24 hours of the last message from the contact. Use a template.'
      );
    case 'TEMPLATE_NOT_APPROVED':
      return t('error.TEMPLATE_NOT_APPROVED', 'Meta has not approved this template yet.');
    case 'EMAIL_FAILED':
      return t('reason.EMAIL_FAILED', 'The email fallback through Magic Mail failed.');
    default:
      return null;
  }
}
