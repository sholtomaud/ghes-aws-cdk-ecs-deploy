export const LOGOUT_PATH = '/api/logout';

/** Send one chat message. The ALB session cookie authenticates the request; no tokens are handled here. */
export async function sendMessage(message, fetchImpl = fetch) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('Message is empty');
  const res = await fetchImpl('/api/chat', {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (res.type === 'opaqueredirect' || res.status === 401) throw new Error('Your session has expired. Reload the page to sign in again.');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body.reply;
}
