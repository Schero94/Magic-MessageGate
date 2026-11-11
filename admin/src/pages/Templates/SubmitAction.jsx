import { useState } from 'react';
import { Button, Dialog, Field, Flex, SingleSelect, SingleSelectOption, Typography } from '@strapi/design-system';
import { ConfirmDialog } from '@strapi/strapi/admin';

/**
 * Header action that hands a saved template to its provider: "Submit to
 * Meta" for WhatsApp, "Create on Twilio" for RCS rich cards. Opens a dialog
 * with the account choice (shown when there is more than one) and keeps it
 * open while the request runs and after an error.
 *
 * @param {object} props - Props.
 * @param {object[]} props.accounts - Accounts that can take the template; the first default one is preselected.
 * @param {boolean} props.disabled - Disabled (unsaved changes).
 * @param {JSX.Element} props.icon - Trigger icon.
 * @param {{ trigger: string, title: string, body: string, confirm: string, account: string }} props.labels - Translated texts.
 * @param {(accountId: string) => Promise<void>} props.onSubmit - Runs the request; throws to keep the dialog open.
 * @returns {JSX.Element} Trigger and dialog.
 */
export const SubmitAction = ({ accounts, disabled, icon, labels, onSubmit }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accountId, setAccountId] = useState(() => (accounts.find((a) => a.isDefault) || accounts[0])?.id);
  const run = async () => {
    setBusy(true);
    try {
      await onSubmit(accountId);
      setOpen(false);
    } catch {
      // notified
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <Dialog.Trigger>
        <Button variant="secondary" startIcon={icon} disabled={disabled}>
          {labels.trigger}
        </Button>
      </Dialog.Trigger>
      <ConfirmDialog
        title={labels.title}
        variant="default"
        endAction={
          <Button fullWidth onClick={run} loading={busy} disabled={!accountId}>
            {labels.confirm}
          </Button>
        }
      >
        <Flex direction="column" alignItems="stretch" gap={4}>
          <Typography>{labels.body}</Typography>
          {accounts.length > 1 ? (
            <Field.Root name="accountId">
              <Field.Label>{labels.account}</Field.Label>
              <SingleSelect value={accountId} onChange={setAccountId}>
                {accounts.map((a) => (
                  <SingleSelectOption key={a.id} value={a.id}>
                    {a.name}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
            </Field.Root>
          ) : null}
        </Flex>
      </ConfirmDialog>
    </Dialog.Root>
  );
};
