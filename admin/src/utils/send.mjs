/**
 * Client-side checks of the send form. They only catch obvious mistakes;
 * the server validates the number (libphonenumber) and the template.
 */

const PHONE = /^\+?[0-9 ()./-]{6,40}$/;

/**
 * @param {{to: string, template: string, text: string, isText: boolean, variables: Record<string, string>}} form - Form.
 * @param {Array<{name: string, required?: boolean}>} variables - Variables of the chosen template.
 * @returns {Record<string, 'required' | 'phone' | 'content'>} Errors by field.
 */
export function validateSend(form, variables = []) {
  const errors = {};
  const to = String(form.to || '').trim();
  if (!to) errors.to = 'required';
  else if (!PHONE.test(to) || to.replace(/\D/g, '').length < 6) errors.to = 'phone';
  if (form.isText) {
    if (!String(form.text || '').trim()) errors.text = 'required';
  } else if (!form.template) errors.template = 'content';
  else
    for (const v of variables)
      if (v.required !== false && !String(form.variables?.[v.name] ?? '').trim()) errors[`var.${v.name}`] = 'required';
  return errors;
}
