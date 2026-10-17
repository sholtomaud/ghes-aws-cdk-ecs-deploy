import { useState } from 'react';
import { sendMessage, LOGOUT_PATH } from './api.js';

export default function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setMessages((m) => [...m, { role: 'you', text }]);
    setInput('');
    setBusy(true);
    setError('');
    try {
      const reply = await sendMessage(text);
      setMessages((m) => [...m, { role: 'assistant', text: reply }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <header>
        <h1>Assistant</h1>
        <a href={LOGOUT_PATH}>Sign out</a>
      </header>
      <ol className="messages" aria-live="polite">
        {messages.map((m, i) => (
          <li key={i} className={m.role}><strong>{m.role === 'you' ? 'You' : 'Assistant'}:</strong> {m.text}</li>
        ))}
      </ol>
      {error && <p role="alert" className="error">{error}</p>}
      <form onSubmit={onSubmit}>
        <label htmlFor="message">Message</label>
        <textarea id="message" value={input} maxLength={4000} onChange={(e) => setInput(e.target.value)} rows={3} />
        <button type="submit" disabled={busy || !input.trim()}>{busy ? 'Thinking…' : 'Send'}</button>
      </form>
    </main>
  );
}
