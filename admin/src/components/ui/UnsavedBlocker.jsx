/* Pattern from plugin-io admin/src/pages/Settings/index.jsx (DraftSync). Keep in sync. */
import { useEffect } from 'react';
import { Blocker, Form, useForm } from '@strapi/strapi/admin';

/** Mirrors the draft into Strapi's Form so the native Blocker sees unsaved changes. */
const DraftSync = ({ values }) => {
  const setValues = useForm('DraftSync', (state) => state.setValues);
  useEffect(() => {
    setValues(values);
  }, [values, setValues]);
  return null;
};

/**
 * Native Strapi unsaved-changes dialog on navigation. The page keeps its own
 * form state; this hidden Form only compares `saved` with `draft`. It has no
 * inputs, so pressing Enter elsewhere never submits it.
 *
 * @param {{ saved: object, draft: object }} props - Last saved and current values.
 * @returns {JSX.Element} Blocker.
 */
export const UnsavedBlocker = ({ saved, draft }) => (
  <Form method="PUT" initialValues={saved}>
    <DraftSync values={draft} />
    <Blocker />
  </Form>
);
