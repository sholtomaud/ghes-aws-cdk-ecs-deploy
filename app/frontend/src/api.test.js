import { describe, expect, test } from 'vitest';
import { sendMessage, LOGOUT_PATH } from './api.js';

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('api client', () => {
  test('posts the message as JSON to /api/chat and returns the reply', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push([url, init]); return response(200, { reply: 'hi!' }); };
    expect(await sendMessage('hello', fetchImpl)).toBe('hi!');
    expect(calls[0][0]).toBe('/api/chat');
    expect(calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(calls[0][1].body)).toEqual({ message: 'hello' });
  });

  test('surfaces server errors with the server message', async () => {
    await expect(sendMessage('x', async () => response(502, { error: 'the assistant is temporarily unavailable' }))).rejects.toThrow(/temporarily unavailable/);
  });

  test('an expired session (redirect to sign-in) asks the user to reload', async () => {
    await expect(sendMessage('x', async () => ({ ok: false, status: 0, type: 'opaqueredirect', json: async () => ({}) }))).rejects.toThrow(/session/);
  });

  test('rejects empty messages without calling the server', async () => {
    let called = false;
    await expect(sendMessage('   ', async () => { called = true; })).rejects.toThrow(/empty/);
    expect(called).toBe(false);
  });

  test('logout goes through the API so ALB cookies are cleared', () => {
    expect(LOGOUT_PATH).toBe('/api/logout');
  });
});
