import { createApiServer, ChatStore, normalizeJid } from '../api.mjs';
import assert from 'node:assert';

async function runTests() {
  console.log('Starting WhatsApp Chat API test suite...');

  // 1. Test JID normalizer
  assert.strictEqual(normalizeJid('+1 (234) 567-890'), '1234567890@s.whatsapp.net');
  assert.strictEqual(normalizeJid('1234567890@s.whatsapp.net'), '1234567890@s.whatsapp.net');
  assert.strictEqual(normalizeJid('120363000@g.us'), '120363000@g.us');
  console.log('✓ JID normalizer tests passed');

  // 2. Test ChatStore
  const store = new ChatStore();
  store.recordMessage({
    id: 'msg_1',
    chatId: '1234567890@s.whatsapp.net',
    senderId: '1234567890@s.whatsapp.net',
    senderName: 'Alice',
    fromMe: false,
    timestamp: 1000,
    type: 'text',
    text: 'Hello from Alice',
  });
  assert.strictEqual(store.getChats().length, 1);
  assert.strictEqual(store.getChats()[0].name, 'Alice');
  assert.strictEqual(store.getChats()[0].unreadCount, 1);
  assert.strictEqual(store.getMessages('1234567890@s.whatsapp.net').length, 1);
  console.log('✓ ChatStore tests passed');

  // 3. Mock Baileys socket
  const sentMessages = [];
  const presenceUpdates = [];
  const readReceipts = [];

  const mockSocket = {
    user: { id: '9876543210:0@s.whatsapp.net' },
    sendMessage: async (jid, content, options) => {
      const id = `mock_msg_${Date.now()}`;
      sentMessages.push({ jid, content, options, id });
      return { key: { id, remoteJid: jid } };
    },
    sendPresenceUpdate: async (action, jid) => {
      presenceUpdates.push({ action, jid });
    },
    readMessages: async (keys) => {
      readReceipts.push(...keys);
    },
  };

  const token = 'test-secret-token-12345';
  const api = createApiServer({
    getSocket: () => mockSocket,
    token,
    store,
    logger: { log: () => {}, error: () => {} },
  });

  const { port } = await api.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  try {
    // 4. Test GET /openapi.json (public)
    const openApiRes = await fetch(`${baseUrl}/openapi.json`);
    assert.strictEqual(openApiRes.status, 200);
    const spec = await openApiRes.json();
    assert.strictEqual(spec.openapi, '3.1.0');
    assert(spec.paths['/messages/send']);
    assert(spec.paths['/messages/reply']);
    assert(spec.paths['/messages/react']);
    console.log('✓ OpenAPI endpoint passed');

    // 5. Test GET /docs (public)
    const docsRes = await fetch(`${baseUrl}/docs`);
    assert.strictEqual(docsRes.status, 200);
    const html = await docsRes.text();
    assert(html.includes('SwaggerUIBundle'));
    console.log('✓ Swagger UI /docs endpoint passed');

    // 6. Test Auth on /health
    const unauthRes = await fetch(`${baseUrl}/health`);
    assert.strictEqual(unauthRes.status, 401);

    const badAuthRes = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.strictEqual(badAuthRes.status, 401);

    const authRes = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(authRes.status, 200);
    const healthData = await authRes.json();
    assert.strictEqual(healthData.status, 'ok');
    assert.strictEqual(healthData.connected, true);
    assert.strictEqual(healthData.phone, '9876543210');
    console.log('✓ Health & Bearer authentication passed');

    // 7. Test GET /chats
    const chatsRes = await fetch(`${baseUrl}/chats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(chatsRes.status, 200);
    const chatsData = await chatsRes.json();
    assert.strictEqual(chatsData.chats.length, 1);
    assert.strictEqual(chatsData.chats[0].id, '1234567890@s.whatsapp.net');
    console.log('✓ GET /chats passed');

    // 8. Test GET /chats/:chatId/messages
    const msgsRes = await fetch(`${baseUrl}/chats/1234567890%40s.whatsapp.net/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(msgsRes.status, 200);
    const msgsData = await msgsRes.json();
    assert.strictEqual(msgsData.messages.length, 1);
    assert.strictEqual(msgsData.messages[0].text, 'Hello from Alice');
    console.log('✓ GET /chats/:chatId/messages passed');

    // 9. Test POST /messages/send
    const badSendRes = await fetch(`${baseUrl}/messages/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: '+1234567890' }), // missing text
    });
    assert.strictEqual(badSendRes.status, 400);

    const sendRes = await fetch(`${baseUrl}/messages/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: '+1234567890', text: 'Hi Alice!' }),
    });
    assert.strictEqual(sendRes.status, 200);
    const sendData = await sendRes.json();
    assert.strictEqual(sendData.status, 'sent');
    assert.strictEqual(sendData.chatId, '1234567890@s.whatsapp.net');
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].content.text, 'Hi Alice!');
    console.log('✓ POST /messages/send passed');

    // 10. Test POST /messages/reply
    const replyRes = await fetch(`${baseUrl}/messages/reply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: '1234567890@s.whatsapp.net',
        text: 'This is a reply to Alice',
        quotedMessageId: 'msg_1',
      }),
    });
    assert.strictEqual(replyRes.status, 200);
    const replyData = await replyRes.json();
    assert.strictEqual(replyData.status, 'sent');
    assert.strictEqual(sentMessages.length, 2);
    assert.strictEqual(sentMessages[1].options.quoted.key.id, 'msg_1');
    console.log('✓ POST /messages/reply passed');

    // 11. Test POST /messages/react
    const reactRes = await fetch(`${baseUrl}/messages/react`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: '1234567890@s.whatsapp.net',
        messageId: 'msg_1',
        emoji: '❤️',
      }),
    });
    assert.strictEqual(reactRes.status, 200);
    const reactData = await reactRes.json();
    assert.strictEqual(reactData.status, 'sent');
    assert.strictEqual(sentMessages.length, 3);
    assert.strictEqual(sentMessages[2].content.react.text, '❤️');
    console.log('✓ POST /messages/react passed');

    // 12. Test POST /chats/:chatId/presence
    const presenceRes = await fetch(`${baseUrl}/chats/1234567890%40s.whatsapp.net/presence`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'composing' }),
    });
    assert.strictEqual(presenceRes.status, 200);
    assert.strictEqual(presenceUpdates.length, 1);
    assert.strictEqual(presenceUpdates[0].action, 'composing');
    console.log('✓ POST /chats/:chatId/presence passed');

    // 13. Test POST /chats/:chatId/read
    const readRes = await fetch(`${baseUrl}/chats/1234567890%40s.whatsapp.net/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: 'msg_1' }),
    });
    assert.strictEqual(readRes.status, 200);
    assert.strictEqual(readReceipts.length, 1);
    assert.strictEqual(store.getChats()[0].unreadCount, 0);
    console.log('✓ POST /chats/:chatId/read passed');

    console.log('\nAll 13 API test scenarios passed successfully!');
  } finally {
    await api.close();
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
