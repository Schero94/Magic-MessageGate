import { useParams } from 'react-router-dom';

import { ConversationView } from './ConversationView';
import { InboxList } from './InboxList';

/**
 * Inbox section: the list of inbound messages at `inbox`, one conversation
 * with a contact at `inbox/:contactId`. Access is gated by
 * `rbac.inbound.read` in App; replies need `rbac.messages.send` and
 * "Mark processed" needs `rbac.inbound.manage`.
 *
 * @returns {JSX.Element} Inbox section.
 */
export const InboxPage = () => {
  const { contactId } = useParams();
  // The key resets scroll position and polling when another contact opens.
  return contactId ? <ConversationView key={contactId} contactId={contactId} /> : <InboxList />;
};

export default InboxPage;
